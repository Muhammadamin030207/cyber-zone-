import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../types';
import { io } from '../lib/socket';
import { ok, created, badRequest, forbidden, notFoundMsg } from '../utils/response';
import { toNumber, round2 } from '../utils/money';
import { computeBookingPrice } from '../utils/pricing';
import { config } from '../config';
import { cacheGet, cacheSet, cacheDel } from '../lib/redis';
import {
  finalizeSession,
  startSessionGate,
  slotInstants,
  computeSessionCharge,
  PAID_STATUSES,
} from '../services/sessionService';
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
      // To'lov kutilayotgan bron faqat o'z "band qilish" muddati (holdExpiresAt)
      // ichida joyni ushlab turadi — muddati o'tgani worker hali tozalagan
      // bo'lsa ham, availability uchun darhol bo'sh hisoblanadi.
      OR: [
        { status: { notIn: ['PENDING', 'PENDING_PAYMENT'] } },
        { holdExpiresAt: null },
        { holdExpiresAt: { gt: new Date() } },
      ],
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
  room: { select: { id: true, name: true, address: true, ownerId: true } },
  zone: { select: { id: true, name: true, type: true, pricePerHour: true } },
  computer: { select: { id: true, name: true, specs: true } },
  promoCode: { select: { id: true, code: true, discountType: true, discountValue: true } },
  approvedBy: { select: { id: true, fullName: true } },
  rejectedBy: { select: { id: true, fullName: true } },
  evidences: { orderBy: { createdAt: 'desc' as const } },
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

    // Eskirgan to'lanmagan bronlarni tozalash ARTIQ shu so'rovda emas —
    // u 30 soniyalik worker'da bajariladi (1000+ foydalanuvchida har bir
    // so'rovda butun jadvalni skanerlash serverni bo'g'ardi). Band muddati
    // o'tgan bronlar availability'da allaqachon bo'sh hisoblanadi
    // (activeBookingsForDay: holdExpiresAt).

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

    // ============ VIP: faqat 1 soatlik bron (server avtoriteti) ============
    // VIP zonada bir bron 1 soatdan oshmasligi kerak. Frontend cheklasa ham,
    // bu yerda qayta tekshiriladi — "soat bo'yicha" to'lov shu mantiqaga asoslanadi.
    if (zone.type === 'VIP') {
      const maxMinutes = config.vip.maxBookingMinutes;
      if (slot.end - slot.start > maxMinutes) {
        return badRequest(
          res,
          `VIP zona uchun maksimal bron davomiyligi ${Math.round(maxMinutes / 60)} soat. Ko'proq vaqt uchun qo'shimcha bron yaratishingiz kerak.`,
          'VIP_MAX_DURATION',
        );
      }
    }

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
            // Depozit foizi bronga YOZILADI — keyingi to'lov talablari va
            // "qancha to'lash kerak" hisobi aynan shu qiymatdan kelib chiqadi.
            // (Frontend yuborgan foizga ishonilmaydi.)
            depositPercent: pricing.depositPercent,
            status: 'PENDING',
            notes,
            // Bron vaqt oralig'ini faqat shu muddatga ushlab turadi (soat).
            // Muddati o'tsa — worker bekor qiladi va kompyuter bo'shatiladi.
            holdExpiresAt: new Date(Date.now() + config.bookings.unpaidTtlMinutes * 60_000),
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
      void cacheDel(`avail:${roomId}:*`);

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
    void cacheDel(`avail:${booking.roomId}:*`);

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

// Barcha moliyaviy hisoblar PAID_STATUSES (sessionService) va
// startSessionGate (bitta manba) orqali hisoblanadi — controller ichida
// ikkinchi nusxa (eskirgan formulalar) saqlanmaydi.
const SESSION_STARTABLE = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] as BookingStatus[];

function canManageBooking(booking: { userId: string; room: { ownerId: string } | null }, user: { userId: string; role: string }): boolean {
  if (booking.userId === user.userId) return true;
  if (user.role === 'SUPER_ADMIN') return true;
  if (user.role === 'ADMIN' && booking.room?.ownerId === user.userId) return true;
  return false;
}

