import { config } from '../config';

/**
 * To'lovlar sandbox (test) rejimi — runtime holati.
 *
 * - `PAYMENTS_DEV_MODE` env'i (config.payments.devMode) — boot vaqtida aniqlanadi.
 * - Ustiga SUPER_ADMIN panel orqali in-app qo'shimcha sandbox yoqish/o'chirish
 *   mumkin (real kredensiallarsiz ham 4 provayder to'liq ishlab berish uchun).
 *   Qiymat siteSetting'da saqlanadi va server qayta ishga tushganda tiklanadi.
 *
 * Sandbox — bu "qalbaki muvaffaqiyat" emas: WEBHOOK imzolari hamon tekshiriladi,
 * summa server tomonidan validatsiya qilinadi va "PAID" holati faqat server
 * tomonidan tasdiqlangandan keyin o'rnatiladi. Farqi — real pul kiritilmaydi.
 */
let sandboxForced = false;

/**
 * PRODUCTION'DA SANDBOX BUTUNLAY TAQIQLANGAN (spec §3).
 *
 * Sabab: sandbox — real pul kirmaydigan test yo'li. Agar production'da
 * yoqib qo'yilsa, foydalanuvchi haqiqiy to'lov qilmasdan "to'ldi" holatiga
 * o'tadi. Bu eng jiddiy xavfsizlik/iqtisodiy xato turi, shuning uchun
 * production'da hech qanday yo'l bilan yoqilmaydi — na env, na DB
 * siteSetting, na admin panel. `NODE_ENV=production` da bu funksiyalar
 * `false` qaytaradi va toggle so'rovi rad etiladi.
 */
function sandboxAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function setSandboxForced(on: boolean): void {
  if (!sandboxAllowed()) {
    if (on) {
      console.error('[PAYMENTS] Production muhitda sandbox yoqib bo\'lmaydi — so\'rov rad etildi.');
    }
    return;
  }
  if (sandboxForced === on) return;
  sandboxForced = on;
  console.warn(`[PAYMENTS] SANDBOX rejimi ${on ? 'YOQILDI (test/to\'lovlar)' : 'o\'chirildi'}`);
}

/**
 * Hozirgi sandbox holati: env rejimi + in-app rejim.
 * PRODUCTION'DA DOIM `false` — qat'iy.
 */
export function paymentsSandbox(): boolean {
  if (!sandboxAllowed()) return false;
  return config.payments.devMode || sandboxForced;
}

/**
 * Browser qaytadigan mock gateway origin. Real kredensial yo'q bo'lganda
 * checkout havolalari shu origin'ga yo'naltiriladi (localhost bo'lmasligi uchun
 * so'rov kirgan host ishlatiladi).
 */
export function sandboxOrigin(req?: { protocol?: string; host?: string }): string {
  if (req?.protocol && req?.host) return `${req.protocol}://${req.host}`;
  return config.payments.localOrigin;
}