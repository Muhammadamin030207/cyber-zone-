import { describe, it, expect } from 'vitest';
import { isHeldByOpenPayment } from '../utils/bookingExpiry';

const NOW = new Date('2026-09-25T12:00:00Z').getTime();
const future = new Date(NOW + 10 * 60 * 1000);
const past = new Date(NOW - 10 * 60 * 1000);

describe('booking expiry — to\'lov bronni ushlab turishi (spec §15)', () => {
  it('muddati o\'tmagan onlayn to\'lov bronni ushlab turadi', () => {
    expect(isHeldByOpenPayment([{ status: 'PROCESSING', expiresAt: future }], NOW)).toBe(true);
    expect(isHeldByOpenPayment([{ status: 'CREATED', expiresAt: future }], NOW)).toBe(true);
    expect(isHeldByOpenPayment([{ status: 'PENDING', expiresAt: future }], NOW)).toBe(true);
    expect(isHeldByOpenPayment([{ status: 'REDIRECT_REQUIRED', expiresAt: future }], NOW)).toBe(true);
  });

  it('muddati o\'tgan to\'lov bronni USHLAMAYDI (slot bo\'sh qaytadi)', () => {
    // Bu — tuzatilgan asosiy xato: esda bunday to\'lov slotni abadiy bloklar edi.
    expect(isHeldByOpenPayment([{ status: 'PENDING', expiresAt: past }], NOW)).toBe(false);
    expect(isHeldByOpenPayment([{ status: 'PROCESSING', expiresAt: past }], NOW)).toBe(false);
    expect(isHeldByOpenPayment([{ status: 'CREATED', expiresAt: past }], NOW)).toBe(false);
  });

  it('tugallangan/yaroqsiz to\'lovlar bronni ushlamaydi', () => {
    expect(isHeldByOpenPayment([{ status: 'PAID', expiresAt: future }], NOW)).toBe(false);
    expect(isHeldByOpenPayment([{ status: 'FAILED', expiresAt: future }], NOW)).toBe(false);
    expect(isHeldByOpenPayment([{ status: 'EXPIRED', expiresAt: future }], NOW)).toBe(false);
    expect(isHeldByOpenPayment([{ status: 'CANCELLED', expiresAt: future }], NOW)).toBe(false);
  });

  it('muddati belgilanmagan (null) ochiq to\'lov — eski ma\'lumot uchun ushlab turadi', () => {
    expect(isHeldByOpenPayment([{ status: 'PENDING', expiresAt: null }], NOW)).toBe(true);
  });

  it('bir nechta to\'lovdan biri yaroqli bo\'lsa, bron ushlanadi', () => {
    expect(
      isHeldByOpenPayment(
        [
          { status: 'FAILED', expiresAt: null },
          { status: 'EXPIRED', expiresAt: null },
          { status: 'PROCESSING', expiresAt: past },
          { status: 'CREATED', expiresAt: future },
        ],
        NOW,
      ),
    ).toBe(true);
  });

  it('barcha to\'lovlar yaroqsiz bo\'lsa, bron ushlanmaydi', () => {
    expect(
      isHeldByOpenPayment(
        [
          { status: 'FAILED', expiresAt: future },
          { status: 'EXPIRED', expiresAt: past },
          { status: 'CANCELLED', expiresAt: null },
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it('to\'lov yo\'q bo\'lsa, bron ushlanmaydi', () => {
    expect(isHeldByOpenPayment([], NOW)).toBe(false);
  });
});
