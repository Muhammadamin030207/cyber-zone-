import { Router } from 'express';
import { createRedisRateLimiter } from '../lib/redis';
import { register, login, logout, googleLogin, refreshToken, getMe, updateProfile, uploadAvatarImage, changePassword, forgotPassword, resetPassword, setNewPassword, securityEvents, unlockAccount } from '../controllers/auth.controller';
import {
  twoFactorStatus,
  setupTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
  regenerateBackupCodes,
  verifyTwoFactor,
} from '../controllers/twoFactor.controller';
import { authenticate } from '../middlewares/auth';
import { uploadAvatar } from '../middlewares/upload';

const router = Router();

function normalizeEmailKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function clientIpKey(req: any): string {
  // `trust proxy = 1` (server.ts) — req.ip XFF orqali haqiqiy mijoz IP'ni beradi.
  return req.ip || 'unknown';
}

/**
 * Ro'yxatdan o'tish spam himoyasi: IP bo'yicha soatiga cheklangan son
 * (shared NAT — shu sababli keng: 10/soat, kalit — IP).
 */
const registerLimiter = createRedisRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyPrefix: 'rl:register',
  keyGenerator: (req: any) => clientIpKey(req),
  message: { success: false, message: 'Juda ko\'p ro\'yxatdan o\'tish. Birozdan so\'ng qayta urinib ko\'ring.' },
});

/**
 * Login brute-force: GLOBAL EMAS. Kalit — IP + email juftligi. Shu tufayli bitta
 * foydalanuvchi (yoki bitta hisob) urinishlari boshqa foydalanuvchilarni
 * bloklamaydi. Hisob darajasidagi progressiv bloklash DB'da (loginThrottle).
 */
const loginAccountLimiter = createRedisRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyPrefix: 'rl:login:account',
  keyGenerator: (req: any) => `${clientIpKey(req)}:${normalizeEmailKey(req.body?.email)}`,
  message: { success: false, message: "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring." },
});

/** Umumiy IP himoyasi — juda keng (shared NAT/office tarmoqlarni bloklamasligi uchun). */
const loginIpLimiter = createRedisRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 150,
  keyPrefix: 'rl:login:ip',
  keyGenerator: (req: any) => clientIpKey(req),
  message: { success: false, message: "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring." },
});

// Forgot-password spam'i: IP + email juftligi (bir hisobning spam'i boshqalarga tegmaydi)
// Spec §4.0 tavsiyasi: 15 daqiqada 1-2 so'rov/email. 3 tasiga ruxsat — qayta urinish uchun yetarli.
const forgotLimiter = createRedisRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  keyPrefix: 'rl:forgot',
  keyGenerator: (req: any) => `${clientIpKey(req)}:${normalizeEmailKey(req.body?.email)}`,
  message: { success: false, message: "Juda ko'p so'rov. Birozdan so'ng qayta urinib ko'ring." },
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Foydalanuvchi ro'yxatdan o'tish
 */
router.post('/register', registerLimiter, register);

/**
 * POST /api/auth/login
 */
router.post('/login', loginAccountLimiter, loginIpLimiter, login);

/**
 * POST /api/auth/unlock — blokdan chiqarish (Alt+B). Faqat TO'G'RI PAROL bilan
 * tasdiqlangan hisob egasi uchun ishlaydi; IP bo'yicha rate-limit mavjud.
 */
router.post('/unlock', loginAccountLimiter, loginIpLimiter, unlockAccount);

/**
 * POST /api/auth/logout — server-side sessiyani bekor qiladi (tokenVersion++)
 */
router.post('/logout', authenticate, logout);

/**
 * POST /api/auth/login/google
 */
router.post('/login/google', loginAccountLimiter, loginIpLimiter, googleLogin);

/**
 * POST /api/auth/2fa/verify — login 2-bosqichi (TOTP yoki backup kod)
 */
router.post('/2fa/verify', loginAccountLimiter, loginIpLimiter, verifyTwoFactor);

/**
 * GET /api/auth/2fa/status
 */
router.get('/2fa/status', authenticate, twoFactorStatus);

/**
 * POST /api/auth/2fa/setup — secret + otpauth URL (QR frontendda chiziladi)
 */
router.post('/2fa/setup', authenticate, setupTwoFactor);

/**
 * POST /api/auth/2fa/enable — kod tasdiqlangach yoqiladi, backup kodlar qaytadi
 */
router.post('/2fa/enable', authenticate, enableTwoFactor);

/**
 * POST /api/auth/2fa/disable — parol yoki kod bilan o'chiriladi
 */
router.post('/2fa/disable', authenticate, disableTwoFactor);

/**
 * POST /api/auth/2fa/backup-codes — yangi tiklash kodlari
 */
router.post('/2fa/backup-codes', authenticate, regenerateBackupCodes);

/**
 * POST /api/auth/refresh
 */
router.post('/refresh', refreshToken);

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, getMe);

/**
 * GET /api/auth/security/events — oxirgi xavfsizlik voqealari (Security Center)
 */
router.get('/security/events', authenticate, securityEvents);

/**
 * PUT /api/auth/profile — shaxsiy ma'lumotlar (email immutable)
 */
router.put('/profile', authenticate, updateProfile);

/**
 * POST /api/auth/avatar — avatar rasm yuklash (multipart 'file')
 */
router.post('/avatar', authenticate, uploadAvatar.single('file'), uploadAvatarImage);

/**
 * PUT /api/auth/change-password
 */
router.put('/change-password', authenticate, changePassword);

/**
 * POST /api/auth/set-new-password — vaqtinchalik parol bilan kirilgach majburiy yangi parol
 */
router.post('/set-new-password', authenticate, setNewPassword);

/**
 * POST /api/auth/forgot-password
 */
router.post('/forgot-password', forgotLimiter, forgotPassword);

/**
 * POST /api/auth/reset-password
 */
router.post('/reset-password', resetPassword);

export default router;