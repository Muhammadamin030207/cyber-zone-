import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../types';
import { io } from '../lib/socket';
import { ok, created, badRequest, forbidden, notFoundMsg } from '../utils/response';
import { toNumber, round2 } from '../utils/money';
import { computeBookingPrice } from '../utils/pricing';
import { Prisma, BookingStatus } from '@prisma/client';
import {
  tashkentTodayISO,
  tashkentNowHHMM,
  parseTime,
  minutesToHHMM,
  normalizeSlot,
  slotsOverlap,
  normalizeWorkingHours,
  slotWithinWorkingHours,
  freeWindowsInDay,
  toISODate,
  type SlotNorm,
} from '../utils/time';
import { expireUnpaidBeforeRead } from '../utils/bookingExpiry';
import { getPromoIdentityIds, isPromoRecipient } from '../utils/promoIdentity';

const ACTIVE_BOOKING_STATUSES = ['PENDING', 'PENDING_PAYMENT', 'PARTIALLY_PAID', 'PAID', 'CONFIRMED', 'ACTIVE'] as BookingStatus[];

type BookingRow = { computerId: string | null; startTime: string; endTime: string; date: Date };

/**
 * Berilgan kun uchun FAOL bronlarni qaytaradi. Tungi (tunga oshgan) bronlar
 * keyingi kunga ham tegishli bo'lgani uchun X kun so'rovida avvalgi kun (X-1)
 * bronlari ham tekshiriladi: agar X-1 dagi bron yarim tundan oshsa
 * (masalan 23:00-01:00), X kungi [00:00, 01:00) oraliq band hisoblanadi.
 *
 * Natija har bir kompyuter uchun normallashtirilgan [start, end) daqiqalari —
 * yarim tundan oshgan qism X kuni [0, end-1440) sifatida beriladi.
 */
async function activeBookingsForDay(
  client: { booking: { findMany: (args: any) => Promise<BookingRow[]> } },
  args: { zoneId: string; computerIds: string[]; date: Date }
): Promise<Map<string, Array<SlotNorm>>> {
  const prevDate = new Date(args.date.getTime() - 86_400_000);
  const rows = await client.booking.findMany({
    where: {
      zoneId: args.zoneId,
      computerId: { in: args.computerIds },
      date: { in: [args.date, prevDate] },
      status: { in: ACTIVE_BOOKING_STATUSES },
    },
    select: { computerId: true, startTime: true, endTime: true, date: true },
  });

  const byComputer = new Map<string, Array<SlotNorm>>();
  for (const b of rows) {
    const slot = normalizeSlot(b.startTime, b.endTime);
    if (!slot || !b.computerId) continue;
    const isPrevDay = b.date.getTime() === prevDate.getTime();
    // Avvalgi kunda boshlanib, yarim tundan oshgan bron — bugungi [00:00, end-1440) ni band qiladi
    if (isPrevDay) {
      if (slot.end > 1440) {
        const list = byComputer.get(b.computerId) ?? [];
        list.push({ start: 0, end: slot.end - 1440 });
        byComputer.set(b.computerId, list);
      }
    } else {
      const list = byComputer.get(b.computerId) ?? [];
      list.push(slot);
      byComputer.set(b.computerId, list);
    }
  }
  return byComputer;
}

const BOOKING_INCLUDE = {
  user: { select: { id: true, fullName: true, phone: true, email: true } },
  room: { select: { id: true, name: true, address: true } },
  zone: { select: { id: true, name: true, type: true, pricePerHour: true } },
  computer: { select: { id: true, name: true, specs: true } },
  promoCode: { select: { id: true, code: true, discountType: true, discountValue: true } },
  payments: true,
};

// ============ YORDAMCHI: bron bekor qilinganda ballarni qaytarish ============
async function refundPoints(tx: Prisma.TransactionClient, booking: { id: string; userId: string; pointsUsed: number }) {
  if (booking.pointsUsed <= 0) return 0;
  const user = await tx.user.update({
    where: { id: booking.userId },
    data: { loyaltyBalance: { increment: booking.pointsUsed } },
    select: { loyaltyBalance: true },
  });
  await tx.loyaltyTransaction.create({
    data: {
      userId: booking.userId,
      type: 'REFUND',
      amount: booking.pointsUsed,
      balanceAfter: user.loyaltyBalance,
      description: `${booking.pointsUsed.toLocaleString('ru-RU')} ball qaytarildi (bron bekor qilindi)`,
      bookingId: booking.id,
    },
  });
  return booking.pointsUsed;
}

