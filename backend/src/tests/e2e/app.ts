import express from 'express';
import authRoutes from '../../routes/auth.routes';
import roomRoutes from '../../routes/room.routes';
import bookingRoutes from '../../routes/booking.routes';
import promoRoutes from '../../routes/promo.routes';
import paymentRoutes from '../../routes/payment.routes';
import aiRoutes from '../../routes/ai.routes';
import aiConversationsRoutes from '../../routes/aiConversations.routes';
import webauthnRoutes from '../../routes/webauthn.routes';
import userRoutes from '../../routes/user.routes';
import settingsRoutes from '../../routes/settings.routes';
import { errorHandler, notFound } from '../../middlewares/error';
import { requestContext } from '../../middlewares/requestContext';

/**
 * E2E test ilovasi — server.ts bilan bir xil route mount'lari, ammo:
 *  - HTTP listen YO'Q (supertest in-process ishlatadi)
 *  - Socket.io attach YO'Q
 *  - Global IP rate-limit YO'Q (test natijalari deterministik bo'lishi uchun;
 *    per-route login/AI limitlari SAQLANGAN — ular xavfsizlik qoidalari).
 */
export function buildTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/promo', promoRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/ai', aiConversationsRoutes);
  app.use('/api/webauthn', webauthnRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/settings', settingsRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export const testApp = buildTestApp();
