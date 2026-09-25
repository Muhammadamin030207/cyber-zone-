import prisma from '../lib/prisma';
import { io } from '../lib/socket';
import { config } from '../config';
import { BookingStatus, PaymentStatus } from '@prisma/client';

/**
 * To'lanmagan bronlarni avtomatik bekor qilish.
 *
 * PENDING/PENDING_PAYMENT bron UNPAID_BOOKING_TTL_MINUTES dan ko'proq kutgan bo'lsa
 * va unda hali yaroqli (muddati o'tmagan) onlayn payment sessiyasi bo'lmasa — bekor qilinadi.
 *
 * Bu "bron qilish mumkin, lekin to'lab bo'lmaydi, keyin esa joy qulflanib qoladi" senariysini
 * hal qiladi: tashlandiq bronlar vaqt oralig'ini abadiy egallab qolmaydi.
 */
const UNPAID: BookingStatus[] = ['PENDING', 'PENDING_PAYMENT'];
// "Qaror kutilayotgan" to'lov — kassa (CASH) PENDING yoki aktiv onlayn sessiya.
const OPEN_DECISION: PaymentStatus[] = ['PENDING', 'CREATED', 'REDIRECT_REQUIRED', 'PROCESSING'];

/**
 * Bronni ushlab turadigan yaroqli to'lov bormi?
 *
 * Faqat "qaror kutilayotgan" holatdagi VA hali muddati o'tmagan to'lov bronni ushlaydi.
 * Muddati o'tgan yoki muddati belgilanmagan (null) PENDING to'lov slotni abadiy
 * bloklab qo'yishi mumkin emas — shuning uchun `expiresAt` hisobga olinadi.
 */
export function isHeldByOpenPayment(
  payments: Array<{ status: string; expiresAt: Date | null }>,
  now: number,
): boolean {
  return payments.some(
    (p) =>
      (OPEN_DECISION as readonly string[]).includes(p.status) &&
      (p.expiresAt === null || p.expiresAt.getTime() > now),
  );
}

export async function expireStaleUnpaidBookings(): Promise<number> {
  const ttl = config.bookings.unpaidTtlMinutes;
  const cutoff = new Date(Date.now() - ttl * 60 * 1000);

  const stale = await prisma.booking.findMany({
    where: { status: { in: UNPAID }, createdAt: { lt: cutoff } },
    select: {
      id: true,
      userId: true,
      roomId: true,
      pointsUsed: true,
      promoCodeId: true,
      payments: { select: { id: true, status: true, expiresAt: true } },
    },
  });

  let expired = 0;
  const now = Date.now();
  for (const booking of stale) {
    if (isHeldByOpenPayment(booking.payments, now)) continue;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });

        await tx.payment.updateMany({
          where: { bookingId: booking.id, status: { notIn: ['PAID', 'COMPLETED'] } },
          data: { status: 'EXPIRED' },
        });

        // Bonus ballarni qaytarish
        if (booking.pointsUsed > 0) {
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
              description: `${booking.pointsUsed.toLocaleString('ru-RU')} ball qaytarildi (muddat o'tgan bron)`,
              bookingId: booking.id,
            },
          });
        }

        // Promo-kod count'ni qaytarish
        if (booking.promoCodeId) {
          await tx.promoCode.update({
            where: { id: booking.promoCodeId },
            data: { usedCount: { decrement: 1 } },
          });
        }

        await tx.notification.create({
          data: {
            userId: booking.userId,
            title: 'Bron muddati tugadi',
            message: 'To\'lov amalga oshirilmagani uchun broningiz avtomatik bekor qilindi. Yangi bron qilishingiz mumkin.',
            type: 'booking',
          },
        });
      });

      io.emit('booking_status_changed', { roomId: booking.roomId, bookingId: booking.id, type: 'CANCELLED' });
      expired += 1;
    } catch (err) {
      console.error(`[booking-expiry] Bron bekor qilinmadi: ${booking.id}`, (err as Error).message);
    }
  }

  if (expired > 0) {
    console.log(`[booking-expiry] ${expired} ta muddati o'tgan to'lanmagan bron bekor qilindi`);
  }
  return expired;
}

/** Bron yaratish va availability o'qishdan oldin muddati o'tganlarni tozalash. */
export async function expireUnpaidBeforeRead(): Promise<void> {
  try {
    await expireStaleUnpaidBookings();
  } catch (err) {
    console.error('[booking-expiry] Tozalashda xatolik:', (err as Error).message);
  }
}

/** Davriy tozalash — server ishga tushganda va har 5 daqiqada. */
export function scheduleBookingExpiry(): NodeJS.Timeout {
  void expireUnpaidBeforeRead();
  return setInterval(() => void expireUnpaidBeforeRead(), 5 * 60 * 1000);
}