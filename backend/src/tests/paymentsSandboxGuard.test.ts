import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// DIANAMIK import atob har bir testda ishlatiladi (`mod.*`) — statik import
// `sandboxForced` modul darajasidagi o'zgaruvchini oldindan tasdiqlar edi.

/**
 * SPEC §3: "PAYMENTS_DEV_MODE production'da qat'iy TAQIQLANGAN bo'lishi
 * kerak — production'da hech qanday sharoitda sandbox ishga tushmasligi
 * kerak, aks holda hech qanday to'lov qilinmagan holda ham
 * booking/payment 'PAID' bo'lib qoladi."
 *
 * Bu test `sandboxForced` modul ichida bo'lgani uchun import dinamik qilinadi:
 * har bir holat uchun modul qayta yuklanadi.
 */
describe('paymentsRuntime — production\'da sandbox qat\'iy taqiqlangan', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDevMode = process.env.PAYMENTS_DEV_MODE;

  beforeEach(() => {
    vi.resetModules();
    // Har bir test toza holatdan boshlanishi uchun
    process.env.PAYMENTS_DEV_MODE = 'false';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDevMode === undefined) delete process.env.PAYMENTS_DEV_MODE;
    else process.env.PAYMENTS_DEV_MODE = originalDevMode;
  });

  it('NODE_ENV=production: setSandboxForced(true) YOKSA QILMAYDI', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('../config/paymentsRuntime');

    mod.setSandboxForced(true);

    // Hech qanday yo'l bilan sandbox yoniq bo'lib qolmasligi kerak
    expect(mod.paymentsSandbox()).toBe(false);
  });

  it('NODE_ENV=production: PAYMENTS_DEV_MODE=true ham sandboxni yoqmaydi', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_DEV_MODE = 'true';
    vi.resetModules();
    const mod = await import('../config/paymentsRuntime');

    // Env orqali ham, in-app orqali ham production'da sandbox oqmaydi
    expect(mod.paymentsSandbox()).toBe(false);

    mod.setSandboxForced(true);
    expect(mod.paymentsSandbox()).toBe(false);
  });

  it('NODE_ENV=production: toggle bir necha marta urilsa ham baribir false', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('../config/paymentsRuntime');

    mod.setSandboxForced(true);
    mod.setSandboxForced(false);
    mod.setSandboxForced(true);
    mod.setSandboxForced(true);

    expect(mod.paymentsSandbox()).toBe(false);
  });

  it('NODE_ENV=production: "force" ham sandboxni yoqmaydi (eski bypass olib tashlandi)', async () => {
    process.env.NODE_ENV = 'production';
    // "force" — eski kodda production'da sandboxni yoqish uchun "maxsus" kalit edi
    process.env.PAYMENTS_DEV_MODE = 'force';
    vi.resetModules();
    const mod = await import('../config/paymentsRuntime');
    const { config } = await import('../config');

    // IKKALA qatlam ham false bo'lishi shart (defense in depth)
    expect(config.payments.devMode).toBe(false);
    expect(mod.paymentsSandbox()).toBe(false);

    mod.setSandboxForced(true);
    expect(mod.paymentsSandbox()).toBe(false);
  });

  it('NODE_ENV=production emas: dev/test rejimi ishlaydi (lokal uchun)', async () => {
    process.env.NODE_ENV = 'development';
    const mod = await import('../config/paymentsRuntime');

    expect(mod.paymentsSandbox()).toBe(false);
    mod.setSandboxForced(true);
    expect(mod.paymentsSandbox()).toBe(true);
  });
});