/** Jonli sessiya holati — frontend shundan timer va "Boshlash" tugmasini boshqaradi. */
async function sessionState(now: Date, booking: any) {
  const gate = startSessionGate(booking, now);
  const startMinutes = parseTime(booking.startTime) ?? 0;
  const endMinutes = parseTime(booking.endTime) ?? startMinutes + 60;
  const bookedStart = gate.bookedStart ?? localInstant(booking.date, startMinutes);
  const bookedEnd = gate.bookedEnd ?? localInstant(booking.date, endMinutes);
  const sessionEndsAt = booking.sessionEndsAt ?? bookedEnd;

  const zonePrice = booking.zone?.pricePerHour;
  const minBill = booking.minBillingMinutes ?? 60;
  let elapsedMinutes = 0;
  let billedHours = 0;
  let actualPrice: number | null = null;

  if (booking.sessionStartedAt) {
    const charge = computeSessionCharge({
      sessionStartedAt: booking.sessionStartedAt,
      now,
      pricePerHour: zonePrice ?? 0,
      minBillingMinutes: minBill,
      totalPaid: 0,
      pointsUsed: booking.pointsUsed,
    });
    elapsedMinutes = charge.elapsedMinutes;
    billedHours = charge.billedHours;
    actualPrice = charge.actualPrice;
  }

  const paidPayments = (booking.payments || []).filter((p: any) =>
    (PAID_STATUSES as readonly string[]).includes(p.status)
  );
  const totalPaid = round2(paidPayments.reduce((s: number, p: any) => s + round2(toNumber(p.amount)), 0));
  const prepaidValue = round2(totalPaid + toNumber(booking.pointsUsed || 0));
  const remainingMs = sessionEndsAt.getTime() - now.getTime();

  return {
    state: booking.status === 'ACTIVE' && booking.sessionStartedAt ? 'active' : booking.sessionEndedAt ? 'ended' : 'idle',
    serverTime: now.toISOString(),
    bookedStart: bookedStart.toISOString(),
    bookedEnd: bookedEnd.toISOString(),
    sessionEndsAt: sessionEndsAt.toISOString(),
    autoCloseInMs: booking.status === 'ACTIVE' ? Math.max(0, remainingMs) : 0,
    approvalStatus: booking.approvalStatus,
    approvedAt: booking.approvedAt,
    rejectionReason: booking.rejectionReason ?? null,
    canStart: gate.ok,
    startBlockedBy: gate.ok ? null : gate.code ?? null,
    startBlockedMessage: gate.ok ? null : gate.message ?? null,
    elapsedMinutes,
    billedHours,
    remainingMs,
    overdueMs: remainingMs < 0 ? -remainingMs : 0,
    actualPrice,
    prepaidValue,
    totalPaid,
    pointsUsed: Number(booking.pointsUsed || 0),
  };
}

/** booking.date + HH:mm -> mutlaq vaqt (Toshkent UTC+5) — tunga o'tishni to'g'ri hisoblaydi. */
function localInstant(date: Date, minutes: number): Date {
  const tashkentMidnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 5 * 3_600_000;
  return new Date(tashkentMidnightUtc + minutes * 60_000);
}

// ============ POST /api/bookings/:id/session/start — check-in ============
// "Boshlash" faqat: (1) to'lov qoplangan, (2) ADMIN TASDIQLAGAN,
// (3) bron vaqti boshlanib bo'lmagan va (4) vaqt tugamagan bo'lsa.
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

    const gate = startSessionGate(booking, now);
    if (!gate.ok) {
      const status = gate.code === 'SESSION_ALREADY_ENDED' ? 400 : gate.code === 'BOOKING_NOT_APPROVED' ? 409 : 400;
      return res.status(status).json({ success: false, message: gate.message, code: gate.code });
    }

    // Taymer chegarasini yozib qo'yamiz — worker shu vaqtda sessiyani
    // O'Z-O'ZICHIGA yopadi va kompyuterni bo'shatadi.
    const sessionEndsAt = gate.bookedEnd;

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: SESSION_STARTABLE }, sessionStartedAt: null, sessionEndedAt: null },
        data: { status: 'ACTIVE', sessionStartedAt: now, sessionEndsAt, autoClosed: false },
      });
      if (claimed.count === 0) throw new Error('SESSION_RACE');
      if (booking.computerId) {
        await tx.computer.updateMany({ where: { id: booking.computerId }, data: { status: 'OCCUPIED' } });
      }
      return tx.booking.findUnique({ where: { id: booking.id }, include: BOOKING_INCLUDE });
    });

    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'ACTIVE' });
    io.to(`user:${booking.userId}`).emit('session_started', { bookingId: booking.id, sessionEndsAt: sessionEndsAt.toISOString() });
    void cacheDel(`avail:${booking.roomId}:*`);

    const state = await sessionState(now, { ...booking, ...updated });
    return ok(res, { booking: updated, session: state }, 'Sessiya boshlandi');
  } catch (err) {
    if ((err as Error)?.message === 'SESSION_RACE') {
      return badRequest(res, 'Sessiya allaqachon boshlanib bo\'lgan', 'SESSION_ALREADY_STARTED');
    }
    next(err);
  }
};