// ============ POST /api/bookings — USER: yangi bron (himoya + transaction) ============
export const createBooking = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'USER') {
      return forbidden(res, 'Bron faqat foydalanuvchilar uchun. Admin bron qila olmaydi');
    }

    // Muddati o'tgan to'lanmagan bronlarni tozalash — band joylar qaytariladi
    await expireUnpaidBeforeRead();

    const { roomId, zoneId, computerId, date, startTime, durationHours, notes, promoCode, usePoints, idempotencyKey } = req.body;
    let endTime = req.body.endTime as string | undefined;

    if (!roomId || !zoneId || !date || !startTime) {
      return badRequest(res, 'roomId, zoneId, date, startTime majburiy');
    }

    // Idempotentlik: ikkinchi bosish / refresh / takroriy so'rov bilan bir xil
    // kalit kelsa — yangi bron YARATMAYMIZ, avval yaratilganini qaytaramiz.
    const idemKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 64) : null;
    if (idemKey) {
      const existing = await prisma.booking.findFirst({
        where: { userId: req.user!.userId, idempotencyKey: idemKey },
        include: BOOKING_INCLUDE,
      });
      if (existing) {
        io.emit('booking_status_changed', { roomId: existing.roomId, type: 'new_booking' });
        return created(res, existing, `Bron yaratildi. ${Number(existing.depositPercent) || 30}% oldindan to'lov kerak`);
      }
    }

    const startMin = parseTime(startTime);
    if (startMin === null) return badRequest(res, 'Boshlanish vaqti noto\'g\'ri');

    // Sana (Asia/Tashkent) ni ISO normallashtirish
    const dateInfo = toISODate(date);
    if (!dateInfo) return badRequest(res, 'Sana noto\'g\'ri');
    const { isoDate, date: bookingDate } = dateInfo;

    // Yakuniy vaqt — backend avtoritet: durationHours berilsa endTime undan hisoblanadi
    if (durationHours !== undefined && durationHours !== null && toNumber(durationHours) > 0) {
      const durationMin = Math.round(toNumber(durationHours) * 60);
      if (durationMin <= 0) return badRequest(res, 'Davomiylik noto\'g\'ri', 'INVALID_DURATION');
      const endMin = startMin + durationMin;
      if (endMin > 24 * 60) {
        return badRequest(res, 'Bron 24:00 dan oshib ketyapti', 'INVALID_DURATION');
      }
      endTime = minutesToHHMM(endMin);
    }
    if (!endTime) {
      return badRequest(res, 'endTime yoki durationHours berilishi shart');
    }

    const slot = normalizeSlot(startTime, endTime);
    if (!slot) return badRequest(res, 'Vaqt oralig\'i noto\'g\'ri');

    // O'tgan sana va bugun (Toshkent) uchun o'tgan vaqtlarni bloklash — server avtoritet
    const todayISO = tashkentTodayISO();
    if (isoDate < todayISO) {
      return badRequest(res, 'O\'tgan sanaga bron qilib bo\'lmaydi', 'BOOKING_IN_PAST');
    }
    if (isoDate === todayISO) {
      const nowMin = parseTime(tashkentNowHHMM());
      if (nowMin !== null && slot.start < nowMin) {
        return badRequest(res, 'Boshlanish vaqti allaqachon o\'tib ketgan', 'BOOKING_IN_PAST');
      }
    }

    // Ish vaqti tekshiruvi (tungi smena va 00:00 yopilishni to'g'ri hisoblaydi)
    const room = await prisma.computerRoom.findUnique({ where: { id: roomId } });
    if (!room) return notFoundMsg(res, 'Xona topilmadi');
    if (room.status !== 'ACTIVE') return badRequest(res, 'Xona faol emas');

    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone || zone.roomId !== roomId) return notFoundMsg(res, 'Zona topilmadi');

    const wh = normalizeWorkingHours(room.workingHours as { open?: string; close?: string } | null);
    if (!slotWithinWorkingHours(slot, wh)) {
      return badRequest(res, `Ish vaqti: ${minutesToHHMM(wh.open)} - ${minutesToHHMM(wh.close)}`, 'BOOKING_OUTSIDE_WORKING_HOURS');
    }

    // Promo-kodni tekshirish (agar berilgan bo'lsa)
    let promo = null;
    if (promoCode) {
      promo = await prisma.promoCode.findUnique({ where: { code: String(promoCode).toUpperCase() } });
      if (!promo || !promo.isActive) return badRequest(res, 'Promo-kod topilmadi yoki nofaol');

      const now = new Date();
      if (now < promo.startsAt || now > promo.expiresAt) return badRequest(res, 'Promo-kod muddati tugagan');

      if (promo.maxUses !== null && promo.usageScope !== 'MULTI_USE' && promo.usedCount >= promo.maxUses) {
        return badRequest(res, 'Promo-kod limiti tugagan');
      }
      if (promo.roomId && promo.roomId !== roomId) {
        return badRequest(res, 'Bu promo-kod boshqa xona uchun');
      }
    }

    // Transaktsiya: kompyuter lock + to'qnashuv tekshiruvi + yaratish
    try {
      const booking = await prisma.$transaction(async (tx) => {
        const candidateIds: string[] = [];

        // Promo-kod: per-account limit (usageLimitPerUser, kofiguratsiyalanuvchi 1|2|N)
        // + shaxsiy promo-kod (isPersonal) qabul qiluvchi tekshiruvi.
        if (promo) {
          // Race-safe (TOCTOU): bir xil (promo, shaxs) bo'yicha parallel bronlarni
          // transaktsiya darajasida serialize qilamiz — ikki so'rov bir-birini "ko'rmay"
          // qolib promo'ni qayta ishlata olmaydi.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(concat('cyber-promo:', ${promo.id}, ':', ${req.user!.userId})))`;

          // Identifikatsiya: shu user + AYNAN bir xil tasdiqlangan telefon raqamiga ega
          // boshqa ACTIVE userlar ("twin" akkauntlar). Email users.email UNIQUE.
          const identityIds = await getPromoIdentityIds(tx, req.user!.userId);
          for (const twinId of identityIds) {
            if (twinId === req.user!.userId) continue;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(concat('cyber-promo:', ${promo.id}, ':', ${twinId})))`;
          }

          // SHAXSIY promo-kod faqat qabul qiluvchiga — userId / telefon / email orqali
          if (promo.isPersonal) {
            const me = await tx.user.findUnique({
              where: { id: req.user!.userId },
              select: { phone: true, email: true },
            });
            const isForMe = isPromoRecipient(promo, {
              userId: req.user!.userId,
              phone: me?.phone,
              email: me?.email,
              identityIds,
            });
            if (!isForMe) throw new Error('PERSONAL_PROMO_NOT_FOR_USER');
          }

          // Per-account ishlatish soni: faol (CANCELLED emas) bronlar sanaladi.
          const usedByIdentity = await tx.booking.count({
            where: { userId: { in: identityIds }, promoCodeId: promo.id, status: { not: 'CANCELLED' } },
          });
          if (usedByIdentity >= (promo.usageLimitPerUser ?? 1)) {
            throw new Error(promo.isPersonal ? 'PERSONAL_PROMO_LIMIT_REACHED' : 'PROMO_LIMIT_REACHED');
          }
        }

        if (computerId) {
          // Tanlangan kompyuterni lock qilamiz
          const locked: Array<{ id: string }> = await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`;
          if (locked.length === 0) throw new Error('COMPUTER_NOT_FOUND');

          const comp: any = await tx.computer.findUnique({ where: { id: computerId }, include: { zone: true } });
          if (!comp || comp.zoneId !== zoneId || comp.zone.roomId !== roomId) throw new Error('COMPUTER_MISMATCH');
          if (comp.status !== 'AVAILABLE') throw new Error('COMPUTER_BUSY');
          candidateIds.push(computerId);
        } else {
          // Avtomatik: butun zona kompyuterlarini lock qilamiz (TOCTOU muammosini bartaraf qiladi)
          const locked: Array<{ id: string }> = await tx.$queryRaw`SELECT id FROM computers WHERE zone_id = ${zoneId} FOR UPDATE`;
          if (locked.length === 0) throw new Error('NO_FREE_COMPUTER');
          candidateIds.push(...locked.map((r) => r.id));
        }

        const computers = await tx.computer.findMany({
          where: { id: { in: candidateIds }, zoneId, status: 'AVAILABLE' },
          select: { id: true },
        });
        const availableIds = new Set(computers.map((c) => c.id));

        if (computerId && !availableIds.has(computerId)) {
          const existing = await tx.computer.findUnique({ where: { id: computerId }, select: { zoneId: true } });
          if (!existing || existing.zoneId !== zoneId) throw new Error('COMPUTER_NOT_FOUND');
          throw new Error('COMPUTER_BUSY');
        }

        const dayBookings = await activeBookingsForDay(tx, {
          zoneId,
          computerIds: candidateIds,
          date: bookingDate,
        });

        const bookedByComputer = new Map<string, Array<{ start: number; end: number }>>();
        for (const [compId, slots] of dayBookings) {
          bookedByComputer.set(compId, slots);
        }

        let selectedComputerId: string | null = null;
        let conflictSlot: { start: number; end: number } | null = null;
        for (const id of candidateIds) {
          if (!availableIds.has(id)) continue;
          const conflict = bookedByComputer.get(id)?.find((s) => slotsOverlap(slot, s)) ?? null;
          if (!conflict) {
            selectedComputerId = id;
            break;
          }
          conflictSlot = conflict;
        }

        if (!selectedComputerId) {
          if (computerId && conflictSlot) {
            throw new Error(`CONFLICT_${minutesToHHMM(conflictSlot.start)}_${minutesToHHMM(conflictSlot.end)}`);
          }
          if (computerId) throw new Error('COMPUTER_BUSY');
          throw new Error('NO_FREE_COMPUTER');
        }

        // Narxni hisoblash — barchasi tiyingacha yaxlitlanadi (float xatolik yo'q)
        const duration = toNumber(durationHours) || Math.round(((slot.end - slot.start) / 60) * 100) / 100;

        // Bonus ballarni tekshirish (1 ball = 1 so'm), sarflash transaktsiya ichida
        // Frontend boolean (usePoints) yuboradi — barcha mavjud bal taklif qilinadi,
        // yakuniy summa computeBookingPrice da 50% cap bilan chiqariladi
        let pointsToUse = 0;
        if (usePoints) {
          const u = await tx.user.findUnique({
            where: { id: req.user!.userId },
            select: { loyaltyBalance: true },
          });
          const balance = u?.loyaltyBalance || 0;
          if (balance <= 0) throw new Error('INSUFFICIENT_POINTS');
          pointsToUse = balance;
        }

        const pricing = computeBookingPrice({
          pricePerHour: zone.pricePerHour,
          durationHours: duration,
          promo,
          pointsToUse,
        });

        if (promo && toNumber(promo.minBookingAmount) && pricing.baseTotal < toNumber(promo.minBookingAmount)) {
          throw new Error('MIN_AMOUNT_NOT_REACHED');
        }

        // Ballar bilan to'langan qism aks holda olinmaydi — haqiqiy sarflanganini yozamiz
        pointsToUse = pricing.pointsUsed;

        // Ma'lumotlar to'liq mos kelsin: final = avans + qoldiq (har doim teng)
        const finalTotal = pricing.finalTotal;
        const advance = pricing.advance;
        const remaining = pricing.remaining;

        const newBooking = await tx.booking.create({
          data: {
            userId: req.user!.userId,
            roomId,
            zoneId,
            computerId: selectedComputerId,
            promoCodeId: promo ? promo.id : null,
            idempotencyKey: idemKey,
            date: bookingDate,
            startTime,
            endTime: endTime as string,
            durationHours: duration,
            totalPrice: pricing.baseTotal,
            discountAmount: pricing.discountPromo,
            finalPrice: finalTotal,
            pointsUsed: pointsToUse,
            advanceAmount: advance,
            remainingAmount: remaining,
            status: 'PENDING',
            notes,
          },
          include: BOOKING_INCLUDE,
        });

        // Ballarni hisobdan yechish + tarixga yozish
        if (pointsToUse > 0) {
          const updatedUser = await tx.user.update({
            where: { id: req.user!.userId },
            data: { loyaltyBalance: { decrement: pointsToUse } },
            select: { loyaltyBalance: true },
          });
          await tx.loyaltyTransaction.create({
            data: {
              userId: req.user!.userId,
              type: 'REDEEM',
              amount: -pointsToUse,
              balanceAfter: updatedUser.loyaltyBalance,
              description: `Bron uchun ${pointsToUse.toLocaleString('ru-RU')} ball sarflandi`,
              bookingId: newBooking.id,
            },
          });
        }

        // Promo-kod count +1
        if (promo) {
          await tx.promoCode.update({
            where: { id: promo.id },
            data: { usedCount: { increment: 1 } },
          });
        }

        // PromoRedemption: (promoCodeId, userId) unique — server kodi bitta
        // foydalanuvchiga faqat 1 marta ishlatilishini DB darajasida qayd qiladi.
        if (promo) {
          await tx.promoRedemption.create({
            data: {
              promoCodeId: promo.id,
              userId: req.user!.userId,
              bookingId: newBooking.id,
            },
          });
        }

        return newBooking;
      });

      // Socket — real vaqt yangilanish
      io.emit('booking_status_changed', { roomId, type: 'new_booking' });

      return created(res, booking, `Bron yaratildi. ${Number(booking.depositPercent) || 30}% oldindan to'lov kerak`);
    } catch (txErr: any) {
      const msg = txErr?.message || '';
      // Idempotentlik: raqobatli (concurrent) takroriy so'rov bir xil kalit bilan
      // unique-constraint'ga tushsa — yangi bron yaratilmaydi, avvalgisini qaytaramiz.
      if (txErr?.code === 'P2002' && idemKey) {
        // Raqobatli takroriy so'rov: birinchi tranzaksiya ayni paytda commit bo'layotgan
        // bo'lishi mumkin — bir necha urinishda avval yaratilgan bronni topamiz.
        for (let attempt = 0; attempt < 3; attempt++) {
          const existing = await prisma.booking.findFirst({
            where: { userId: req.user!.userId, idempotencyKey: idemKey },
            include: BOOKING_INCLUDE,
          });
          if (existing) {
            io.emit('booking_status_changed', { roomId: existing.roomId, type: 'new_booking' });
            return created(res, existing, `Bron yaratildi. ${Number(existing.depositPercent) || 30}% oldindan to'lov kerak`);
          }
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
        return badRequest(res, 'Bron yaratish yakunlanmoqda, sahifani yangilab ko\'ring');
      }
      if (msg === 'COMPUTER_NOT_FOUND') return notFoundMsg(res, 'Kompyuter topilmadi');
      if (msg === 'COMPUTER_MISMATCH') return badRequest(res, 'Kompyuter zona/xonaga mos emas');
      if (msg === 'COMPUTER_BUSY') return badRequest(res, 'Bu kompyuter hozirda band');
      if (msg === 'NO_FREE_COMPUTER') return badRequest(res, 'Ushbu vaqt uchun bo\'sh kompyuter yo\'q', 'ROOM_FULL');
      if (msg === 'INSUFFICIENT_POINTS') return badRequest(res, 'Bonus ballaringiz yetarli emas');
      if (msg === 'MIN_AMOUNT_NOT_REACHED') return badRequest(res, 'Bu promo koddan foydalanish uchun minimal to\u2019lov 100 000 so\u2019m.');
      if (msg === 'PROMO_LIMIT_REACHED') return badRequest(res, 'Bu promo-kod uchun ishlatish limiti tugagan');
      if (msg === 'PERSONAL_PROMO_NOT_FOR_USER') return badRequest(res, 'Bu promo-kod shaxsiy va siz uchun emas');
      if (msg === 'PERSONAL_PROMO_LIMIT_REACHED') return badRequest(res, 'Shaxsiy promo-kodingiz ishlatish limiti tugagan');
      if (msg.startsWith('CONFLICT_')) {
        const [, s, e] = msg.split('_');
        return badRequest(res, `Bu kompyuter ${s} - ${e} vaqtda band`, 'BOOKING_TIME_ALREADY_RESERVED');
      }
      throw txErr;
    }
  } catch (err) {
    next(err);
  }
};

