import { Request, Response, NextFunction } from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { config } from '../config';
import prisma from '../lib/prisma';
import { AuthRequest } from '../types';
import { generateTokens } from '../lib/jwt';
import { ok, badRequest, forbidden, notFoundMsg, serverError } from '../utils/response';
import bcrypt from 'bcryptjs';
import { verifyTotp } from '../utils/totp';
import { sendSecurityAlert, clientIp, describeUserAgent, recordSecurityEvent } from '../lib/securityAlerts';
import { setAuthChallenge, consumeAuthChallenge, type AuthChallengeEntry } from '../lib/redis';

// ============ SERVER-SIDE CHALLENGE STORAGE ============
// Challenge faqat serverda saqlanadi — client mustaqil yaratmaydi, signature
// server tomonidan tekshiriladi. Ko'p instansiyali deploy'da (1000+ foydalanuvchi)
// in-memory Map ISHLAMAYDI: "options" instansiya A, "verify" instansiya B
// bo'lsa challenge topilmaydi. Shu sababli Redis (GETDEL, single-use) ishlatiladi.
// Redis tayyor bo'lmasa — FAIL CLOSED: challenge berilmaydi va tekshirilmaydi.
const challengeTTLMs = 5 * 60 * 1000; // 5 daqiqa

function setChallenge(key: string, value: string, rp?: { origin: string; rpID: string }): Promise<boolean> {
  return setAuthChallenge(key, value, rp, challengeTTLMs);
}

/** Challenge + (mavjud bo'lsa) berilgan origin/rpID'ni qaytaradi. Single-use. */
function getChallenge(key: string): Promise<AuthChallengeEntry | null> {
  return consumeAuthChallenge(key);
}

/** Frontend origin — WebAuthn expectedOrigin (mavjud FRONTEND_URLS dan). */
function expectedOrigins(): string[] {
  if (config.webauthn.expectedOrigins.length) return config.webauthn.expectedOrigins;
  return config.frontendUrls;
}

function rpID(): string {
  return config.webauthn.rpID;
}

/**
 * So'rovning Origin header'idan webAuthn rpID/origin qiymatini chiqaradi.
 * Bitta backend bir nechta frontend domain'iga xizmat qiladi va har bir domain
 * uchun passkey o'z rpID'siga bog'langan. Origin faqat ruxsat etilgan ro'yxatdan
 * qabul qilinadi — xorijiy origin uchun passkey berilmaydi (account takeover).
 */
function requestRp(req: Request): { origin: string; rpID: string } | null {
  const origin = req.get('origin');
  if (!origin) return null;
  if (!expectedOrigins().includes(origin)) return null;
  let rpID: string;
  try {
    rpID = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!rpID) return null;
  return { origin, rpID };
}

function rpName(): string {
  return config.webauthn.rpName;
}

// ============ REGISTRATION ============
// POST /api/webauthn/register/options (auth)
export async function registerOptions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');

    // Foydalanuvchi oldin ro'yxatdan o'tgan credentiallari — takroriy ro'yxatdan o'tishni cheklash
    const existing = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { credentialId: true, transports: true },
    });

    const options: PublicKeyCredentialCreationOptionsJSON = await generateRegistrationOptions({
      rpName: rpName(),
      rpID: requestRp(req)?.rpID ?? rpID(),
      userName: user.email,
      userDisplayName: user.fullName,
      userID: Buffer.from(user.id),
      attestationType: 'none',
      timeout: 60_000,
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: Array.isArray(c.transports) ? (c.transports as string[]) : ['internal'],
      })),
      authenticatorSelection: {
        // Discoverable (resident) passkey — email kiritmasdan login qilish uchun
        // shart: brauzer credential'ni RP domeni bo'yicha o'zi topa olishi kerak.
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred',
      },
    });

    // Challenge serverda saqlanadi (clientga berilmaydi)
    const stored = await setChallenge(`reg:${user.id}`, options.challenge, requestRp(req) || undefined);
    if (!stored) {
      return res.status(503).json({
        success: false,
        message: 'Passkey xizmati vaqtincha ishlamoqda. Birozdan keyin qayta urinib ko\'ring.',
      });
    }

    return ok(res, options);
  } catch (err) {
    console.error('[webauthn] register options:', (err as Error).message);
    next(err as Error);
  }
}

