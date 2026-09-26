import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '5000'),
  databaseUrl: process.env.DATABASE_URL!,
  jwt: {
    secret: process.env.JWT_SECRET!,
    refreshSecret: process.env.JWT_REFRESH_SECRET!,
    accessExpires: process.env.ACCESS_TOKEN_EXPIRES || '15m',
    refreshExpires: process.env.REFRESH_TOKEN_EXPIRES || '7d',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  },
  frontendUrls: (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3006')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  email: {
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587'),
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
    secure: process.env.EMAIL_USE_TLS === 'true' || process.env.EMAIL_SECURE === 'true',
    from: process.env.DEFAULT_FROM_EMAIL || '',
    // Asosiy SMTP portga ulanib bo'lmasa (masalan Render free SMTP portlarini
    // bloklaydi), shu portlar ketma-ket sinaladi. Brevo 2525'ni qo'llab-quvvatlaydi.
    fallbackPorts: (process.env.EMAIL_FALLBACK_PORTS || '2525')
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((v) => Number.isFinite(v) && v > 0),
  },
  bookings: {
    // To'lanmagan bronni avtomatik bekor qilish muddati (daqiqa). Abandoned
    // PENDING/PENDING_PAYMENT bronlar vaqt oralig'ini qulflab qoymasligi uchun.
    unpaidTtlMinutes: Math.max(5, parseInt(process.env.UNPAID_BOOKING_TTL_MINUTES || '60', 10)),
    // Taymer/band qilish worker'i chastotasi (ms): tugagan sessiyalarni
    // O'Z-O'ZICHIGA yopadi, kompyuterni bo'shatadi, muddati o'tgan
    // to'lanmagan bronlarni bekor qiladi. 30s — foydalanuvchi sezmaydi.
    workerIntervalMs: Math.max(10_000, parseInt(process.env.BOOKING_WORKER_INTERVAL_MS || '30_000', 10)),
    // Availability javobini Redis'da qanchacha saqlash (soniya). DB
    // yukini 1000+ foydalanuvchida kamaytiradi (yozishda darhol
    // invalidatsiya qilinadi).
    availabilityCacheTtlSec: Math.max(0, parseInt(process.env.AVAILABILITY_CACHE_TTL_SEC || '15', 10)),
  },
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',
  payments: {
    minDepositPercent: Math.min(100, Math.max(1, parseInt(process.env.MIN_DEPOSIT_PERCENT || '10', 10))),
    /** Standart depozit (avans) foizi — SERVER avtoritet. */
    depositPercent: Math.min(100, Math.max(1, parseInt(process.env.DEPOSIT_PERCENT || '30', 10))),
    /** Sessiya tugagandan keyingi qarzni to'lash muddati (kun). */
    debtDueDays: Math.max(1, parseInt(process.env.DEBT_DUE_DAYS || '7', 10)),
    callbackBaseUrl: process.env.PROVIDER_CALLBACK_URL || '',
    /**
     * SANDBOX (dev) rejimi — real kredensiallarsiz Click/Payme to'lov oqimini
     * lokal sinash uchun.
     *   PAYMENTS_DEV_MODE=1|true   → dev/test muhitida yoqiladi
     *   PAYMENTS_DEV_MODE=force    → production'da ham (orangli: mock gateway
     *                                ochiladi — faqat sinash uchun, real pul emas)
     * Boshqa hollarda (production + force bo'lmasa) o'chirilgan.
     * Webhook imzolari HAMON tekshiriladi — soxta "PAID" yo'q.
     */
    devMode: (() => {
      const raw = (process.env.PAYMENTS_DEV_MODE || '').trim().toLowerCase();
      const wanted = raw === '1' || raw === 'true' || raw === 'force';
      if (!wanted) return false;
      // PRODUCTION'DA HECH QANDAY SHAROITDA yoqilmaydi (spec §3).
      // Eski "force" bypass olib tashlandi: u config.payments.devMode'ni
      // production'da `true` qilib qo'yib, kelgusi kodda to'g'ridan-to'g'ri
      // shu qiymatni o'qish orqali `paymentsSandbox()` qat'iy qatlamini
      // chetlab o'tishga imkon berardi. Endi ikki qatlam bir-birini tekshiradi:
      //   1) config.payments.devMode  -> production'da doim false
      //   2) paymentsSandbox()        -> production'da qat'iy false
      if (process.env.NODE_ENV === 'production') {
        console.error('[PAYMENTS] ⚠️ PAYMENTS_DEV_MODE production\'da butunlay taqiqlangan — sandbox o\'chirildi.');
        return false;
      }
      console.log('[PAYMENTS] SANDBOX rejimi yoqildi — Click/Payme dev kredensiallari bilan sinovda.');
      return true;
    })(),
    /** Mock gateway'ni chaqirish uchun maxsus kalit (SANDBOX'da mo`ljallangan). */
    devMockKey: process.env.PAYMENTS_DEV_MOCK_KEY || 'cyberzone-dev-mock',
    /** Sandbox'da checkout URL'lar uchun bazaviy origin (callback bo'lmasa, shu server). */
    localOrigin: (process.env.PROVIDER_CALLBACK_URL || `http://localhost:${parseInt(process.env.PORT || '5000', 10)}`).replace(/\/$/, ''),
    click: {
      serviceId: process.env.CLICK_SERVICE_ID || '',
      merchantId: process.env.CLICK_MERCHANT_ID || '',
      merchantUserId: process.env.CLICK_MERCHANT_USER_ID || '',
      secretKey: process.env.CLICK_SECRET_KEY || '',
      endpoint: process.env.CLICK_CHECKOUT_URL || 'https://my.click.uz/services/pay',
    },
    payme: {
      merchantId: process.env.PAYME_MERCHANT_ID || '',
      merchantKey: process.env.PAYME_MERCHANT_KEY || '',
      checkoutUrl: process.env.PAYME_CHECKOUT_URL || 'https://checkout.payme.uz',
      apiEndpoint: process.env.PAYME_API_ENDPOINT || 'https://checkout.payme.uz',
    },
    uzum: {
      merchantId: process.env.UZUM_MERCHANT_ID || process.env.UZUM_TERMINAL_ID || '',
      secretKey: process.env.UZUM_SECRET_KEY || process.env.UZUM_API_KEY || '',
      checkoutUrl: process.env.UZUM_CHECKOUT_URL || 'https://www.uzumcheckout.uz',
      apiEndpoint: process.env.UZUM_API_ENDPOINT || 'https://checkoutapi.uzumbank.uz',
    },
    paynet: {
      merchantId: process.env.PAYNET_MERCHANT_ID || process.env.PAYNET_USERNAME || '',
      password: process.env.PAYNET_PASSWORD || '',
      serviceId: process.env.PAYNET_SERVICE_ID || '',
      checkoutUrl: process.env.PAYNET_CHECKOUT_URL || 'https://app.paynet.uz',
      apiEndpoint: process.env.PAYNET_API_ENDPOINT || 'https://api.paynet.uz/api',
    },
  },
  security: {
    // Login brute-force himoyasi: hisob bo'yicha ketma-ket xato urinishlar soni
    // (10-xato = LOGIN_MAX_ATTEMPTS) paysaliga hisob 24-soatga bloklanadi
    // (locked_until = now + 24h). Blok muddati daqiqada: LOGIN_LOCK_MINUTES.
    // Spec §4.2 bo'yicha default 1440 = 24-soat (progressiv emas, doimiy).
    // Env orqali sozlanadi (hardcode emas). Bu GLOBAL emas — faqat shu hisobga tegishli.
    loginMaxAttempts: Math.max(1, parseInt(process.env.LOGIN_MAX_ATTEMPTS || '10', 10)),
    loginLockMinutes: (process.env.LOGIN_LOCK_MINUTES || '1440')
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((v) => Number.isFinite(v) && v > 0),
  },
  webauthn: {
    // WebAuthn/Passkey sozlamalari. rpID — passkey bog'langan domain (production:
    // frontend domain). expectedOrigins — CORS bilan mos.
    rpName: process.env.WEBAUTHN_RP_NAME || 'Cyber-ZONE',
    rpID:
      process.env.WEBAUTHN_RP_ID ||
      (() => {
        const firstUrl = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3006')
          .split(',')[0]
          .trim();
        return new URL(firstUrl).hostname;
      })(),
    expectedOrigins: (process.env.WEBAUTHN_EXPECTED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    tempPasswordMinutes: Math.max(10, parseInt(process.env.TEMP_PASSWORD_MINUTES || '30', 10)),
  },
  ai: {
    // Claude (Anthropic) — server tomonida, kalit hech qachon frontendga chiqmaydi.
    // ANTHROPIC_API_KEY o'rnatilgan bo'lsa — Claude ustunlik bilan ishlatiladi.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    anthropicEndpoint: process.env.ANTHROPIC_ENDPOINT || 'https://api.anthropic.com',

    geminiApiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest',
    temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '1000', 10),
  },
  vip: {
    // VIP zona uchun bir bronning MAXIMAL davomiyligi (daqiqa). 60 = faqat
    // 1 soatlik bron. Server avtoritet: frontend'dan kelgan davomiylik ham
    // shu chegara bilan kesiladi (booking.controller.ts).
    maxBookingMinutes: Math.max(30, parseInt(process.env.VIP_MAX_BOOKING_MINUTES || '60', 10)),
  },
  paymentsTransfer: {
    // Karta/hisob orqali o'tkazma: saytda faqat O'Z kartamiz ko'rsatiladi.
    // Foydalanuvchi o'z bank ilovasida to'laydi va chek (screenshot/PDF)
    // yuklaydi — hech qanday karta raqami saytga yuborilmaydi.
    cardNumber: (process.env.TRANSFER_CARD_NUMBER || '').replace(/\s+/g, ''),
    cardHolder: process.env.TRANSFER_CARD_HOLDER || '',
    bankName: process.env.TRANSFER_BANK_NAME || '',
    // "Ilovaga o'tish" tugmasi uchun havola (bank ilovasi / to'lov sahifasi)
    appUrl: process.env.TRANSFER_APP_URL || '',
    /** Usul mavjudmi — aks holda frontend'da ko'rsatilmaydi. */
    get enabled() {
      return Boolean(this.cardNumber && this.cardHolder);
    },
  },
};