// ============ GET /api/bookings — USER: o'z bronlari ============
export const getMyBookings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { userId: req.user!.userId },
      include: BOOKING_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return ok(res, bookings);
  } catch (err) {
    next(err);
  }
};

// ============ GET /api/bookings/:id — USER: bitta bron ============
export const getBookingById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: BOOKING_INCLUDE,
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (booking.userId !== req.user!.userId) return forbidden(res, 'Bu bron sizniki emas');
    return ok(res, booking);
  } catch (err) {
    next(err);
  }
};

// ============ PUT /api/bookings/:id/cancel — USER: bronni bekor qilish ============
export const cancelBooking = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (booking.userId !== req.user!.userId) return forbidden(res, 'Bu bron sizniki emas');

    // Foydalanuvchi faqat to'lanmagan bronni bekor qila oladi.
    // To'langan (30% prepaid) bronni bekor qilish faqat admin panel orqali (refund yo'q).
    if (!['PENDING', 'PENDING_PAYMENT'].includes(booking.status)) {
      return badRequest(res, 'To\'langan bronni bekor qilib bo\'lmaydi. Admin bilan bog\'laning.', 'BOOKING_PAID_CANNOT_CANCEL');
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'CANCELLED' },
    });

    // To'lovlar bor bo'lsa — qaytariladi (REFUNDED sifatida saqlanadi)
    await prisma.payment.updateMany({
      where: { bookingId: booking.id, status: 'COMPLETED' },
      data: { status: 'REFUNDED' },
    });

    // Bron yaratishda sarflangan bonus ballar qaytariladi
    await prisma.$transaction(async (tx) => refundPoints(tx, booking));

    // Promo-kod count'ni qaytarish + redemption qatorini o'chirish
    // (kod qayta ishlatilishi mumkin — e2e kontrakti)
    if (booking.promoCodeId) {
      await prisma.promoRedemption.deleteMany({ where: { bookingId: booking.id } });
      await prisma.promoCode.update({
        where: { id: booking.promoCodeId },
        data: { usedCount: { decrement: 1 } },
      });
    }

    // Socket — real vaqt
    io.emit('booking_status_changed', { roomId: booking.roomId, type: 'cancelled' });

    return ok(res, updated, 'Bron bekor qilindi');
  } catch (err) {
    next(err);
  }
};

