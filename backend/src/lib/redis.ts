import Redis from 'ioredis';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const url = process.env.REDIS_URL || 'redis://localhost:6380';

export const redis = new Redis(url, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  reconnectOnError: () => false,
});

redis.on('error', (err) => {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[REDIS] ulanish xatosi (caching o\'chirilgan):', err.message);
  }
});

/** REDIS_URL env'da umuman belgilanmaganmi (single-instance dev rejimi). */
export function isRedisConfigured(): boolean {
  return Boolean(String(process.env.REDIS_URL || '').trim());
}

/** Klient tayyarmi (bir martalik, xavfsiz tekshiruv). */
export function isRedisReady(client: Redis = redis): boolean {
  try {
    return client.status === 'ready';
  } catch {
    return false;
  }
}

/**
 * Yangi ioredis klienti (bir xil sozlamalar bilan). Socket.IO adapter va
 * rate limiter alohida klient ishlatadi — asosiy cache klienti bilan
 * ulashilmadi (pub/sub connection'ni monopolizatsiya qilmasin).
 */
export function createRedisConnection(): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    reconnectOnError: () => false,
  });
}

let sharedPub: Redis | null = null;
let sharedSub: Redis | null = null;

/**
 * Ko'p instansiyali rejim uchun umumiy (shared) bog'lanish. Socket.IO
 * pub/sub uchun alohida (pub + sub) klientlar kerak — bitta klient bir vaqtda
 * ham publisher ham subscriber bo'la olmaydi. Bir marta yaratiladi, keyin
 * qayta ishlatiladi (har chaqiruvda yangi ulanish ochilmasin).
 */
export function getSharedRedisConnection(): { pub: Redis; sub: Redis } {
  if (sharedPub && sharedPub.status === 'end') sharedPub = null;
  if (sharedSub && sharedSub.status === 'end') sharedSub = null;
  if (!sharedPub) {
    sharedPub = createRedisConnection();
    sharedPub.on('error', (err) => console.warn('[REDIS:pub]', err.message));
  }
  if (!sharedSub) {
    sharedSub = sharedPub.duplicate();
    sharedSub.on('error', (err) => console.warn('[REDIS:sub]', err.message));
  }
  return { pub: sharedPub, sub: sharedSub };
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    if (redis.status !== 'ready') return null;
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec = 60): Promise<void> {
  try {
    if (redis.status !== 'ready') return;
    await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch {
    /* ignore */
  }
}

/**
 * Pattern bo'yicha kalitlarni o'chirish — `KEYS` BLOKLOVKAN foydalanilmaydi
 * (`KEYS` katta keyspace'da butun Redis'ni qaytarib qo'yadi). `SCAN` — O(1)
 * qadamli, non-blocking iteratsiya; kalitlar bo'laklar (chunk) bo'lib
 * `DEL` qilinadi. Kesh uchun cheklangan (QADAM_LIMIT) — juda keng pattern
 * (`*`) infinity loop bo'lmasligi uchun.
 */
const SCAN_COUNT = 250;
const DEL_CHUNK = 500;
const SCAN_ITERATION_LIMIT = 200;

export async function cacheDel(pattern: string): Promise<void> {
  try {
    if (redis.status !== 'ready') return;
    let cursor = '0';
    let iterations = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      cursor = next;
      iterations += 1;
      for (let i = 0; i < keys.length; i += DEL_CHUNK) {
        await redis.del(...keys.slice(i, i + DEL_CHUNK));
      }
      if (iterations >= SCAN_ITERATION_LIMIT) {
        console.warn(`[REDIS] cacheDel: "${pattern}" uchun ${SCAN_ITERATION_LIMIT} qadamlik limitga yetdi — qisman tozalandi.`);
        break;
      }
    } while (cursor !== '0');
  } catch {
    /* ignore */
  }
}