// ============ POST /api/bookings/:id/session/end — check-out (haqiqiy hisob) ============
// HTTP va worker BIR xil `finalizeSession` funksiyasini chaqiradi: soatlik
// hisob, qarz yoki ball qaytarish, kompyuterni bo'shatish — atomik va
// idempotent (parallel bosishda hech qanday chalg'ilik bo'lmaydi).
export const endBookingSession = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { room: { select: { id: true, ownerId: true } }, zone: true, computer: true, user: { select: { id: true, fullName: true, phone: true, email: true } }, payments: true },
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (!canManageBooking(booking, req.user!)) return forbidden(res, 'Bu bron sizniki emas');

    if (booking.sessionEndedAt) {
      const state = await sessionState(new Date(), booking);
      return ok(res, { booking, session: state }, 'Sessiya allaqachon yakunlangan');
    }
    if (booking.status !== 'ACTIVE' || !booking.sessionStartedAt) {
      return badRequest(res, 'Faol sessiya topilmadi — avval sessiyani boshlang', 'SESSION_NOT_STARTED');
    }

    const now = new Date();
    const result = await prisma.$transaction(
      (tx) => finalizeSession(tx, { bookingId: booking.id, now, auto: false }),
      { timeout: 15_000, maxWait: 5_000 },
    );

    const updated = await prisma.booking.findUnique({ where: { id: booking.id }, include: BOOKING_INCLUDE });

    // Sodiqlik dasturi: chegara oshganda shaxsiy promo-kod avtomatik beriladi
    try {
      const { maybeGrantLoyaltyPromo } = await import('../services/loyaltyPromo');
      await maybeGrantLoyaltyPromo(prisma, booking.userId);
    } catch { /* promo berilmasa sessiya baribir yakunlanadi */ }

    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'COMPLETED' });
    void cacheDel(`avail:${booking.roomId}:*`);

    return ok(res, {
      booking: updated,
      session: {
        serverTime: now.toISOString(),
        alreadyFinalized: result.alreadyFinalized,
        elapsedMinutes: result.elapsedMinutes,
        billedHours: result.billedHours,
        actualPrice: result.actualPrice,
        prepaidValue: result.prepaidValue,
        refundPoints: result.refundPoints,
        extraDue: result.extraDue,
        billingAdjustment: result.billingAdjustment,
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

// ============ ADMIN: bekor qilish (transactional, bir marta) ============
async function adminCancelBooking(bookingId: string, reason: string, actor: AuthRequest['user']) {
  return prisma.$transaction(async (tx) => {
    // Faqat hali yopilmagan bron bekor qilinadi — parallel bekor qilishda
    // ballar/promo ikki marta qaytarilmaydi.
    const claimed = await tx.booking.updateMany({
      where: { id: bookingId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
      data: {
        status: 'CANCELLED',
        approvalStatus: 'REJECTED',
        rejectedAt: new Date(),
        rejectedById: actor?.userId ?? null,
        rejectionReason: reason,
      },
    });
    if (claimed.count === 0) return false;

    if (bookingId) {
      await tx.payment.updateMany({
        where: { bookingId, status: { in: [...PAID_STATUSES] } },
        data: { status: 'REFUNDED' },
      });
    }
    const b = await tx.booking.findUnique({ where: { id: bookingId } });
    if (b?.computerId) {
      await tx.computer.updateMany({ where: { id: b.computerId, status: 'OCCUPIED' }, data: { status: 'AVAILABLE' } });
    }
    if (b) {
      await refundPoints(tx, b);
      if (b.promoCodeId) {
        await tx.promoRedemption.deleteMany({ where: { bookingId } });
        await tx.promoCode.update({ where: { id: b.promoCodeId }, data: { usedCount: { decrement: 1 } } });
      }
      await tx.notification.create({
        data: {
          userId: b.userId,
          title: 'Bron bekor qilindi',
          message: `Broningiz bekor qilindi${reason ? `: ${reason}` : ''}. To'langan summa qaytariladi.`,
          type: 'booking',
        },
      });
    }
    return true;
  });
}

// ============ PATCH /api/bookings/admin/bookings/:id/approval — ADMIN: tasdiqlash ============
// Bu — YAGONA "yo'l": foydalanuvchi "Boshlash"ni faqat shundan keyin bosadi.
// Kim, qachon, nima uchun rad etgan — barchasi bazada saqlanadi.
export const reviewBookingApproval = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const action = String(req.body?.action || '').toLowerCase();
    if (action !== 'approve' && action !== 'reject') {
      return badRequest(res, 'action: approve yoki reject bo\'lishi kerak');
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { room: true, payments: true },
    });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (booking.room.ownerId !== req.user!.userId && req.user!.role !== 'SUPER_ADMIN') {
      return forbidden(res, 'Faqat o\'z xonangiz bronlarini boshqarasiz');
    }
    if (['CANCELLED', 'COMPLETED'].includes(booking.status)) {
      return badRequest(res, 'Bu bron allaqachon yopilgan', 'BOOKING_CLOSED');
    }

    if (action === 'approve') {
      if (!SESSION_STARTABLE.includes(booking.status)) {
        return badRequest(res, 'Avval to\'lovni tasdiqlang (kassa yoki chek bo\'yicha)', 'BOOKING_NOT_PAID');
      }
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: {
          approvalStatus: 'APPROVED',
          approvedAt: new Date(),
          approvedById: req.user!.userId,
          rejectedAt: null,
          rejectedById: null,
          rejectionReason: null,
        },
        include: BOOKING_INCLUDE,
      });
      await prisma.notification.create({
        data: {
          userId: booking.userId,
          title: 'Broningiz tasdiqlandi',
          message: `${booking.startTime} dan ${booking.endTime} gacha rejalashtirilgan sessiyangiz tasdiqlandi. Vaqt bo'lganda "Boshlash" tugmasini bosing.`,
          type: 'booking',
        },
      });
      io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'APPROVED' });
      io.to(`user:${booking.userId}`).emit('booking_approved', { bookingId: booking.id });
      return ok(res, updated, 'Bron tasdiqlandi — foydalanuvchi vaqtida boshlaydi');
    }

    if (!reason) return badRequest(res, 'Rad etish sababi majburiy');
    const done = await adminCancelBooking(booking.id, reason, req.user!);
    if (!done) return badRequest(res, 'Bron allaqachon yopilgan', 'BOOKING_CLOSED');
    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'REJECTED' });
    void cacheDel(`avail:${booking.roomId}:*`);
    return ok(res, { id: booking.id, approvalStatus: 'REJECTED', status: 'CANCELLED', rejectionReason: reason }, 'Bron rad etildi');
  } catch (err) {
    next(err);
  }
};

