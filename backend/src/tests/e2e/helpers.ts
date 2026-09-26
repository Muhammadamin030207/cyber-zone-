import request from 'supertest';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { testApp } from './app';

export const api = () => request(testApp);

/** Barcha bog'liq jadvallarni tozalaydi (faqat E2E DB'da — FK cascade). */
export async function resetDb() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
}

// Har bir so'rovga alohida IP — per-IP limitlar bir-biriga xalaqit bermasin.
let ipCounter = 0;
export function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 8) % 250}.${ipCounter % 250}.7`;
}

/**
 * So'rovga ALOHIDA IP qo'shadi (per-IP Redis rate limiterlar test faylda
 * trip qilmasligi uchun). Limiter O'CHIRILMAYDI — u haqiqatan ishlaydi,
 * faqat har so'rov boshqa mijoz sifatida ko'rinadi.
 *
 * Foydalanish: `await apiFromNewIp().post('/api/x').send({...})`
 */
export function apiFromNewIp() {
  const agent = request(testApp);
  const ip = nextIp();
  const withIp = (t: request.Test) => t.set('X-Forwarded-For', ip);
  return {
    get: (u: string) => withIp(agent.get(u)),
    post: (u: string) => withIp(agent.post(u)),
    put: (u: string) => withIp(agent.put(u)),
    patch: (u: string) => withIp(agent.patch(u)),
    delete: (u: string) => withIp(agent.delete(u)),
  };
}

export function auth(token: string): string {
  return `Bearer ${token}`;
}

export async function registerViaApi(
  email: string,
  password = 'secret123',
  fullName = 'E2E User',
  extra: Record<string, unknown> = {}
) {
  return api().post('/api/auth/register').set('X-Forwarded-For', nextIp()).send({ email, password, fullName, ...extra });
}

export async function loginViaApi(email: string, password: string, ip = nextIp()) {
  return api().post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });
}

export async function createUserDirect(opts: {
  email: string;
  password?: string;
  fullName?: string;
  role?: 'USER' | 'ADMIN' | 'SUPER_ADMIN';
  status?: 'ACTIVE' | 'BLOCKED';
}) {
  const passwordHash = opts.password ? await bcrypt.hash(opts.password, 4) : null;
  return prisma.user.create({
    data: {
      email: opts.email.toLowerCase(),
      passwordHash,
      fullName: opts.fullName || 'Direct User',
      role: opts.role || 'USER',
      status: opts.status || 'ACTIVE',
    },
  });
}

export async function createRoomFixture(ownerId: string) {
  const room = await prisma.computerRoom.create({
    data: {
      ownerId,
      name: 'E2E Room',
      address: 'Toshkent, Test 1',
      city: 'Toshkent',
      status: 'ACTIVE',
      workingHours: { open: '09:00', close: '23:00' },
    },
  });
  const zone = await prisma.zone.create({
    data: { roomId: room.id, type: 'GENERAL_HALL', name: 'Main Hall', pricePerHour: 20000 },
  });
  return { room, zone };
}

export async function createBookingFixture(userId: string, roomId: string, zoneId: string, finalPrice = 100000) {
  const advance = Math.round(finalPrice * 0.3);
  return prisma.booking.create({
    data: {
      userId,
      roomId,
      zoneId,
      date: new Date('2026-12-01'),
      startTime: '14:00',
      endTime: '17:00',
      durationHours: 3,
      totalPrice: finalPrice,
      finalPrice,
      advanceAmount: advance,
      remainingAmount: finalPrice - advance,
      depositPercent: 30,
      status: 'PENDING',
    },
  });
}

export { prisma };
