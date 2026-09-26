import { Router } from 'express';
import {
  registerOptions,
  registerVerify,
  authOptions,
  authVerify,
  listPasskeys,
  renamePasskey,
  removePasskey,
  updateRequirePasskey,
} from '../controllers/webauthn.controller';
import { authenticate } from '../middlewares/auth';
import { createRedisRateLimiter } from '../lib/redis';

const router = Router();

// WebAuthn/Passkey endpointlarga ham rate limit — spam/probing oldini olish (max. 15/15min/IP)
const webauthnLimiter = createRedisRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  keyPrefix: 'rl:webauthn',
  message: { success: false, message: "Juda ko'p so'rov. Birozdan so'ng qayta urinib ko'ring." },
});

// Registersiya (auth)
router.post('/register/options', authenticate, webauthnLimiter, registerOptions);
router.post('/register/verify', authenticate, webauthnLimiter, registerVerify);

// Authentication (passkey bilan kirish — parolsiz yoki ikkinchi bosqich)
router.post('/auth/options', webauthnLimiter, authOptions);
router.post('/auth/verify', webauthnLimiter, authVerify);

// Passkey boshqaruvi (faqat egasi)
router.get('/passkeys', authenticate, listPasskeys);
router.patch('/passkeys/:id', authenticate, renamePasskey);
router.delete('/passkeys/:id', authenticate, webauthnLimiter, removePasskey);

// Xavfsizlik qoidalari
router.patch('/settings', authenticate, updateRequirePasskey);

export default router;