// ============ PATCH /api/bookings/admin/bookings/:id/status — eski endpoint ============
// Eski UI uchun saqlanadi, lekin endi faqat ikkita xavfsiz o'tishga ruxsat beradi:
//   CONFIRMED -> tasdiqlash (reviewBookingApproval'ga yo'naltiriladi)
//   CANCELLED -> bekor qilish
// ACTIVE/COMPLETED/PAID/PARTIALLY_PAID ga o'tish BLOCKLANADI: bu o'tishlar
// faqat to'lov tasdiqlanganda yoki sessiya yopilganda (worker) bo'ladi.
export const updateBookingStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    const newStatus = String(status || '').toUpperCase();

    if (newStatus === 'CONFIRMED') {
      return reviewBookingApproval({ ...req, body: { action: 'approve' } } as AuthRequest, res, next);
    }

    if (newStatus !== 'CANCELLED') {
      return badRequest(
        res,
        'Bu o\'tish admin panelidan mumkin emas. To\'lovni chek/kassa orqali tasdiqlang, sessiyani esa "Boshlash"/tugash orqali boshqaring.',
        'INVALID_STATUS_TRANSITION',
      );
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { room: true } });
    if (!booking) return notFoundMsg(res, 'Bron topilmadi');
    if (booking.room.ownerId !== req.user!.userId && req.user!.role !== 'SUPER_ADMIN') {
      return forbidden(res, 'Faqat o\'z xonangiz bronlarini boshqarasiz');
    }

    const done = await adminCancelBooking(booking.id, String(req.body?.reason || 'Admin bekor qildi'), req.user!);
    if (!done) return badRequest(res, 'Bron allaqachon yopilgan', 'BOOKING_CLOSED');

    io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'CANCELLED' });
    void cacheDel(`avail:${booking.roomId}:*`);
    return ok(res, { id: booking.id, status: 'CANCELLED' }, 'Bron bekor qilindi');
  } catch (err) {
    next(err);
  }
};

