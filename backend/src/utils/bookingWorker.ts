import prisma from '../lib/prisma';
import { io } from '../lib/socket';
import { config } from '../config';
import { redis, isRedisReady, cacheDel } from '../lib/redis';
import { BookingStatus, PaymentStatus } from '@prisma/client';
import { finalizeSession, closeNoShowSessions, slotInstants } from '../services/sessionService';

/**
 * BRON VA SESSIYA WORKER'I.
 *
 * Uch vazifa (bitta o'tishda):
 *   1) muddati o'tgan to'lanmagan bronlarni bekor qilish (joy bo'shatish),
 *   2) TAYMER TUGAGAN sessiyalarni o'z-o'zidan yopish va kompyuterni bo'shatish,
 *   3) tasdiqlangan lekin boshlanmagan bronlarni vaqti o'tganda yopish.
 *
 * Ko'p instansiyali (1000+ foydalanuvchi) rejim uchun:
 *   - Redis distributed lock — bir vaqtda faqat BIR instance ish qiladi,
 *   - `finalizeSession` idempotent — qo'shimcha himoya.
 * Redis yo'q bo'lsa lock ishlamaydi, lekin funksiyalar baribir xavfsiz
 * (idempotent + `sessionEndedAt IS NULL` shartli UPDATE).
 */

const LOCK_KEY = 'lock:booking-worker';
const LOCK_TTL_SEC = 25;

async function withWorkerLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (isRedisReady()) {
    try {
      const got = await redis.set(LOCK_KEY, process.env.RENDER_INSTANCE_ID || String(process.pid), 'EX', LOCK_TTL_SEC, 'NX');
      if (got !== 'OK') return null;
    } catch {
      /* Redis xatosi — lock'siz davom etamiz (idempotent funksiyalar bilan) */
    }
  }
  try {
    return await fn();
  } finally {
    if (isRedisReady()) {
      try {
        await redis.del(LOCK_KEY);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Taymeri tugagan ACTIVE sessiyalarni yopadi. `session_ends_at` check-in
 * paytida yoziladi (indeks bilan), bo'lmasa jadval vaqti hisoblanadi.
 */
export async function closeExpiredSessions(now = new Date()): Promise<number> {
  const candidates = await prisma.$queryRaw<Array<{ id: string; room_id: string }>>`
    SELECT id, room_id FROM bookings
    WHERE status = 'ACTIVE'::"BookingStatus"
      AND session_ended_at IS NULL
      AND session_started_at IS NOT NULL
      AND COALESCE(
        session_ends_at,
        date::timestamp + ((split_part(end_time, ':', 1)::int * 60 + split_part(end_time, ':', 2)::int) - 300) * interval '1 minute'
      ) < ${now}
    LIMIT 200
  `;
  if (candidates.length === 0) return 0;

  let closed = 0;
  for (const row of candidates) {
    try {
      const result = await prisma.$transaction(
        (tx) => finalizeSession(tx, { bookingId: row.id, now, auto: true }),
        { timeout: 15_000, maxWait: 5_000 },
      );
      if (result.alreadyFinalized) continue;
      closed += 1;
      io.emit('booking_status_changed', { roomId: row.room_id, bookingId: row.id, type: 'COMPLETED', auto: true });
      io.to(`user:${result.userId}`).emit('session_auto_closed', {
        bookingId: result.bookingId,
        actualPrice: result.actualPrice,
        extraDue: result.extraDue,
        refundPoints: result.refundPoints,
        billedHours: result.billedHours,
      });
      void cacheDel(`avail:${row.room_id}:*`);
    } catch (err) {
      console.error(`[booking-worker] Sessiya yopilmadi: ${row.id}`, (err as Error).message);
    }
  }
  if (closed > 0) console.log(`[booking-worker] ${closed} ta sessiya taymeri tugagani uchun avtomatik yopildi`);
  return closed;
}

/**
 * To'lanmagan bronlar uchun "band qilish" muddati: `hold_expires_at` (yoki
 * createdAt + TTL) o'tgan PENDING/PENDING_PAYMENT bronlar bekor qilinadi.
 *
 * Himoyalar:
 *   - OCHIQ ONLAYN TO'LOV (Payme/Click/... hali qaror kutilmoqda, muddati
 *     o'tmagan) bo'lsa — tegilmaydi, foydalanuvchi provayder sahifasida.
 *   - Bonus ballar va promo-kod hisobi QAYTARILADI.
 *   - Faqat BIR tranzaksiyada bekor qilinadi (parallel worker xavfsiz).
 */
export async function releaseExpiredHolds(now = new Date()): Promise<number> {
  const ONLINE_DECISION: PaymentStatus[] = ['CREATED', 'PENDING', 'REDIRECT_REQUIRED', 'PROCESSING'];
  const ttl = config.bookings.unpaidTtlMinutes;

  const stale = await prisma.booking.findMany({
    where: {
      status: { in: ['PENDING', 'PENDING_PAYMENT'] as BookingStatus[] },
      OR: [
        { holdExpiresAt: { lt: now } },
        { holdExpiresAt: null, createdAt: { lt: new Date(now.getTime() - ttl * 60_000) } },
      ],
      // Hali yaroqli onlayn to'lov jarayoni bor bronlarga tegilmaydi
      payments: {
        none: {
          method: { not: 'CASH' },
          status: { in: ONLINE_DECISION },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      },
    },
    select: {
      id: true, roomId: true, userId: true, computerId: true,
      pointsUsed: true, promoCodeId: true,
    },
    take: 200,
  });

  let released = 0;
  for (const b of stale) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        const upd = await tx.booking.updateMany({
          where: { id: b.id, status: { in: ['PENDING', 'PENDING_PAYMENT'] as BookingStatus[] } },
          data: {
            status: 'CANCELLED',
            approvalStatus: 'REJECTED',
            rejectedAt: now,
            rejectionReason: 'To\'lov muddati tugadi',
          },
        });
        if (upd.count === 0) return false;

        await tx.payment.updateMany({
          where: { bookingId: b.id, status: { notIn: ['PAID', 'COMPLETED'] } },
          data: { status: 'EXPIRED' },
        });

        if (b.computerId) {
          await tx.computer.updateMany({ where: { id: b.computerId, status: 'OCCUPIED' }, data: { status: 'AVAILABLE' } });
        }

        // Bonus ballarni qaytarish (mijozning puli/ballari yo'qolmasligi kerak)
        if (b.pointsUsed > 0) {
          const user = await tx.user.update({
            where: { id: b.userId },
            data: { loyaltyBalance: { increment: b.pointsUsed } },
            select: { loyaltyBalance: true },
          });
          await tx.loyaltyTransaction.create({
            data: {
              userId: b.userId,
              type: 'REFUND',
              amount: b.pointsUsed,
              balanceAfter: user.loyaltyBalance,
              description: `${b.pointsUsed.toLocaleString('ru-RU')} ball qaytarildi (to'lov muddati tugdi)`,
              bookingId: b.id,
            },
          });
        }

        // Promo-kod ishlatish hisobini qaytarish
        if (b.promoCodeId) {
          await tx.promoRedemption.deleteMany({ where: { bookingId: b.id } });
          await tx.promoCode.updateMany({
            where: { id: b.promoCodeId, usedCount: { gt: 0 } },
            data: { usedCount: { decrement: 1 } },
          });
        }

        await tx.notification.create({
          data: {
            userId: b.userId,
            title: 'Bron muddati tugadi',
            message: 'To\'lov amalga oshirilmagani uchun broningiz bekor qilindi va joy bo\'shatildi. Bonus ballaringiz qaytarildi.',
            type: 'booking',
          },
        });
        return true;
      });
      if (!done) continue;
      released += 1;
      io.emit('booking_status_changed', { roomId: b.roomId, bookingId: b.id, type: 'CANCELLED' });
      void cacheDel(`avail:${b.roomId}:*`);
    } catch (err) {
      console.error(`[booking-worker] Band qilish muddati o'tmadi: ${b.id}`, (err as Error).message);
    }
  }
  if (released > 0) console.log(`[booking-worker] ${released} ta muddati o'tgan bron bekor qilindi`);
  return released;
}