// ============ SESSIYA (check-in / check-out) — §2.5 ============
// Bron ACTIVE bo'lganda real foydalanish o'lchanadi:
//   check-in  → sessionStartedAt = server now, kompyuter OCCUPIED
//   check-out → haqiqiy vaqt; min 1 soat (minBillingMinutes) hisobga olinadi;
//               ortiq to'langan vaqt bonus ballga QAYTARILADI, kam bo'lsa
//               qo'shimcha qoldiq to'lov (PENDING CASH) qayd qilinadi.

const SESSION_PAID_STATUSES = ['PAID', 'COMPLETED'] as const;
const SESSION_STARTABLE = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] as BookingStatus[];

/** booking.date + HH:mm (Asia/Tashkent, UTC+5) -> mutlaq vaqt. "00:00" keyingi kun. */
function localInstant(date: Date, minutes: number): Date {
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth();
  const d = date.getUTCDate() + (minutes === 0 ? 1 : 0);
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  return new Date(Date.UTC(y, mo, d, h - 5, mi));
}

function canManageBooking(booking: { userId: string; room: { ownerId: string } | null }, user: { userId: string; role: string }): boolean {
  if (booking.userId === user.userId) return true;
  if (user.role === 'SUPER_ADMIN') return true;
  if (user.role === 'ADMIN' && booking.room?.ownerId === user.userId) return true;
  return false;
}

