import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { AuthRequest } from '../types';
import { ok, badRequest, unauthorized, notFoundMsg } from '../utils/response';
import { generateTokens } from '../lib/jwt';
import {
  generateTotpSecret,
  verifyTotp,
  buildOtpAuthUrl,
  generateBackupCodes,
  encryptTotpSecret,
  readTotpSecret,
} from '../utils/totp';
import { sendSecurityAlert, clientIp, describeUserAgent, recordSecurityEvent } from '../lib/securityAlerts';
import { resetData } from '../utils/loginThrottle';
import { recordSuccessfulLogin, sanitizeUser } from './auth.controller';

const ISSUER = 'Cyber-ZONE';

function safeArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * DB'dagi TOTP secret'ni ochib tekshiradi (shifrlangan yoki legacy ochiq —
 * ikkalasi ham qabul qilinadi). Muvaffaqiyatli bo'lsa va qiymat legacy
 * (ochiq) bo'lsa — uni SHIFRLAB qayta yozadi (migratsiya on-the-fly).
 * Qayta yozish muvaffaqiyatsiz bo'lsa login/amalni TOXTAMAYDI (foydalanuvchi
 * allaqachon kodni to'g'ri kiritgan) — faqat logga yoziladi.
 */
async function verifyStoredTotp(user: { id: string; twoFactorSecret: string | null }, code: string): Promise<boolean> {
  const stored = user.twoFactorSecret;
  if (!stored) return false;
  const { secret, needsReencrypt } = readTotpSecret(stored);
  if (!verifyTotp(secret, code)) return false;
  if (needsReencrypt) {
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorSecret: encryptTotpSecret(secret) },
      });
    } catch (err) {
      console.warn('[2FA] Legacy secretni shifrlab saqlab bo\'lmadi:', (err as Error).message);
    }
  }
  return true;
}

/** Backup kodni tekshiradi va ishlatilganini ro'yxatdan olib tashlaydi. */
async function consumeBackupCode(userId: string, stored: unknown, code: string): Promise<boolean> {
  const codes = safeArray(stored);
  const normalized = String(code).trim().toUpperCase();
  for (let i = 0; i < codes.length; i += 1) {
    if (await bcrypt.compare(normalized, codes[i])) {
      const remaining = codes.filter((_, idx) => idx !== i);
      await prisma.user.update({ where: { id: userId }, data: { twoFactorBackupCodes: remaining } });
      return true;
    }
  }
  return false;
}

// ============ GET /api/auth/2fa/status ============
export const twoFactorStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    return ok(res, {
      enabled: user.twoFactorEnabled,
      confirmedAt: user.twoFactorConfirmedAt,
      backupCodesRemaining: safeArray(user.twoFactorBackupCodes).length,
    });
  } catch (err) {
    next(err);
  }
};

// ============ POST /api/auth/2fa/setup ============
// Secret yaratadi (hali yoqilmagan) va otpauth URL qaytaradi. Frontend QR chizadi.
export const setupTwoFactor = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    if (user.twoFactorEnabled) return badRequest(res, '2FA allaqachon yoqilgan');

    const stored = user.twoFactorSecret;
    // DB'da shifrlangan saqlanadi; QR/otpauth uchun foydalanuvchiga ochiq
    // secret qaytariladi (u o'z authenticator'iga qo'yadi). Mavjud bo'lgan
    // (shifrlangan yoki legacy ochiq) secret qayta ishlatiladi.
    const secret = stored ? readTotpSecret(stored).secret : generateTotpSecret();
    if (!stored) {
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorSecret: encryptTotpSecret(secret) },
      });
    }

    return ok(res, {
      secret,
      otpauthUrl: buildOtpAuthUrl(secret, user.email, ISSUER),
      issuer: ISSUER,
      account: user.email,
    }, 'Autentifikator ilovasiga QR kodni skanerlang');
  } catch (err) {
    next(err);
  }
};

// ============ POST /api/auth/2fa/enable ============
// Kod tasdiqlangach 2FA yoqiladi va bir martalik tiklash kodlari beriladi.
export const enableTwoFactor = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const code = String(req.body?.code || '');
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    if (user.twoFactorEnabled) return badRequest(res, '2FA allaqachon yoqilgan');
    if (!user.twoFactorSecret) return badRequest(res, 'Avval 2FA sozlashni boshlang');

    if (!(await verifyStoredTotp(user, code))) {
      return badRequest(res, "Tasdiqlash kodi noto'g'ri. Vaqtni tekshiring va qayta urinib ko'ring.");
    }

    const backupCodes = generateBackupCodes();
    const hashed = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorConfirmedAt: new Date(),
        twoFactorBackupCodes: hashed,
      },
    });

    void recordSecurityEvent(user.id, 'TWO_FACTOR_ENABLED', {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    void sendSecurityAlert(user.email, user.fullName, 'TWO_FACTOR_ENABLED', {
      ip: clientIp(req),
      device: describeUserAgent(req.headers['user-agent'] as string | undefined),
      when: new Date(),
    });

    return ok(res, { enabled: true, backupCodes }, 'Ikki faktorli himoya yoqildi');
  } catch (err) {
    next(err);
  }
};

