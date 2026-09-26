import { toNumber, round2 } from './money';
import { config } from '../config';

export interface PromoDiscount {
  discountType?: 'PERCENTAGE' | 'FIXED' | string;
  discountValue?: any;
  minBookingAmount?: any;
}

export interface PricingInput {
  pricePerHour: any;
  durationHours: any;
  promo?: PromoDiscount | null;
  pointsToUse?: number; // bonus ball (1 ball = 1 so'm)
  maxPointsPercent?: number; // ball bilan qoplash mumkin bo'lgan maksimal foiz (0.5 = 50%)
  /**
   * Depozit (avans) foizi — 1..100. Berilmasa `DEPOSIT_PERCENT` envidan olinadi
   * (standart 30). FOIZ HECH QACHON kodda hardcode emas: admin/config orqali
   * o'zgartiriladi. Natija bronga `depositPercent` sifatida YOZILADI, shuning
   * uchun keyingi to'lovlar aynan shu foiz bo'yicha talab qilinadi.
   */
  depositPercent?: number;
}

export interface PricingResult {
  baseTotal: number;
  discountPromo: number;
  discountPoints: number;
  totalDiscount: number;
  finalTotal: number;
  pointsUsed: number;
  advance: number;
  remaining: number;
  /** Bronning depozit foizi — bronga shu qiymat yoziladi. */
  depositPercent: number;
}

/** Depozit foizini 1..100 oralig'iga (butun son) keltiradi. */
export function resolveDepositPercent(value?: number | null): number {
  const raw = value === undefined || value === null || !Number.isFinite(Number(value))
    ? config.payments.depositPercent
    : Math.trunc(Number(value));
  return Math.min(100, Math.max(1, Number.isFinite(raw) ? raw : config.payments.depositPercent));
}

/**
 * Bron narxini barcha chegirmalar bilan hisoblaydi (tiyingacha aniq).
 * Promo chegirma, keyin bonus ballar chegirmasi qo'llaniladi.
 */
export function computeBookingPrice(input: PricingInput): PricingResult {
  const baseTotal = round2(toNumber(input.pricePerHour) * toNumber(input.durationHours));

  // 1) Promo chegirma
  let discountPromo = 0;
  const promo = input.promo;
  if (promo) {
    const value = toNumber(promo.discountValue);
    if (promo.discountType === 'PERCENTAGE') {
      discountPromo = round2((baseTotal * value) / 100);
    } else if (promo.discountType === 'FIXED') {
      discountPromo = round2(value);
    }
    if (toNumber(promo.minBookingAmount) && baseTotal < toNumber(promo.minBookingAmount)) {
      discountPromo = round2(0); // minimal summa bajarilmasa promo qo'llanmaydi
    }
    discountPromo = Math.min(round2(discountPromo), baseTotal);
  }

  const afterPromo = round2(baseTotal - discountPromo);

  // 2) Bonus ballar chegirmasi (1 ball = 1 so'm, maks 50%)
  const cap = Math.floor(afterPromo * (input.maxPointsPercent ?? 0.5));
  const requested = Math.floor(Math.max(0, toNumber(input.pointsToUse) || 0));
  const pointsUsed = Math.min(requested, cap);
  const discountPoints = pointsUsed;

  const totalDiscount = round2(discountPromo + discountPoints);
  const finalTotal = round2(Math.max(0, baseTotal - totalDiscount));

  // 3) Depozit / qoldiq — server konfiguratsiyasi (DEPOSIT_PERCENT, standart 30%).
  //    `advance + remaining === finalTotal` DOIM teng bo'lishi kafolatlanadi
  //    (qoldiq "qoldiq"dan hisoblanadi, alohida yuvilmaydi).
  const depositPercent = resolveDepositPercent(input.depositPercent);
  const advance = round2((finalTotal * depositPercent) / 100);
  const remaining = round2(finalTotal - advance);

  return {
    baseTotal,
    discountPromo,
    discountPoints,
    totalDiscount,
    finalTotal,
    pointsUsed,
    advance,
    remaining,
    depositPercent,
  };
}