async function sessionState(now: Date, booking: any) {
  const startMinutes = parseTime(booking.startTime) ?? 0;
  const endMinutes = parseTime(booking.endTime) ?? startMinutes + 60;
  const bookedStart = localInstant(booking.date, startMinutes);
  const bookedEnd = localInstant(booking.date, endMinutes);

  const zonePrice = booking.zone?.pricePerHour;
  const minBill = booking.minBillingMinutes ?? 60;
  let elapsedMinutes = 0;
  let billedMinutes = 0;
  let remainingMs = bookedEnd.getTime() - now.getTime();

  if (booking.sessionStartedAt) {
    elapsedMinutes = Math.max(1, Math.ceil((now.getTime() - booking.sessionStartedAt.getTime()) / 60000));
    billedMinutes = Math.max(minBill, elapsedMinutes);
  }

  const actualPrice = booking.sessionStartedAt && zonePrice
    ? round2(toNumber(zonePrice) * (billedMinutes / 60))
    : null;

  const paidPayments = (booking.payments || []).filter((p: any) =>
    (SESSION_PAID_STATUSES as readonly string[]).includes(p.status)
  );
  const totalPaid = round2(paidPayments.reduce((s: number, p: any) => s + round2(toNumber(p.amount)), 0));
  const prepaidValue = round2(totalPaid + toNumber(booking.pointsUsed || 0));

  return {
    state: booking.status === 'ACTIVE' && booking.sessionStartedAt
      ? 'active'
      : booking.sessionEndedAt ? 'ended' : 'idle',
    serverTime: now.toISOString(),
    bookedStart: bookedStart.toISOString(),
    bookedEnd: bookedEnd.toISOString(),
    elapsedMinutes,
    billedMinutes,
    remainingMs,
    overdueMs: remainingMs < 0 ? -remainingMs : 0,
    actualPrice,
    prepaidValue,
    totalPaid,
    pointsUsed: Number(booking.pointsUsed || 0),
  };
}

