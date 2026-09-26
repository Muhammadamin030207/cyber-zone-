import { Request, Response, NextFunction } from 'express';
import { requestIdOf } from './requestContext';

/**
 * XATO QAYTARISH (spec §42/§56)
 *
 * - Foydalanuvchiga HECH QACHON stack/traceback/SQL/secret chiqarilmaydi.
 * - 5xx uchun javob faqat umumiy xabar + `requestId` (foydalanuvchi supportga
 *   bersa, loglar orqali aniq topiladi).
 * - To'liq tafsilot STRUCTURED logga yoziladi: requestId, userId, method,
 *   path, provider, exception nomi va xabari, timestamp.
 * - maxBodySize/type validator xatolari ham foydalanuvchiga tushunarli qaytadi.
 */

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  const requestId = requestIdOf(req);
  const userId = (req as any).user?.userId;
  const status = err.status || err.statusCode || 500;

  // Tuzilma (structured) xato logi — hech qanday parol/token/secret yozilmaydi.
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      userId: userId || null,
      method: req.method,
      path: req.originalUrl,
      status,
      prismaCode: err?.code || null,
      errName: err?.name || null,
      message: err?.message || String(err),
      stack: isProd() ? undefined : err?.stack,
      timestamp: new Date().toISOString(),
    })
  );

  // Barchatdan umumiy foydalanuvchiga tushunarli xabar + requestId.
  const body = (status: number, message: string, code?: string) =>
    res.status(status).json({
      success: false,
      message,
      ...(code ? { code } : {}),
      requestId,
    });

  // Prisma: unikal cheklov (masalan idempotency key / provider transaction id)
  if (err?.code === 'P2002') {
    return body(409, 'Bunday ma\'lumot allaqachon mavjud', 'DUPLICATE');
  }
  if (err?.code === 'P2025') {
    return body(404, 'Topilmadi', 'NOT_FOUND');
  }
  if (err?.code === 'P2003') {
    return body(400, 'Bog\'liq ma\'lumot topilmadi yoki noto\'g\'ri', 'FK_VIOLATION');
  }
  // Prisma: jadval/ustun topilmadi yoki sxema sxemasi mos kelmadi.
  // Bu HOLATDA "server xatosi" emas — deployment/migratsiya muammosi; foydalanuvchi
  // uchun umumiy xabar, lekin logda aniq P2022 (audi uchun).
  if (err?.code === 'P2021' || err?.code === 'P2022') {
    return body(503, 'Xizmat vaqtincha to\'g\'rilmoqda. Iltimos, birozdan keyin qayta urinib ko\'ring.', 'SERVICE_MISCONFIGURED');
  }
  // Prisma: timeout / connection cut
  if (err?.code === 'P1001' || err?.code === 'P1002' || err?.code === 'P2024') {
    return body(503, 'Xizmat vaqtincha band. Iltimos, birozdan keyin qayta urinib ko\'ring.', 'DB_UNAVAILABLE');
  }

  // JSON body limit / sintaksis xatolari
  if (err?.type === 'entity.too.large') {
    return body(413, 'Yuborilgan ma\'lumot hajmi juda katta', 'PAYLOAD_TOO_LARGE');
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return body(400, 'So\'rov tanasi noto\'g\'ri JSON formatda', 'INVALID_JSON');
  }

  // Fayl yuklash (multer) xatolari — 400
  if (err?.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'Fayl hajmi 5MB dan oshmasligi kerak'
      : 'Fayl yuklashda xatolik yuz berdi';
    return body(400, msg, 'UPLOAD_FAILED');
  }
  if (err?.message && /yuklash mumkin|rasm/.test(err.message)) {
    return body(400, err.message, 'INVALID_FILE');
  }

  if (status >= 500) {
    return body(500, 'Serverda xatolik yuz berdi. Iltimos, birozdan keyin qayta urinib ko\'ring.');
  }
  return body(status, err?.message || 'Noto\'g\'ri so\'rov');
}

export function notFound(req: Request, res: Response) {
  return res.status(404).json({
    success: false,
    message: 'Route topilmadi',
    code: 'NOT_FOUND',
    requestId: requestIdOf(req),
  });
}
