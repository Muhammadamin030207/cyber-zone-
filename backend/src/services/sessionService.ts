import { Prisma } from '@prisma/client';
import { config } from '../config';
import { toNumber, round2 } from '../utils/money';
import { parseTime, normalizeSlot, minutesToHHMM } from '../utils/time';

/**
 * SESSIYA MEXANIKASI (check-in / check-out / avtomatik yopish).
 *
 * Bitta manba: HTTP endpoint va davriy worker (bookingWorker) — ikkalari ham
 * shu funksiyalarni chaqiradi, shuning uchun "taymer tugadi" ham, "foydalanuvchi
 * check-out bosdi" ham BIR XIL natija beradi.
 *
 * O'qish oqimi:
 *   1. startSessionGate()  — "Boshlash"ga ruxsat (tasdiqlash + vaqt oynasi)
 *   2. finalizeSession()   — soatlik hisob, qarz, ball qaytarish, kompyuterni
 *                            bo'shatish, bildirishnoma — ATOMIK (bitta tranzaksiya)
 *   3. closeNoShowSessions() — tasdiqlangan lekin boshlanmagan bronlar
 */

export type TxClient = Prisma.TransactionClient;

/** To'lovning "haqiqiy to'langan" holatlari. */
export const PAID_STATUSES = ['PAID', 'COMPLETED'] as const;

export interface SlotInstants {
  start: Date;
  end: Date;
}

/**
 * booking.date + "HH:mm" -> mutlaq vaqt (Asia/Tashkent, UTC+5).
 * Tunga oshgan davr (23:00-01:00) to'g'ri hisoblanadi: end <= start bo'lsa
 * end keyingi kunga o'tadi. "00:00" = kun oxiri (keyingi kun 00:00).
 */
export function slotInstants(date: Date, startTime: string, endTime: string): SlotInstants | null {
  const slot = normalizeSlot(startTime, endTime);
  if (!slot) return null;

  // Sana 00:00 (Toshkent) = UTC kechki 19:00, so'ldan keyin abs daqiqalar
  // qo'shiladi — kun oshishi va tunga o'tish avtomatik to'g'ri hisoblanadi.
  const tashkentMidnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 5 * 3_600_000;
  const at = (absMinutes: number) => new Date(tashkentMidnightUtc + absMinutes * 60_000);

  return { start: at(slot.start), end: at(slot.end) };
}

/** Soatlik hisob: qisman soatlar YUPRORILADI (masalan 61 daqiqa = 2 soat). */
export function hourlyBill(elapsedMinutes: number, minBillingMinutes: number) {
  const hours = Math.max(1, Math.ceil(Math.max(elapsedMinutes, minBillingMinutes) / 60));
  return { hours, minutes: hours * 60 };
}

export interface SessionCharge {
  elapsedMinutes: number;
  billedHours: number;
  billedMinutes: number;
  actualPrice: number;
  prepaidValue: number;
  billingAdjustment: number;
  refundPoints: number;
  extraDue: number;
}

/**
 * Sessiya moliyaviy hisobi. "Soat bo'yicha" — qisman soat yuqoriga
 * yaxlitlanadi. To'langan (naqd+onlayn+ball) summa bilan solishtiriladi:
 *   qoldiq > 0 -> qarz (debt), keyin to'lanadi
 *   qoldiq < 0 -> kam ishlatilgan, bonus ballga qaytariladi
 */
export function computeSessionCharge(args: {
  sessionStartedAt: Date;
  now: Date;
  pricePerHour: any;
  minBillingMinutes?: number | null;
  totalPaid: number;
  pointsUsed?: number | null;
}): SessionCharge {
  const minBill = args.minBillingMinutes ?? 60;
  const elapsedMinutes = Math.max(1, Math.ceil((args.now.getTime() - args.sessionStartedAt.getTime()) / 60000));
  const { hours, minutes } = hourlyBill(elapsedMinutes, minBill);
  const actualPrice = round2(toNumber(args.pricePerHour) * hours);
  const prepaidValue = round2(args.totalPaid + toNumber(args.pointsUsed || 0));
  const billingAdjustment = round2(actualPrice - prepaidValue);

  return {
    elapsedMinutes,
    billedHours: hours,
    billedMinutes: minutes,
    actualPrice,
    prepaidValue,
    billingAdjustment,
    refundPoints: billingAdjustment < 0 ? Math.floor(-billingAdjustment) : 0,
    extraDue: billingAdjustment > 0 ? billingAdjustment : 0,
  };
}