// ============ POST /api/bookings/:id/session/start — check-in ============
export const startBookingSession = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { room: { select: { id: true, ownerId: true } }, zone: true, computer: true, user: { select: { id: true, fullName: true, phone: true, email: true } }, payments: true },
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (!canManageBooking(booking, req.user!)) return forbidden(res, 'Bu bron sizniki emas');

    const now = new Date();

    // Idempotent: allaqachon boshlangan sessiya — holatni qaytaramiz
    if (booking.status === 'ACTIVE' && booking.sessionStartedAt) {
      const state = await sessionState(now, booking);
      return ok(res, { booking, session: state }, 'Sessiya allaqachon boshlangan');
    }
    if (booking.sessionEndedAt || booking.status === 'COMPLETED') {
      return badRequest(res, 'Sessiya allaqachon yakunlangan');
    }
    if ((SESSION_STARTABLE as string[]).includes(booking.status) === false) {
      return badRequest(res, 'Sessiyani boshlash uchun bron to\'langan bo\'lishi kerak (depozit).', 'BOOKING_NOT_PAID');
    }

    // Server avtoritet: bron vaqtidan OLDIN check-in mumkin emas (oldingi bron band).
    const startMinutes = parseTime(booking.startTime) ?? 0;
    const bookedStart = localInstant(booking.date, startMinutes);
    if (now.getTime() < bookedStart.getTime()) {
      return badRequest(res, 'Sessiyani bron vaqtidan oldin boshlab bo\'lmaydi', 'SESSION_EARLY');
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'ACTIVE', sessionStartedAt: now },
      include: BOOKING_INCLUDE,
    });

    if (updated.computerId) {
      await prisma.computer.update({
        where: { id: updated.computerId },
        data: { status: 'OCCUPIED' },
      });
    }

    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'ACTIVE' });
    const state = await sessionState(now, { ...booking, ...updated });
    return ok(res, { booking: updated, session: state }, 'Sessiya boshlandi');
  } catch (err) {
    next(err);
  }
};