// POST /api/webauthn/register/verify (auth)
export async function registerVerify(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { response, deviceName } = req.body;
    if (!response) return badRequest(res, 'WebAuthn response talab qilinadi');
    const userId = req.user!.userId;

    const challenge = await getChallenge(`reg:${userId}`);
    if (!challenge) return badRequest(res, 'Registratsiya challenge muddati o\'tgan. Qayta urinib ko\'ring.');
    const expectedChallenge = challenge.value;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: challenge.origin ?? expectedOrigins(),
        expectedRPID: challenge.rpID ?? rpID(),
        requireUserVerification: false,
      });
    } catch (verifyErr) {
      console.warn('[webauthn] register verify rad etildi:', (verifyErr as Error).message);
      return badRequest(res, 'WebAuthn registratsiyasi tasdiqlanmadi');
    }

    if (!verification.verified || !verification.registrationInfo) {
      return badRequest(res, 'WebAuthn registratsiyasi tasdiqlanmadi');
    }

    const { credential } = verification.registrationInfo;
    const existing = await prisma.passkey.findUnique({
      where: { credentialId: credential.id },
      select: { id: true },
    });
    if (existing) return badRequest(res, 'Ushbu passkey allaqachon ro\'yxatdan o\'tgan');

    // Private key SERVERGA YUBORILMAYDI — faqat public key + counter saqlanadi.
    const passkey = await prisma.passkey.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        deviceName: String(deviceName || '').trim() || 'Yangi qurilma',
        transports: (response.response.transports as string[]) || ['internal'],
        aaguid: verification.registrationInfo.aaguid || '',
      },
    });

    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } });
    if (owner) {
      void recordSecurityEvent(userId, 'PASSKEY_ADDED', {
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { deviceName: passkey.deviceName },
      });
      void sendSecurityAlert(owner.email, owner.fullName, 'PASSKEY_ADDED', {
        ip: clientIp(req),
        device: describeUserAgent(req.headers['user-agent'] as string | undefined),
        userAgent: passkey.deviceName,
        when: new Date(),
      });
    }

    return ok(res, { passkeyId: passkey.id, deviceName: passkey.deviceName }, 'Passkey muvaffaqiyatli qo\'shildi');
  } catch (err) {
    console.error('[webauthn] register verify:', (err as Error).message);
    next(err as Error);
  }
}

// ============ AUTHENTICATION (passwordless / second factor) ============
// POST /api/webauthn/auth/options  (email orqali -> allowed credentials)
export async function authOptions(req: Request, res: Response, next: NextFunction) {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();

    // Email kiritilmagan bo'lsa — DISCOVERABLE (usernavigatsiyasiz) login.
    // allowCredentials bo'sh bo'lgani uchun brauzer shu RP domeniga ro'yxatdan
    // o'tgan passkeylarni o'zi ko'rsatadi va foydalanuvchi tanlaydi.
    // Email majburiy emas (spec §20) — lekin xavfsizlik saqlanadi: foydalanuvchi
    // kriptografik imzo bilan aniqlanadi, mijoz yuborgan userId ishonilmaydi.
    if (!email) {
      const discoverableOptions: PublicKeyCredentialRequestOptionsJSON = await generateAuthenticationOptions({
        rpID: requestRp(req)?.rpID ?? rpID(),
        timeout: 60_000,
        allowCredentials: [],
        userVerification: 'preferred',
      });
      const stored = await setChallenge('auth:discoverable', discoverableOptions.challenge, requestRp(req) || undefined);
      if (!stored) {
        return res.status(503).json({ success: false, message: 'Passkey xizmati vaqtincha ishlamoqda.' });
      }
      return ok(res, { options: discoverableOptions, discoverable: true });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true },
    });
    // Enumeration oldini olish — passkey yo'q userlarga ham generic xato
    if (!user) return badRequest(res, 'Ushbu qurilmada passkey ro\'yxatdan o\'tgan emas');

    const credentials = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { credentialId: true, transports: true },
    });
    if (!credentials.length) {
      return badRequest(res, 'Ushbu qurilmada passkey ro\'yxatdan o\'tgan emas');
    }

    const options: PublicKeyCredentialRequestOptionsJSON = await generateAuthenticationOptions({
      rpID: requestRp(req)?.rpID ?? rpID(),
      timeout: 60_000,
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        type: 'public-key',
        transports: Array.isArray(c.transports) ? (c.transports as string[]) : ['internal'],
      })),
      userVerification: 'preferred',
    });

    const stored = await setChallenge(`auth:${user.id}`, options.challenge, requestRp(req) || undefined);
    if (!stored) {
      return res.status(503).json({ success: false, message: 'Passkey xizmati vaqtincha ishlamoqda.' });
    }

    return ok(res, { options, userId: user.id });
  } catch (err) {
    next(err as Error);
  }
}