export interface StartGate {
  ok: boolean;
  code?: string;
  message?: string;
  bookedStart: Date;
  bookedEnd: Date;
}

/**
 * "Boshlash"ga ruxyat. Barcha shartlar SERVER tomonda tekshiriladi:
 *   1) to'lov qoplangan (moliyaviy holat)
 *   2) admin tasdiqlagan (approvalStatus = APPROVED)
 *   3) bron vaqti boshlanib bo'lmagan
 *   4) bron vaqti hali tugamagan (tugasa — kompyuter bo'shatiladi)
 */
export function startSessionGate(booking: {
  status: string;
  approvalStatus: string;
  startTime: string;
  endTime: string;
  date: Date;
  sessionStartedAt?: Date | null;
  sessionEndedAt?: Date | null;
}, now: Date): StartGate {
  const instants = slotInstants(booking.date, booking.startTime, booking.endTime);
  const fallbackStart = new Date(booking.date.getTime());
  const fallbackEnd = new Date(booking.date.getTime() + 3600_000);
  const bookedStart = instants?.start ?? fallbackStart;
  const bookedEnd = instants?.end ?? fallbackEnd;

  if (booking.sessionEndedAt || booking.status === 'COMPLETED') {
    return { ok: false, code: 'SESSION_ALREADY_ENDED', message: 'Sessiya allaqachon yakunlangan', bookedStart, bookedEnd };
  }
  if (booking.approvalStatus !== 'APPROVED') {
    return { ok: false, code: 'BOOKING_NOT_APPROVED', message: 'Bron hali tasdiqlanmagan — admin tasdiqlashini kutilmoqda', bookedStart, bookedEnd };
  }
  if (!['PAID', 'PARTIALLY_PAID', 'CONFIRMED'].includes(booking.status)) {
    return { ok: false, code: 'BOOKING_NOT_PAID', message: "Sessiyani boshlash uchun to'lovni amalga oshiring", bookedStart, bookedEnd };
  }
  if (now.getTime() < bookedStart.getTime()) {
    return { ok: false, code: 'SESSION_EARLY', message: `Sessiya ${minutesToHHMM(parseTime(booking.startTime) ?? 0)} dan keyin boshlanadi`, bookedStart, bookedEnd };
  }
  if (now.getTime() >= bookedEnd.getTime()) {
    return { ok: false, code: 'SESSION_WINDOW_CLOSED', message: 'Bron vaqti tugadi — kompyuter bo\'shatildi', bookedStart, bookedEnd };
  }
  return { ok: true, bookedStart, bookedEnd };
}

export interface FinalizeResult {
  alreadyFinalized: boolean;
  extraDue: number;
  refundPoints: number;
  actualPrice: number;
  billedHours: number;
  elapsedMinutes: number;
  billingAdjustment: number;
  prepaidValue: number;
  bookingId: string;
  roomId: string;
  userId: string;
  computerId: string | null;
}

/**
 * Sessiyani YAKUNLASH — atomik va idempotent.
 *
 * Muhim: `sessionEndedAt IS NULL` shartli UPDATE bilan "kim birinchi bo'lsa
 * o'zi" qoidasi qo'llaniladi — parallel check-out, worker va webhook bir vaqtda
 * ishga tushsa ham sessiya faqat BIR marta hisoblanadi va kompyuter faqat bir
 * marta bo'shatiladi.
 */