// ============================================================================
// RATE LIMITER (Redis-backed, ko'p instansiya + restart-safe)
// ============================================================================
// express-rate-limitning ichki store'i process xotirasida — ko'p instansiyada
// va restart'da hisobni yo'qotadi. Bu limiter hisobni Redis'da saqlaydi va
// Redis YO'Q/ULANMASA process ichidagi zaxira (fallback) hisobga o'tadi —
// server hech qachon crash bo'lmaydi va butun sayt bloklanmaydi.
//
// Xavfsizlik: autentifikatsiya/brute-force himoyasi asosan DB'da
// (loginThrottle) — shuning uchun rate limit bu yerda "qo'shimcha qatlam".
// `failClosed: true` berilgan endpoint'lar uchun esa Redis o'lganda so'rov
// rad qilinadi (masalan, chegara katta bo'lgan narxli endpoint'lar).
// ------------------------------------------------------------------------

// Zaxira (in-process) hisob — Redis ishlamaganda. Cheklangan, vaqt o'tishi
// bilan tozalanadi (xotira oshmasin).
const memoryBuckets = new Map<string, { count: number; resetAt: number }>();
const MEMORY_MAX_BUCKETS = 50_000;

function memoryHit(key: string, windowMs: number): { count: number; resetAt: number } {
  const now = Date.now();
  const existing = memoryBuckets.get(key);
  if (existing && existing.resetAt > now) {
    existing.count += 1;
    return existing;
  }
  if (memoryBuckets.size > MEMORY_MAX_BUCKETS) {
    for (const [k, v] of memoryBuckets) {
      if (v.resetAt <= now) memoryBuckets.delete(k);
      if (memoryBuckets.size <= MEMORY_MAX_BUCKETS * 0.8) break;
    }
  }
  const bucket = { count: 1, resetAt: now + windowMs };
  memoryBuckets.set(key, bucket);
  return bucket;
}

// Atomic increment + TTL (bitta round-trip, MULTI/2 ta qadam emas).
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export interface RedisRateLimiterOptions {
  /** Oyna uzunligi (ms) */
  windowMs: number;
  /** Oyna ichidagi maksimal so'rov soni */
  limit: number;
  /** Kalit prefiksi (boshqa limiterlar bilan to'qnashmaslik uchun) */
  keyPrefix: string;
  /** So'rov bo'yicha kalit (IP, email+IP, userId ...) */
  keyGenerator?: (req: Request) => string;
  /** Rad qilingandagi javob (string yoki to'liq JSON body) */
  message?: string | Record<string, unknown>;
  /**
   * Redis ishlamaganda nima qilish:
   *   false (default) — process ichidagi zaxira hisob bilan davom etadi (fail open)
   *   true            — so'rov rad qilinadi (fail closed, autentikatsiya uchun)
   */
  failClosed?: boolean;
}

const DEFAULT_MESSAGE = "Juda ko'p so'rov. Birozdan so'ng qayta urinib ko'ring.";

export function createRedisRateLimiter(opts: RedisRateLimiterOptions): RequestHandler {
  const {
    windowMs,
    limit,
    keyPrefix,
    keyGenerator = (req: Request) => String(req.ip || 'unknown'),
    message = DEFAULT_MESSAGE,
    failClosed = false,
  } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `${keyPrefix}:${keyGenerator(req)}`;

    let count: number | null = null;
    let resetAt = Date.now() + windowMs;

    if (isRedisReady()) {
      try {
        const reply = (await redis.eval(RATE_LIMIT_LUA, 1, key, String(windowMs))) as [number, number];
        count = Number(reply[0]) || 0;
        const ttl = Number(reply[1]);
        resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
      } catch {
        count = null;
      }
    }

    if (count === null) {
      if (failClosed) {
        res.setHeader('Retry-After', '5');
        res.status(503).json({
          success: false,
          message: 'Vaqtinchalik xizmat uzilishi. Birozdan so\'ng qayta urinib ko\'ring.',
        });
        return;
      }
      const bucket = memoryHit(key, windowMs);
      count = bucket.count;
      resetAt = bucket.resetAt;
    }

    const resetSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('RateLimit-Policy', `${limit};w=${Math.ceil(windowMs / 1000)}`);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      res
        .status(429)
        .json(typeof message === 'string' ? { success: false, message } : (message as Record<string, unknown>));
      return;
    }

    next();
  };
}