// POST /api/webauthn/auth/verify  (authentication assertion + login)
export async function authVerify(req: Request, res: Response, next: NextFunction) {
  try {
    const { response, userId, pendingLoginToken } = req.body;
    if (!response) return badRequest(res, 'WebAuthn javob talab qilinadi');

    // 2-bosqich (PASSKEY_REQUIRED) rejimi: foydalanuvchi oldin email+parol bilan
    // tasdiqlangan, shuning uchun userId berilgan va pending token bilan bog'lanadi.
    const twoFactorMode = Boolean(pendingLoginToken);
    if (twoFactorMode && !userId) return badRequest(res, 'WebAuthn javob talab qilinadi');

    // PASSKEY_REQUIRED (2-bosqich) holatida: password tekshirildi, pending token berildi.
    // Endi bu token shu user uchun va hali amalda ekanini server tekshiradi — boshqa
    // yo'l bilan token berish mumkin emas.
    if (twoFactorMode) {
      try {
        const decoded = jwt.verify(pendingLoginToken, config.jwt.secret as Secret) as {
          type?: string;
          userId?: string;
          exp?: number;
        };
        const okType = decoded.type === 'pending-passkey';
        const okUser = decoded.userId === userId;
        const notExpired = typeof decoded.exp === 'number' && decoded.exp * 1000 > Date.now();
        if (!okType || !okUser || !notExpired) {
          return badRequest(res, 'Sessiya muddati o\'tgan. Qaytadan parol bilan kiring.');
        }
      } catch {
        return badRequest(res, 'Sessiya muddati o\'tgan. Qaytadan parol bilan kiring.');
      }
    }

    const passkey = await prisma.passkey.findUnique({
      where: { credentialId: response.id as string },
    });
    if (!passkey) return badRequest(res, 'Passkey topilmadi');

    // XAVFSIZLIK: oddiy (email'siz) login rejimida mijoz yuborgan userId butunlay
    // ishonchsiz. Foydalanuvchi credential orqali aniqlanadi va kriptografik imzo
    // shu credential'ning egasi ekanini tasdiqlaydi.
    if (twoFactorMode) {
      if (passkey.userId !== userId) return forbidden(res, 'Ushbu passkey boshqa foydalanuvchiga tegishli');
    } else if (response.userHandle) {
      let handleUserId: string;
      try {
        handleUserId = Buffer.from(
          typeof response.userHandle === 'string' ? response.userHandle : Buffer.from(response.userHandle as ArrayBuffer),
        ).toString('utf8');
      } catch {
        return badRequest(res, 'Passkey ma\'lumotlari noto\'g\'ri');
      }
      if (handleUserId !== passkey.userId) return forbidden(res, 'Ushbu passkey boshqa foydalanuvchiga tegishli');
    } else if (userId && userId !== passkey.userId) {
      return forbidden(res, 'Ushbu passkey boshqa foydalanuvchiga tegishli');
    }

    const resolvedUserId = passkey.userId;
    const challenge = await getChallenge(twoFactorMode || userId ? `auth:${resolvedUserId}` : 'auth:discoverable');
    if (!challenge) return badRequest(res, 'Authentication challenge muddati o\'tgan. Qayta urinib ko\'ring.');
    const expectedChallenge = challenge.value;

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: challenge.origin ?? expectedOrigins(),
        expectedRPID: challenge.rpID ?? rpID(),
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
        },
        requireUserVerification: false,
      });
    } catch (verifyErr) {
      console.warn('[webauthn] auth verify rad etildi:', (verifyErr as Error).message);
      return badRequest(res, 'Passkey tekshiruvidan o\'tmadi');
    }

    if (!verification.verified) return badRequest(res, 'Passkey tekshiruvidan o\'tmadi');

// Replay himoyasi: counter monotonik o'sishi shart. Ayrim authenticatorlar
    // (ayniqsa security key'lar) counterni qo'llamaydi — shunda newCounter 0 qaytadi
    // va biz uni bloklamaymiz, aks holda egalik zaxirasida (clone) teng counter bo'ladi.
    if (
      verification.authenticationInfo.newCounter !== 0 &&
      verification.authenticationInfo.newCounter <= Number(passkey.counter)
    ) {
      return badRequest(res, 'Passkey qayta ishlatilgan. Yangi imkoniyat kun bosing.');
    }

    const user = await prisma.user.findUnique({ where: { id: resolvedUserId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');
    if (user.status !== 'ACTIVE') return forbidden(res, 'Foydalanuvchi bloklangan');

    await prisma.passkey.update({
      where: { id: passkey.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    const tokens = generateTokens({ userId: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion });

    // Vaqtinchalik parol/temp bosqich bekor bo'lmagan bo'lsa (forgot->passkey) yangi parol majburiy
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
    console.error('[webauthn] auth verify:', (err as Error).message);
    next(err as Error);
  }
}

// ============ PASSKEY MANAGEMENT ============
// GET /api/webauthn/passkeys (auth) — o'z passkeylarini ro'yxati
export async function listPasskeys(req: AuthRequest, res: Response, _next: NextFunction) {
  try {
    const passkeys = await prisma.passkey.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        createdAt: true,
        lastUsedAt: true,
        aaguid: true,
      },
    });
    return ok(res, passkeys);
  } catch (err) {
    _next(err as Error);
  }
}

// PATCH /api/webauthn/passkeys/:id (auth) — nomini o'zgartirish
export async function renamePasskey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const passkey = await prisma.passkey.findUnique({ where: { id: req.params.id } });
    if (!passkey) return notFoundMsg(res, 'Passkey topilmadi');
    if (passkey.userId !== req.user!.userId) return forbidden(res, 'Sizga ruxsat berilmagan');

    const deviceName = String(req.body?.deviceName || '').trim().slice(0, 60);
    if (!deviceName) return badRequest(res, 'Qurilma nomi talab qilinadi');

    const updated = await prisma.passkey.update({
      where: { id: passkey.id },
      data: { deviceName },
      select: { id: true, deviceName: true },
    });
    return ok(res, updated, 'Qurilma nomi yangilandi');
  } catch (err) {
    next(err as Error);
  }
}