// ============ POST /api/auth/2fa/disable ============
// O'chirish uchun joriy TOTP kodi yoki parol (yoki backup kod) talab qilinadi.
export const disableTwoFactor = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const code = req.body?.code !== undefined ? String(req.body.code) : '';
    const password = req.body?.password !== undefined ? String(req.body.password) : '';

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    if (!user.twoFactorEnabled) return badRequest(res, '2FA yoqilmagan');

    let authorized = false;
    if (password && user.passwordHash) {
      authorized = await bcrypt.compare(password, user.passwordHash);
    }
    if (!authorized && code && user.twoFactorSecret) {
      authorized = await verifyStoredTotp(user, code);
    }
    if (!authorized && code) {
      authorized = await consumeBackupCode(user.id, user.twoFactorBackupCodes, code);
    }
    if (!authorized) {
      return badRequest(res, "Parol yoki 2FA kodi noto'g'ri");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorConfirmedAt: null,
        twoFactorBackupCodes: Prisma.DbNull,
        tokenVersion: { increment: 1 },
      },
    });

    void recordSecurityEvent(user.id, 'TWO_FACTOR_DISABLED', {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    void sendSecurityAlert(user.email, user.fullName, 'TWO_FACTOR_DISABLED', {
      ip: clientIp(req),
      device: describeUserAgent(req.headers['user-agent'] as string | undefined),
      when: new Date(),
    });

    return ok(res, { enabled: false }, "Ikki faktorli himoya o'chirildi");
  } catch (err) {
    next(err);
  }
};

// ============ POST /api/auth/2fa/backup-codes ============
// Yangi tiklash kodlari (faqat joriy TOTP kod bilan).
export const regenerateBackupCodes = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const code = String(req.body?.code || '');
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    if (!user.twoFactorEnabled || !user.twoFactorSecret) return badRequest(res, '2FA yoqilmagan');
    if (!(await verifyStoredTotp(user, code))) return badRequest(res, "Kod noto'g'ri");

    const backupCodes = generateBackupCodes();
    const hashed = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: hashed } });

    return ok(res, { backupCodes }, 'Yangi tiklash kodlari yaratildi');
  } catch (err) {
    next(err);
  }
};

// ============ POST /api/auth/2fa/verify ============
// Login 2-bosqichi: pending token + TOTP kod (yoki backup kod) -> haqiqiy tokenlar.
export const verifyTwoFactor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pending = String(req.body?.pendingLoginToken || '');
    const code = String(req.body?.code || '');
    if (!pending || !code) return badRequest(res, 'Token va kod talab qilinadi');

    let decoded: any;
    try {
      decoded = jwt.verify(pending, config.jwt.secret as Secret);
    } catch {
      return unauthorized(res, 'Sessiya muddati tugagan. Iltimos, qaytadan kiring.');
    }
    if (decoded?.type !== 'pending-2fa' || !decoded?.userId) {
      return unauthorized(res, 'Token yaroqsiz');
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    if (user.status !== 'ACTIVE') return unauthorized(res, 'Akkauntingiz bloklangan');
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return badRequest(res, '2FA bu hisobda faol emas');
    }

    let valid = await verifyStoredTotp(user, code);
    if (!valid) {
      valid = await consumeBackupCode(user.id, user.twoFactorBackupCodes, code);
    }
    if (!valid) {
      return badRequest(res, "Kod noto'g'ri. Qayta urinib ko'ring.");
    }

    if (user.failedLoginAttempts || user.loginLockStage || user.loginLockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: resetData() });
    }
    await recordSuccessfulLogin(user, req);

    void recordSecurityEvent(user.id, 'LOGIN_SUCCESS', {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { via: '2fa' },
    });

    const tokens = generateTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    if (user.mustChangePassword) {
      return res.status(200).json({
        success: false,
        code: 'MUST_CHANGE_PASSWORD',
        message: 'Vaqtinchalik parol bilan kirdingiz. Yangi parol o\'rnatishingiz shart.',
        data: { user: sanitizeUser(user), ...tokens, mustChangePassword: true },
      });
    }

    return ok(res, { user: sanitizeUser(user), ...tokens }, 'Xush kelibsiz!');
  } catch (err) {
    next(err);
  }
};