/** Bitta to'liq o'tish: barcha vazifalar, distributed lock ostida. */
export async function runBookingWorkerSweep(): Promise<void> {
  await withWorkerLock(async () => {
    const now = new Date();
    try {
      await releaseExpiredHolds(now);
    } catch (err) {
      console.error('[booking-worker] hold tozalash xatosi:', (err as Error).message);
    }
    try {
      await closeExpiredSessions(now);
    } catch (err) {
      console.error('[booking-worker] sessiya yopish xatosi:', (err as Error).message);
    }
    try {
      // Tasdiqlangan, lekin boshlanmagan (no-show) bronlarni yopish
      await prisma.$transaction((tx) => closeNoShowSessions(tx, now, { lock: false }));
    } catch (err) {
      console.error('[booking-worker] no-show tozalash xatosi:', (err as Error).message);
    }
  });
}

/**
 * Davriy ishga tushirish. Server ishga tushganda BIR MARTA to'liq tozalash
 * (restart'dan keyin o'tgan sessiyalar ham yopiladi), keyin har
 * BOOKING_WORKER_INTERVAL_MS da.
 */
export function scheduleBookingWorker(): NodeJS.Timeout {
  const tick = () => {
    void runBookingWorkerSweep().catch((err) => console.error('[booking-worker]', (err as Error).message));
  };
  setTimeout(tick, 2_000).unref?.();
  return setInterval(tick, config.bookings.workerIntervalMs);
}

/**
 * Sessiyani check-in qilganda chaqiriladi: `session_ends_at` ni yozib qo'yadi
 * (worker shu ustidan avtomatik yopadi). Vaqt oralig'i o'tib ketgan bo'lsa
 * startSessionGate allaqachon rad etgan bo'ladi.
 */
export function sessionEndInstant(date: Date, endTime: string, startTime: string): Date | null {
  return slotInstants(date, startTime, endTime)?.end ?? null;
}
