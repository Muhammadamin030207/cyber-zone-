import { Router } from 'express';
import {
  createBooking,
  getMyBookings,
  getBookingById,
  cancelBooking,
  getRoomBookings,
  updateBookingStatus,
  getAvailability,
  startBookingSession,
  endBookingSession,
  getSessionInfo,
  reviewBookingApproval,
} from '../controllers/booking.controller';
import { authenticate, authorize } from '../middlewares/auth';

const router = Router();

// ============ AVAILABILITY (public) ============
router.get('/rooms/:roomId/availability', getAvailability);

// ============ USER ============
// Bron faqat USER rolidagi foydalanuvchilarga ruxsat — admin/super_admin bron qilmaydi
router.post('/', authenticate, authorize('USER'), createBooking);
router.get('/', authenticate, getMyBookings);
router.get('/:id', authenticate, getBookingById);
router.put('/:id/cancel', authenticate, cancelBooking);

// SESSIYA (check-in/check-out) — foydalanuvchi yoki xona egasi/boshqaruvchi boshqara oladi.
router.get('/:id/session', authenticate, getSessionInfo);
router.post('/:id/session/start', authenticate, startBookingSession);
router.post('/:id/session/end', authenticate, endBookingSession);

// ============ ADMIN ============
router.get('/admin/bookings', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), getRoomBookings);
router.patch('/admin/bookings/:id/status', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), updateBookingStatus);
// To'lov/chek ko'rilgach — bron tasdiqlash yoki rad etish (YAGONA yo'l)
router.patch('/admin/bookings/:id/approval', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), reviewBookingApproval);

export default router;