// ============ POST /api/bookings/:id/session/end — check-out (haqiqiy hisob) ============
export const endBookingSession = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { room: { select: { id: true, ownerId: true } }, zone: true, computer: true, user: { select: { id: true, fullName: true, phone: true, email: true } }, payments: true },
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (!canManageBooking(booking, req.user!)) return forbidden(res, 'Bu bron sizniki emas');

    if (booking.sessionEndedAt) {
      return ok(res, { booking }, 'Sessiya allaqachon yakunlangan');
    }
    if (booking.status !== 'ACTIVE' || !booking.sessionStartedAt) {
      return badRequest(res, 'Faol sessiya topilmadi — avval sessiyani boshlang', 'SESSION_NOT_STARTED');
    }

    const now = new Date();
    const minBill = booking.minBillingMinutes ?? 60;
    const elapsedMinutes = Math.max(1, Math.ceil((now.getTime() - booking.sessionStartedAt.getTime()) / 60000));
    const billedMinutes = Math.max(minBill, elapsedMinutes);
    const actualPrice = round2(toNumber(booking.zone.pricePerHour) * (billedMinutes / 60));

    const paidPayments = (booking.payments || []).filter((p: any) =>
      (SESSION_PAID_STATUSES as readonly string[]).includes(p.status)
    );
    const totalPaid = round2(paidPayments.reduce((s: number, p: any) => s + round2(toNumber(p.amount)), 0));
    const prepaidValue = round2(totalPaid + toNumber(booking.pointsUsed || 0));

    // Sessiya rasmiy yakunlanishi + kompyuter bo'shatish
    let billingAdjustment = round2(actualPrice - prepaidValue);
    let refundPoints = 0;
    let extraDue = 0;

    if (billingAdjustment > 0) {
      // Foydalanuvchi to'laganidan ko'p o'tirdi — qo'shimcha qoldiq to'lov.
      // Hech qanday soxta "paid" belgilanmaydi: PENDING CASH qayd etiladi va
      // admin kassada qabul qilganda mavjud oqim orqali COMPLETED bo'ladi.
      extraDue = billingAdjustment;
      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          userId: booking.userId,
          amount: extraDue,
          type: 'REMAINING',
          method: 'CASH',
          status: 'PENDING',
          depositPercent: 0,
          metadata: { source: 'session_actual_usage', sessionMinutes: billedMinutes },
        },
      });
    } else if (billingAdjustment < 0) {
      // Kam o'tirdi — qaytariladigan summa bonus ballga (1 ball = 1 so'm).
      refundPoints = Math.floor(-billingAdjustment);
      if (refundPoints > 0) {
        const user = await prisma.user.update({
          where: { id: booking.userId },
          data: { loyaltyBalance: { increment: refundPoints } },
          select: { loyaltyBalance: true },
        });
        await prisma.loyaltyTransaction.create({
          data: {
            userId: booking.userId,
            type: 'REFUND',
            amount: refundPoints,
            balanceAfter: user.loyaltyBalance,
            description: `Sessiya qisqaroq bo'lgani uchun ${refundPoints.toLocaleString('ru-RU')} ball qaytarildi (haqiqiy o'yin ${elapsedMinutes} daq.)`,
            bookingId: booking.id,
          },
        });
      }
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: 'COMPLETED',
        sessionEndedAt: now,
        actualDurationMinutes: billedMinutes,
        actualPrice: actualPrice,
        billingAdjustment: billingAdjustment,
      },
      include: BOOKING_INCLUDE,
    });

    if (updated.computerId) {
      await prisma.computer.update({
        where: { id: updated.computerId },
        data: { status: 'AVAILABLE' },
      });
    }

    // Sodiqlik dasturi: chegara oshganda shaxsiy promo-kod avtomatik beriladi
    try {
      const { maybeGrantLoyaltyPromo } = await import('../services/loyaltyPromo');
      await maybeGrantLoyaltyPromo(prisma, booking.userId);
    } catch { /* sodiqlik promo-kod berilmasa sessiya baribir yakunlanadi */ }

    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'COMPLETED' });

    return ok(res, {
      booking: updated,
      session: {
        serverTime: now.toISOString(),
        elapsedMinutes,
        billedMinutes,
        actualPrice,
        prepaidValue,
        refundPoints,
        extraDue,
        billingAdjustment,
      },
    }, 'Sessiya yakunlandi');
  } catch (err) {
    next(err);
  }
};

// ============ GET /api/bookings/:id/session — jonli sessiya holati ============
export const getSessionInfo = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { room: { select: { id: true, ownerId: true } }, zone: true, computer: true, payments: true },
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (!canManageBooking(booking, req.user!)) return forbidden(res, 'Bu bron sizniki emas');

    const state = await sessionState(new Date(), booking);
    return ok(res, { booking, session: state });
  } catch (err) {
    next(err);
  }
};

// ============ GET /api/admin/bookings — ADMIN: xona bronlari ============
export const getRoomBookings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { date, status, limit, offset } = req.query as { date?: string; status?: string; limit?: string; offset?: string };

    const isSuperAdmin = req.user!.role === 'SUPER_ADMIN';
    const room = await prisma.computerRoom.findUnique({ where: { ownerId: req.user!.userId } });

    // ADMIN hali xona yaratmagan bo'lsa — bu xato emas, shunchaki bron yo'q.
    // 400 qaytarish UI'ni "server xatosi" holatiga tushirib qo'yardi.
    if (!room && !isSuperAdmin) {
      return ok(res, { bookings: [], total: 0 });
    }

    const where: any = {};
    if (!isSuperAdmin) where.roomId = room!.id;
    if (date) {
      const di = toISODate(date);
      if (di) where.date = di.date;
    }
    if (status) where.status = status.toUpperCase();

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: BOOKING_INCLUDE,
        orderBy: { date: 'desc' },
        take: Number(limit) || 100,
        skip: Number(offset) || 0,
      }),
      prisma.booking.count({ where }),
    ]);

    return ok(res, { bookings, total });
  } catch (err) {
    next(err);
  }
};

