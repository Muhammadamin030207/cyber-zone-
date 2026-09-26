import { describe, it, expect, vi } from 'vitest';
import { computeBookingPrice, resolveDepositPercent } from '../utils/pricing';
import { round2 } from '../utils/money';

describe('computeBookingPrice — base', () => {
  it('computes base, 30% advance and remaining', () => {
    const r = computeBookingPrice({ pricePerHour: 10000, durationHours: 3 });
    expect(r.baseTotal).toBe(30000);
    expect(r.advance).toBe(9000);
    expect(r.remaining).toBe(21000);
    expect(r.discountPromo).toBe(0);
    expect(r.discountPoints).toBe(0);
    expect(r.finalTotal).toBe(30000);
  });

  it('handles fractional hours', () => {
    const r = computeBookingPrice({ pricePerHour: 10000, durationHours: 1.5 });
    expect(r.baseTotal).toBe(15000);
    expect(r.advance).toBe(4500);
    expect(r.remaining).toBe(10500);
  });
});

describe('computeBookingPrice — promo', () => {
  it('applies PERCENTAGE discount', () => {
    const r = computeBookingPrice({
      pricePerHour: 10000,
      durationHours: 3,
      promo: { discountType: 'PERCENTAGE', discountValue: 10 },
    });
    expect(r.discountPromo).toBe(3000);
    expect(r.finalTotal).toBe(27000);
    expect(r.advance).toBe(8100);
    expect(r.remaining).toBe(18900);
  });

  it('applies FIXED discount', () => {
    const r = computeBookingPrice({
      pricePerHour: 10000,
      durationHours: 3,
      promo: { discountType: 'FIXED', discountValue: 5000 },
    });
    expect(r.discountPromo).toBe(5000);
    expect(r.finalTotal).toBe(25000);
  });

  it('does not clamp fixed discount above base', () => {
    const r = computeBookingPrice({
      pricePerHour: 10000,
      durationHours: 1,
      promo: { discountType: 'FIXED', discountValue: 20000 },
    });
    expect(r.discountPromo).toBe(10000);
    expect(r.finalTotal).toBe(0);
    expect(r.advance).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('skips promo when min booking amount not reached', () => {
    const r = computeBookingPrice({
      pricePerHour: 10000,
      durationHours: 1,
      promo: { discountType: 'FIXED', discountValue: 5000, minBookingAmount: 20000 },
    });
    expect(r.discountPromo).toBe(0);
    expect(r.finalTotal).toBe(10000);
  });
});

describe('computeBookingPrice — loyalty points', () => {
  it('caps points at 50% of after-promo price', () => {
    const r = computeBookingPrice({
      pricePerHour: 10000,
      durationHours: 3,
      promo: { discountType: 'PERCENTAGE', discountValue: 10 },
      pointsToUse: 20000,
    });
    expect(r.discountPromo).toBe(3000);
    expect(r.discountPoints).toBe(13500); // floor(27000 * 0.5)
    expect(r.pointsUsed).toBe(13500);
    expect(r.finalTotal).toBe(13500);
  });

  it('uses fewer points if requested below cap', () => {
    const r = computeBookingPrice({ pricePerHour: 10000, durationHours: 3, pointsToUse: 5000 });
    expect(r.pointsUsed).toBe(5000);
    expect(r.finalTotal).toBe(25000);
  });

  it('uses zero points when not requested', () => {
    const r = computeBookingPrice({ pricePerHour: 10000, durationHours: 3 });
    expect(r.pointsUsed).toBe(0);
    expect(r.finalTotal).toBe(30000);
  });
});

describe('computeBookingPrice — combined discounts', () => {
  it('promo then points stack correctly', () => {
    const r = computeBookingPrice({
      pricePerHour: 10000,
      durationHours: 3,
      promo: { discountType: 'PERCENTAGE', discountValue: 10 },
      pointsToUse: 10000,
    });
    expect(r.discountPromo).toBe(3000); // 10% of 30000
    expect(r.discountPoints).toBe(10000); // <= cap 13500
    expect(r.totalDiscount).toBe(13000);
    expect(r.finalTotal).toBe(17000); // 30000 - 13000
    expect(r.advance).toBe(5100);
    expect(r.remaining).toBe(11900);
  });
});
// ============ DEPOZIT FOIZI (spec §6) — HARDCODE BO'LMASLIGI ============
// Foiz `DEPOSIT_PERCENT` envidan olinadi va bronga yoziladi. 30% — faqat
// standart qiymat; admin/config uni o'zgartirishi MUMKIN.
describe('computeBookingPrice — depozit foizi konfiguratsiyadan', () => {
  it('standart 30% bo\'yicha 120 000 -> 36 000 / 84 000', () => {
    const r = computeBookingPrice({ pricePerHour: 60000, durationHours: 2 });
    expect(r.depositPercent).toBe(30);
    expect(r.finalTotal).toBe(120000);
    expect(r.advance).toBe(36000);
    expect(r.remaining).toBe(84000);
  });

  it('berilgan foizni qo\'llaydi (30 hardcode emas)', () => {
    const r = computeBookingPrice({ pricePerHour: 60000, durationHours: 2, depositPercent: 50 });
    expect(r.depositPercent).toBe(50);
    expect(r.advance).toBe(60000);
    expect(r.remaining).toBe(60000);
  });

  it('25% kabi g\'ayri-default foiz ham to\'gri ishlaydi', () => {
    const r = computeBookingPrice({ pricePerHour: 40000, durationHours: 3, depositPercent: 25 });
    expect(r.depositPercent).toBe(25);
    expect(r.finalTotal).toBe(120000);
    expect(r.advance).toBe(30000);
    expect(r.remaining).toBe(90000);
  });

  it('foiz chegaradan tashqarida bo\'lsa 1..100 ga qisqaradi', () => {
    expect(resolveDepositPercent(0)).toBe(1);
    expect(resolveDepositPercent(-50)).toBe(1);
    expect(resolveDepositPercent(150)).toBe(100);
    expect(resolveDepositPercent(1000)).toBe(100);
  });

  it('foiz berilmasa env standartiga (DEPOSIT_PERCENT) qaytadi', () => {
    const prev = process.env.DEPOSIT_PERCENT;
    // config import vaqtida o'qilgani uchun module cache'ni tozalashimiz kerak
    vi.resetModules();
    process.env.DEPOSIT_PERCENT = '40';
    return import('../config').then(async ({ config }) => {
      vi.resetModules();
      const { computeBookingPrice: compute } = await import('../utils/pricing');
      const r = compute({ pricePerHour: 50000, durationHours: 2 });
      expect(r.depositPercent).toBe(40);
      expect(r.finalTotal).toBe(100000);
      expect(r.advance).toBe(40000);
      expect(r.remaining).toBe(60000);
      if (prev === undefined) delete process.env.DEPOSIT_PERCENT;
      else process.env.DEPOSIT_PERCENT = prev;
    });
  });

  it('advance + remaining DOIM finalTotal ga teng (tiyingacha, promo/ballar bilan ham)', () => {
    const cases = [
      { pricePerHour: 10000, durationHours: 3 },
      { pricePerHour: 10000, durationHours: 1.5, depositPercent: 17 },
      { pricePerHour: 33333, durationHours: 2.5, depositPercent: 33 },
      { pricePerHour: 10000, durationHours: 3, promo: { discountType: 'PERCENTAGE' as const, discountValue: 13 }, depositPercent: 45 },
      { pricePerHour: 10000, durationHours: 3, pointsToUse: 7000, depositPercent: 7 },
    ];
    for (const c of cases) {
      const r = computeBookingPrice(c);
      expect(round2(r.advance + r.remaining)).toBe(r.finalTotal);
      expect(r.advance).toBe(round2((r.finalTotal * r.depositPercent) / 100));
    }
  });
});