// DELETE /api/webauthn/passkeys/:id (auth) — o'chirish (revoke)
export async function removePasskey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const passkey = await prisma.passkey.findUnique({ where: { id: req.params.id } });
    if (!passkey) return notFoundMsg(res, 'Passkey topilmadi');
    if (passkey.userId !== req.user!.userId) return forbidden(res, 'Sizga ruxsat berilmagan');

    // Foydalanuvchini hech qanday login usuli qolmaydigan qilmaslik
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    const remaining = await prisma.passkey.count({ where: { userId: req.user!.userId } });
    if (!user?.passwordHash && !user?.googleId && remaining <= 1) {
      return badRequest(res, 'Hisobda boshqa login usuli qolmagan. Avval parol o\'rnating.');
    }

    // Xavfsizlik: passkeyni o'chirishdan oldin qayta autentifikatsiya talab qilinadi.
    // Parol bo'lsa — parol; bo'lmasa lekin 2FA bo'lsa — TOTP kod; ikkisi ham bo'lmasa
    // (masalan faqat Google bilan kirgan) — sessiya egasi yetarli.
    if (user?.passwordHash) {
      const password = String(req.body?.password || '');
      const okPass = password ? await bcrypt.compare(password, user.passwordHash) : false;
      if (!okPass) return badRequest(res, 'Passkeyni o\'chirish uchun joriy parolni kiriting');
    } else if (user?.twoFactorEnabled && user.twoFactorSecret) {
      const code = String(req.body?.code || '');
      if (!code || !verifyTotp(user.twoFactorSecret, code)) {
        return badRequest(res, 'Passkeyni o\'chirish uchun 2FA kodini kiriting');
      }
    }

    await prisma.passkey.delete({ where: { id: passkey.id } });

    if (user) {
      void recordSecurityEvent(user.id, 'PASSKEY_REMOVED', {
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { deviceName: passkey.deviceName },
      });
      void sendSecurityAlert(user.email, user.fullName, 'PASSKEY_REMOVED', {
        ip: clientIp(req),
        device: describeUserAgent(req.headers['user-agent'] as string | undefined),
        userAgent: passkey.deviceName,
        when: new Date(),
      });
    }

    return ok(res, null, 'Passkey o\'chirildi');
  } catch (err) {
    next(err as Error);
  }
}

function sanitizeUser(user: any) {
  const {
    passwordHash,
    resetToken,
    resetTokenExpiresAt,
    tempPasswordHash,
    tempPasswordExpiresAt,
    failedLoginAttempts,
    loginLockStage,
    loginLockedUntil,
    twoFactorSecret,
    twoFactorBackupCodes,
    ...rest
  } = user;
  return rest;
}

// ============ SECURITY POLICY ============
// PATCH /api/webauthn/settings (auth) — passkey bilan kirishni talab qilish/chertish
export async function updateRequirePasskey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { requirePasskey } = req.body;
    if (typeof requirePasskey !== 'boolean') {
      return badRequest(res, 'requirePasskey boolean bo\'lishi kerak');
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return notFoundMsg(res, 'Foydalanuvchi topilmadi');

    if (requirePasskey) {
      // Passkey talab qilish uchun kamida 1 ta passkey bo'lishi shart (hech kim qulfsiz qolmasligi)
      const count = await prisma.passkey.count({ where: { userId: user.id } });
      if (count === 0) {
        return badRequest(res, 'Avval kamida bitta passkey qo\'shing. So\'ng passkey talabini yoqing.');
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { requirePasskey },
    });

    return ok(res, { requirePasskey }, requirePasskey ? 'Passkey tasdiqlash yoqildi' : 'Passkey tasdiqlash o\'chirildi');
  } catch (err) {
    next(err);
  }
}