// ============ PATCH /api/admin/bookings/:id/status — ADMIN: tasdiqlash/rad etish ============
export const updateBookingStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'ACTIVE', 'PARTIALLY_PAID', 'PAID'];
    if (!status || !allowedStatuses.includes(status.toUpperCase())) {
      return badRequest(res, `Status: ${allowedStatuses.join(', ')} bo\'lishi kerak`);
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { room: true },
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');

    if (booking.room.ownerId !== req.user!.userId && req.user!.role !== 'SUPER_ADMIN') {
      return forbidden(res, 'Faqat o\'z xonangiz bronlarini boshqarasiz');
    }

    const newStatus = status.toUpperCase();

    // Admin to'lov-secured statusga o'tkazganda: kassada qabul qilingan PENDING CASH
    // to'lovlar ham COMPLETED bo'ladi — pul to'g'ri saqlansin
    if (['CONFIRMED', 'PARTIALLY_PAID', 'PAID'].includes(newStatus)) {
      const pendingCash = await prisma.payment.findMany({
        where: { bookingId: booking.id, status: 'PENDING', method: 'CASH' },
        select: { id: true },
      });
      if (pendingCash.length) {
        await prisma.payment.updateMany({
          where: { id: { in: pendingCash.map((p) => p.id) } },
          data: { status: 'COMPLETED', paidAt: new Date() },
        });
      }
    }

    // Charz bekor qilinsa: kompyuterni bo'shatamiz va to'lovlarni qaytaramiz
    if (newStatus === 'CANCELLED') {
      if (booking.computerId) {
        await prisma.computer.update({
          where: { id: booking.computerId },
          data: { status: 'AVAILABLE' },
        });
      }
      await prisma.payment.updateMany({
        where: { bookingId: booking.id, status: 'COMPLETED' },
        data: { status: 'REFUNDED' },
      });
      // Sarflangan bonus ballar ham qaytariladi
      await prisma.$transaction(async (tx) => refundPoints(tx, booking));
      // Promo-kod count'ni qaytarish + redemption qatorini o'chirish
      if (booking.promoCodeId) {
        await prisma.promoRedemption.deleteMany({ where: { bookingId: booking.id } });
        await prisma.promoCode.update({
          where: { id: booking.promoCodeId },
          data: { usedCount: { decrement: 1 } },
        });
      }
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: newStatus },
      include: BOOKING_INCLUDE,
    });

    // Socket — real vaqt
    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: newStatus });

    return ok(res, updated, `Bron: ${newStatus}`);
  } catch (err) {
    next(err);
  }
};

// ============ GET /api/rooms/:roomId/availability — PUBLIC: bo'sh kompyuterlar vaqti ============
export const getAvailability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Muddati o'tgan to'lanmagan bronlarni tozalash (band joylar qaytariladi)
    await expireUnpaidBeforeRead();

    const { date } = req.query as { date?: string };
    const refDate = date ? String(date).slice(0, 10) : tashkentTodayISO();
    const availabilityDate = new Date(`${refDate}T00:00:00.000Z`);
    if (isNaN(availabilityDate.getTime())) return badRequest(res, 'Sana noto\'g\'ri');

    const room = await prisma.computerRoom.findUnique({
      where: { id: req.params.roomId },
      include: { zones: { include: { computers: true } } },
    });
    if (!room) return notFoundMsg(res, 'Xona topilmadi');

    const wh = normalizeWorkingHours(room.workingHours as { open?: string; close?: string } | null);

    // Har bir zona uchun: jami kompyuterlar, band bo'lganlari, bo'shlari va band vaqtlar
    const zones = [];
    for (const zone of room.zones) {
      // Avvalgi kun tungi bronlarini ham hisobga oladi (00:00 bandligi to'g'ri chiqadi)
      const bookedByComputer = await activeBookingsForDay(prisma, {
        zoneId: zone.id,
        computerIds: zone.computers.map((c) => c.id),
        date: availabilityDate,
      });

      // Har bir kompyuter uchun band vaqtlar (normallashtirilgan)
      const slotsByComputer = bookedByComputer;

      // Kunning bo'sh oynalari — kompyuter biror bo'sh oynaga ega bo'lsa tanlanadigan
      const allComputers = zone.computers.map((c) => {
        const blocked = slotsByComputer.get(c.id) ?? [];
        const freeWindows = freeWindowsInDay(blocked, wh.open, wh.close);
        return {
          id: c.id,
          name: c.name,
          specs: c.specs,
          status: c.status,
          canBook: c.status === 'AVAILABLE' && freeWindows.length > 0,
          bookedSlots: blocked.map((s) => ({ start: minutesToHHMM(s.start), end: minutesToHHMM(s.end) })),
          freeWindows: freeWindows.map((s) => ({ start: minutesToHHMM(s.start), end: minutesToHHMM(s.end) })),
        };
      });

      const availableComputers = allComputers.filter((c) => c.canBook);

      zones.push({
        id: zone.id,
        name: zone.name,
        type: zone.type,
        pricePerHour: zone.pricePerHour,
        totalComputers: zone.computers.length,
        bookedComputers: zone.computers.length - availableComputers.length,
        availableComputers: availableComputers.length,
        computers: availableComputers.map((c) => ({ id: c.id, name: c.name, specs: c.specs })),
        allComputers,
      });
    }

    return ok(res, { date: refDate, timezone: 'Asia/Tashkent', zones });
  } catch (err) {
    next(err);
  }
};