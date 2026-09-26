import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * REQUEST CONTEXT / OBSERVABILITY (spec §42, §60)
 *
 * Har bir so'rovga `requestId` biriktiriladi:
 *  - incoming `x-request-id` header'dan (Vercel/Render/proxy qo'yadi) yoki
 *    yangi UUID yaratiladi;
 *  - javobga `x-request-id` header qo'shiladi — foydalanuvchi/server xatosini
 *    aniq kuzata oladi;
 *  - `X-Request-Id` orqali loglarda boshqariluvchi (trace) bo'ladi.
 *
 * Xavfsizlik: so'rovdan kelgan `x-request-id` ichida newline/CR bo'lsa
 * LOG INJEKSIYASI mumkin — header qiymati qat'iy tekshiriladi va
 * `[\x00-\x1f\x7f]` belgilar chiqarib tashlanadi.
 */
const SAFE_ID = /^[\x21-\x7e]{1,128}$/;

export const REQUEST_ID_HEADER = 'x-request-id';

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const raw = req.headers[REQUEST_ID_HEADER];
  const incoming = Array.isArray(raw) ? raw[0] : raw;
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();

  (req as any).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Sekin so'rovlarni ajratib olamiz (production monitoring uchun).
    const slow = durationMs > 1500;
    const userId = (req as any).user?.userId;
    console.log(
      `[REQ] ${requestId} ${req.method} ${req.originalUrl} -> ${res.statusCode} ` +
        `${durationMs.toFixed(0)}ms${userId ? ` user=${userId}` : ''}${slow ? ' [SLOW]' : ''}`
    );
  });

  next();
}

/** So'rov ID'sini oladi (loglarda ihlol qilinmasligi uchun). */
export function requestIdOf(req: Request): string {
  return String((req as any).requestId || 'unknown');
}