export async function finalizeSession(
  tx: TxClient,
  args: { bookingId: string; now: Date; auto: boolean; lock?: boolean },
): Promise<FinalizeResult> {
  const now = args.now;

  // Qatorni bloklab (worker SKIP LOCKED bilan oladi) — parallel o'tish oldi olindi
  if (args.lock !== false) {
    await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${args.bookingId} FOR UPDATE`;
  }

  const booking = await tx.booking.findUnique({
    where: { id: args.bookingId },
    include: {
      zone: { select: { pricePerHour: true } },
      room: { select: { id: true, name: true, ownerId: true } },
      computer: { select: { id: true, name: true } },
      payments: { select: { amount: true, status: true } },
    },
  });
  if (!booking) throw new Error('BOOKING_NOT_FOUND');

  const base: FinalizeResult = {
    alreadyFinalized: true,
    extraDue: 0,
    refundPoints: 0,
    actualPrice: 0,
    billedHours: 0,
    elapsedMinutes: 0,
    billingAdjustment: 0,
    prepaidValue: 0,
    bookingId: booking.id,
    roomId: booking.roomId,
    userId: booking.userId,
    computerId: booking.computerId,
  };
  if (booking.sessionEndedAt || booking.status !== 'ACTIVE' || !booking.sessionStartedAt) return base;

  const totalPaid = round2(
    booking.payments
      .filter((p) => (PAID_STATUSES as readonly string[]).includes(p.status))
      .reduce((s, p) => round2(s + round2(toNumber(p.amount))), 0),
  );

  const charge = computeSessionCharge({
    sessionStartedAt: booking.sessionStartedAt,
    now,
    pricePerHour: booking.zone?.pricePerHour ?? 0,
    minBillingMinutes: booking.minBillingMinutes,
    totalPaid,
    pointsUsed: booking.pointsUsed,
  });

  // 1) "Kim birinchi" — davom etayotgani faqat o'sha tranzaksiya hisoblaydi
  const claimed = await tx.booking.updateMany({
    where: { id: booking.id, sessionEndedAt: null, status: 'ACTIVE' },
    data: {
      status: 'COMPLETED',
      sessionEndedAt: now,
      actualDurationMinutes: charge.billedMinutes,
      actualPrice: charge.actualPrice,
      billingAdjustment: charge.billingAdjustment,
      autoClosed: args.auto,
    },
  });
  if (claimed.count === 0) return base;

  // 2) Qarz (sessiya tugagandan keyin to'lanadigan qoldiq)
  if (charge.extraDue > 0) {
    await tx.payment.upsert({
      where: { idempotencyKey: `session-extra:${booking.id}` },
      update: {},
      create: {
        bookingId: booking.id,
        userId: booking.userId,
        amount: charge.extraDue,
        type: 'REMAINING',
        method: 'CASH',
        status: 'PENDING',
        currency: 'UZS',
        depositPercent: 0,
        isDebt: true,
        dueAt: new Date(now.getTime() + config.payments.debtDueDays * 86_400_000),
        idempotencyKey: `session-extra:${booking.id}`,
        metadata: {
          source: 'session_hourly_billing',
          sessionMinutes: charge.billedMinutes,
          billedHours: charge.billedHours,
          auto: args.auto,
        },
      },
    });
  }

  // 3) Kam ishlatilgan — bonus ball qaytarish
  if (charge.refundPoints > 0) {
    const user = await tx.user.update({
      where: { id: booking.userId },
      data: { loyaltyBalance: { increment: charge.refundPoints } },
      select: { loyaltyBalance: true },
    });
    await tx.loyaltyTransaction.create({
      data: {
        userId: booking.userId,
        type: 'REFUND',
        amount: charge.refundPoints,
        balanceAfter: user.loyaltyBalance,
        description: `Sessiya qisqaroq bo'lgani uchun ${charge.refundPoints.toLocaleString('ru-RU')} ball qaytarildi (${charge.billedHours} soat hisoblandi)`,
        bookingId: booking.id,
      },
    });
  }

  // 4) Kompyuterni bo'shatish (faqat shu bron bandlagan bo'lsa)
  if (booking.computerId) {
    await tx.computer.updateMany({
      where: { id: booking.computerId, status: 'OCCUPIED' },
      data: { status: 'AVAILABLE' },
    });
  }

  // 5) Foydalanuvchiga xabar
  const message = charge.extraDue > 0
    ? `Sessiyangiz yakunlandi. ${charge.actualPrice.toLocaleString('ru-RU')} so'm hisoblandi, qoldig'i ${charge.extraDue.toLocaleString('ru-RU')} so'm. Qarzni istalgan paytda to'lashingiz mumkin.`
    : `Sessiyangiz yakunlandi. ${charge.actualPrice.toLocaleString('ru-RU')} so'm hisoblandi${charge.refundPoints > 0 ? `, ${charge.refundPoints.toLocaleString('ru-RU')} ball qaytarildi` : ''}.`;
  await tx.notification.create({
    data: { userId: booking.userId, title: 'Sessiya yakunlandi', message, type: 'session' },
  });

  return {
    alreadyFinalized: false,
    extraDue: charge.extraDue,
    refundPoints: charge.refundPoints,
    actualPrice: charge.actualPrice,
    billedHours: charge.billedHours,
    elapsedMinutes: charge.elapsedMinutes,
    billingAdjustment: charge.billingAdjustment,
    prepaidValue: charge.prepaidValue,
    bookingId: booking.id,
    roomId: booking.roomId,
    userId: booking.userId,
    computerId: booking.computerId,
  };
}