// ============================================================================
// WEBAUTHN CHALLENGE STORE (Redis-backed, FAIL-CLOSED)
// ============================================================================
// Challenge'ni o'z xotirasida (Map) saqlagan ilgari "1 process" edi: Render'da
// bir necha instance bo'lganda yoki restart'da verify bosqichi boshqa
// instance'ga tushsa — challenge topilmadi (404) yoki, yomon holatda, bir xil
// instance'da eski challenge qolib qoladi. Endi challenge Redis'da saqlanadi.
//
// XAVFSIZLIK: challenge — autentifikatsiya isbotining poydevori. Redis
// ishlamasa yoki `REDIS_URL` berilgan bo'lmasa — challenge HECH QACHON
// "muvaffaqiyatli yozildi" deb hisoblanmaydi (fail closed): `setChallenge`
// `false` qaytaradi (chaqiruvchi 503 qaytarishi kerak), `getChallenge` esa
// `null` qaytaradi (verify rad qilinadi). Hech qanday "memory fallback" yo'q —
// aks holda single-instance zaifligi qaytib kelardi.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface AuthChallengeEntry {
  value: string;
  origin?: string;
  rpID?: string;
}

/**
 * Challenge'ni saqlaydi (single-use, TTL bilan). Redis yo'q/ulanmagan bo'lsa
 * `false` — ya'ni challenge berilmadi (fail closed).
 */
export async function setAuthChallenge(
  key: string,
  value: string,
  rp?: { origin?: string; rpID?: string },
  ttlMs: number = CHALLENGE_TTL_MS
): Promise<boolean> {
  if (!isRedisConfigured() || !isRedisReady()) {
    console.warn('[AUTH] Redis challenge store tayyor emas — challenge berilmadi (fail closed).');
    return false;
  }
  const payload: AuthChallengeEntry = { value, origin: rp?.origin, rpID: rp?.rpID };
  try {
    // Challenge `wa:...` kalitlari bilan boshlanadi; prefix ajratish uchun
    // namespace qo'shiladi (rate limit kalitlari bilan to'qnashmasin).
    await redis.set(`wa:challenge:${key}`, JSON.stringify(payload), 'PX', ttlMs);
    return true;
  } catch (err) {
    console.warn('[AUTH] Challenge yozilmadi:', (err as Error).message);
    return false;
  }
}

/**
 * Challenge'ni oladi va DARHOL o'chiradi (single-use, replay himoyasi).
 * Redis yo'q/ulanmagan yoki kalit yo'q/expired bo'lsa — `null` (fail closed).
 */
export async function consumeAuthChallenge(key: string): Promise<AuthChallengeEntry | null> {
  if (!isRedisConfigured() || !isRedisReady()) {
    console.warn('[AUTH] Redis challenge store tayyor emas — challenge tekshirilmadi (fail closed).');
    return null;
  }
  try {
    // GETDEL = atomik "ol + o'chir" (Redis >= 6.2). eski Redis'da
    // GETDEL ishlamasa — quyidagi zaxira yo'l (GET + DEL) ishlatiladi.
    let raw: string | null = null;
    try {
      raw = await redis.call('GETDEL', `wa:challenge:${key}`) as string | null;
    } catch {
      const value = await redis.get(`wa:challenge:${key}`);
      if (value) await redis.del(`wa:challenge:${key}`);
      raw = value;
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthChallengeEntry;
    if (!parsed?.value) return null;
    return parsed;
  } catch (err) {
    console.warn('[AUTH] Challenge o\'qilmadi:', (err as Error).message);
    return null;
  }
}

export { redis as redisClient };