// ============ GET /api/rooms/:roomId/availability — PUBLIC: bo'sh kompyuterlar vaqti ============
export const getAvailability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // PUBLIC endpoint (elon avatar/logo bilan): keshni avval tekshiramiz, DB'ga
    // umuman murojaat qilmaydi. Tozalash — worker vazifasi.
    const { date } = req.query as { date?: string };
    const refDate = date ? String(date).slice(0, 10) : tashkentTodayISO();
    const availabilityDate = new Date(`${refDate}T00:00:00.000Z`);
    if (isNaN(availabilityDate.getTime())) return badRequest(res, 'Sana noto\'g\'ri');

    const ttl = config.bookings.availabilityCacheTtlSec;
    if (ttl > 0) {
      const hit = await cacheGet<any>(`avail:${req.params.roomId}:${refDate}`);
      if (hit) return ok(res, hit);
    }

    const room = await prisma.computerRoom.findUnique({
      where: { id: req.params.roomId },
      include: { zones: { include: { computers: true } } },
    });
    if (!room) return notFoundMsg(res, 'Xona topilmadi');

    const wh = normalizeWorkingHours(room.workingHours as { open?: string; close?: string } | null);

    // Har bir zona uchun: jami kompyuterlar, band bo'lganlari, bo'shlari va band vaqtlar.
    // Barcha zona so'rovlari PARALLEL ketadi (ketma-ket emas) — 1000+
    // foydalanuvchida javob vaqti sezilarli qisqaradi.
    const zonePayloads = await Promise.all(
      room.zones.map(async (zone) => {
        // Avvalgi kun tungi bronlarini ham hisobga oladi (00:00 bandligi to'g'ri chiqadi)
        const bookedByComputer = await activeBookingsForDay(prisma, {
          zoneId: zone.id,
          computerIds: zone.computers.map((c) => c.id),
          date: availabilityDate,
        });

        // Kunning bo'sh oynalari — kompyuter biror bo'sh oynaga ega bo'lsa tanlanadigan
        const allComputers = zone.computers.map((c) => {
          const blocked = bookedByComputer.get(c.id) ?? [];
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

        return {
          id: zone.id,
          name: zone.name,
          type: zone.type,
          pricePerHour: zone.pricePerHour,
          // VIP zona: bu bron uchun maksimal davomiylik (daqiqa) — frontend
          // "1 soat" chegarasini shu yerdan oladi.
          maxBookingMinutes: zone.type === 'VIP' ? config.vip.maxBookingMinutes : 1440,
          totalComputers: zone.computers.length,
          bookedComputers: zone.computers.length - availableComputers.length,
          availableComputers: availableComputers.length,
          computers: availableComputers.map((c) => ({ id: c.id, name: c.name, specs: c.specs })),
          allComputers,
        };
      }),
    );

    const payload = { date: refDate, timezone: 'Asia/Tashkent', zones: zonePayloads };

    // Qisqa muddatli kesh — DB yukini kesadi. Bron yaratilganda/o'zgarganda
    // `avail:{roomId}:*` darhol o'chiriladi, shuning uchun ma'lumot eskirmaydi.
    if (ttl > 0) {
      await cacheSet(`avail:${req.params.roomId}:${refDate}`, payload, ttl);
    }

    return ok(res, payload);
  } catch (err) {
    next(err);
  }
};