/**
 * Tasdiqlangan lekin boshlanmagan bronlar: vaqt o'tdi -> kompyuter bo'shatiladi.
 * Hech qanday to'lov hisoblanmaydi (slot band bo'lgani uchun avans to'lovi
 * qoladi), lekin mijozga xabar beriladi.
 */
export async function closeNoShowSessions(
  tx: TxClient,
  now: Date,
  opts: { lock?: boolean } = {},
): Promise<number> {
  if (opts.lock === false) {
    const rows: Array<{ id: string }> = await tx.$queryRaw`
      SELECT id FROM bookings
      WHERE status IN ('PAID', 'PARTIALLY_PAID', 'CONFIRMED')
        AND session_started_at IS NULL
        AND approval_status = 'APPROVED'
        AND session_ended_at IS NULL
        AND (date::timestamp + ((split_part(end_time, ':', 1)::int * 60 + split_part(end_time, ':', 2)::int) - 300) * interval '1 minute') < ${now}
      LIMIT 100
    `;
    let closed = 0;
    for (const r of rows) {
      const b = await tx.booking.findUnique({
        where: { id: r.id },
        include: { computer: { select: { id: true } } },
      });
      if (!b || b.sessionEndedAt) continue;
      const instants = slotInstants(b.date, b.startTime, b.endTime);
      const done = await tx.booking.updateMany({
        where: { id: b.id, sessionEndedAt: null, sessionStartedAt: null },
        data: {
          status: 'COMPLETED',
          sessionEndedAt: instants?.end ?? now,
          actualDurationMinutes: 0,
          actualPrice: 0,
          billingAdjustment: 0,
          autoClosed: true,
        },
      });
      if (done.count === 0) continue;
      if (b.computerId) {
        await tx.computer.updateMany({ where: { id: b.computerId, status: 'OCCUPIED' }, data: { status: 'AVAILABLE' } });
      }
      await tx.notification.create({
        data: {
          userId: b.userId,
          title: 'Bron vaqti tugadi',
          message: 'Siz kelib sessiyani boshmadingiz, bron avtomatik yopildi va kompyuter bo\'shatildi.',
          type: 'booking',
        },
      });
      closed += 1;
    }
    return closed;
  }

  const candidates = await tx.booking.findMany({
    where: {
      status: { in: ['PAID', 'PARTIALLY_PAID', 'CONFIRMED'] },
      sessionStartedAt: null,
      approvalStatus: 'APPROVED',
      sessionEndedAt: null,
      date: { lte: new Date(now.getTime() + 86_400_000) },
    },
    select: { id: true, startTime: true, endTime: true, date: true, computerId: true },
    take: 100,
  });

  let closed = 0;
  for (const c of candidates) {
    const instants = slotInstants(c.date, c.startTime, c.endTime);
    if (!instants || instants.end.getTime() >= now.getTime()) continue;
    const done = await tx.booking.updateMany({
      where: { id: c.id, sessionEndedAt: null, sessionStartedAt: null },
      data: {
        status: 'COMPLETED',
        sessionEndedAt: instants.end,
        actualDurationMinutes: 0,
        actualPrice: 0,
        billingAdjustment: 0,
        autoClosed: true,
      },
    });
    if (done.count === 0) continue;
    if (c.computerId) {
      await tx.computer.updateMany({ where: { id: c.computerId, status: 'OCCUPIED' }, data: { status: 'AVAILABLE' } });
    }
    closed += 1;
  }
  return closed;
}
