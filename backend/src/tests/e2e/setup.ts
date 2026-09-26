// E2E test muhiti — har qanday import'dan OLDIN ishlaydi.
// Bu yerda o'rnatilgan env'lar .env tomonidan QAYTA yozilmaydi (dotenv override qilmaydi).
process.env.NODE_ENV = 'test';

// Alohida E2E ma'lumotlar bazasi (prod/dev DB'ga TEGMAYDI).
process.env.DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/cyber_zone_e2e?schema=public';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'e2e-refresh-secret';

// Tarmoqqa chiqmaydigan deterministik AI (fallback javob ishlatiladi).
process.env.GEMINI_API_KEY = '';

// Email yuborilmasin (SMTP sozlanmagan -> console fallback).
process.env.EMAIL_HOST = '';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

// To'lov webhook testlari uchun Payme kredensiallari (test qiymatlar).
process.env.PAYMENTS_DEV_MODE = '1'; // E2E to'lov oqimi sandbox rejimida ishlaydi (imzo validatsiyasi saqlanadi).
process.env.PAYME_MERCHANT_ID = 'e2e_payme_merchant';
process.env.PAYME_MERCHANT_KEY = 'e2e_payme_key';
process.env.PAYME_API_ENDPOINT = 'http://127.0.0.1:9/payme';
process.env.PROVIDER_CALLBACK_URL = 'http://localhost:5000';

// Uzum / Paynet webhook test kredensiallari (raw-body HMAC va Basic auth tekshiruvi uchun).
process.env.UZUM_MERCHANT_ID = 'e2e_uzum_terminal';
process.env.UZUM_SECRET_KEY = 'e2e_uzum_secret';
process.env.UZUM_API_ENDPOINT = 'http://127.0.0.1:9/uzum';
process.env.PAYNET_MERCHANT_ID = 'e2e_paynet_merchant';
process.env.PAYNET_PASSWORD = 'e2e_paynet_secret';
process.env.PAYNET_API_ENDPOINT = 'http://127.0.0.1:9/paynet';

process.env.FRONTEND_URLS = 'http://localhost:3006';
process.env.WEBAUTHN_RP_ID = 'localhost';
process.env.WEBAUTHN_EXPECTED_ORIGINS = 'http://localhost:3006';

// ---------- 2FA (TOTP) at-rest kaliti ----------
// Ishlab chiqarishda `TOTP_AT_REST_KEY` bo'lmasa kod at-rest kalit talab qiladi
// va "fail closed" ishlaydi (zaif fallback kalit ISHLATILMAYDI) — bu ishlab
// chiqarish xavfsizligi uchun to'g'ri, lekin 2FA e2e testlari shunda 500 oladi.
// Test uchun DETERMINISTIK va aniq "test-only" qiymat. Bu qiymat FAQAT test
// muhitida; .env.example uni `generateValue: true` bilan Render'da yaratadi.
// eslint-disable-next-line no-control-regex
process.env.TOTP_AT_REST_KEY =
  process.env.TOTP_AT_REST_KEY || 'e2e-only-totp-at-rest-key-32-chars-min!!!';

// ---------- REDIS (WebAuthn challenge store, fail-closed) ----------
// Passkey challenge'lari Redis'da saqlanadi va Redis yo'q/ulanmagan bo'lsa
// challenge HECH QACHON berilmaydi (fail closed) — ya'ni `/webauthn/*/options`
// 503 qaytaradi. E2E uchun alohida DB indeks (1) ishlatiladi, lokal dev
// keshi (0) buzilmaydi.
process.env.REDIS_URL = process.env.E2E_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6380/1';

import { beforeAll, afterAll } from 'vitest';
import { redisClient, cacheDel } from '../../lib/redis';

// WebAuthn challenge'larini sinovdan OLDIN tayyorlash (test app server.ts
// ishga tushirmaydi, shuning uchun `connect()` qo'lda chaqiriladi).
beforeAll(async () => {
  try {
    if (redisClient.status === 'wait' || redisClient.status === 'end') {
      await redisClient.connect();
    }
    // 'connecting' bo'lsa tayyor bo'lishini kutamiz
    if (redisClient.status !== 'ready') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        redisClient.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Rate-limit hisoblarini TOZALAMIZ. Sabab: `nextIp()` moduli har test
    // faylda qayta yuklanadi va 0 dan boshlanadi — ya'ni turli fayllar BIR XIL
    // IP'larni takrorlaydi. Redis esa umumiy hisobni saqlashda davom etsa,
    // limit(key) fayillararo carry-over bo'lib keyingi testni "noto'g'ri"
    // 429 bilan sindiradi. Limiterning o'zi O'CHIRILMAYDI — faqat fayil
    // boshida toza holatdan boshlanadi.
    await cacheDel('rl:*');
  } catch {
    // Redis yo'q bo'lsa WebAuthn testlari 503 bilan ochiq xatoni ko'rsatadi.
  }
});

afterAll(async () => {
  try {
    await redisClient.quit();
  } catch {
    /* ignore */
  }
});
