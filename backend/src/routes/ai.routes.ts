import { Router } from 'express';
import { chat, chatStream } from '../controllers/ai.controller';
import { authenticate } from '../middlewares/auth';
import { createRedisRateLimiter } from '../lib/redis';

const router = Router();

/**
 * POST /api/ai/chat
 * AI yordamchi — { message, history? } (authenticated)
 * Gemini/Claude API xarajatini cheklash uchun alohida rate-limit qo'llanadi.
 * Faqat autentifikatsiyadan o'tgan foydalanuvchilar (o'z bron/to'lov ma'lumotlari bilan).
 */
const aiRate = createRedisRateLimiter({
  windowMs: 60 * 1000,
  limit: 6,
  keyPrefix: 'rl:ai:chat',
  message: { success: false, message: 'Juda ko\'p so\'rov yuborildi. Bir daqiqadan so\'ng qayta urinib ko\'ring.' },
});

router.post('/chat', authenticate, aiRate, chat);
router.post('/chat/stream', authenticate, aiRate, chatStream);

export default router;