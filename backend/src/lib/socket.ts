import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from '../config';
import { getSharedRedisConnection, isRedisConfigured } from './redis';

// Socket.io server — alohida modul (circular import oldini olish uchun)
export const io = new Server({
  cors: {
    origin: config.frontendUrls,
    credentials: true,
  },
});

/**
 * Ko'p instance (Render/Starter) rejimida Socket.IO'ga Redis adapter ulash.
 *
 * Nima uchun: bir necha instance bo'lganda xabar faqat O'SHANING client
 * process'idagi socket'larga yetib boradi — boshqa instance'da o'tirgan
 * foydalanuvchilar xabar olmaydi. Redis adapter esa barcha node'lar
 * orasidagi xabarlarni tarqatadi (chat, booking, notification).
 *
 * `REDIS_URL` yo'q bo'lsa — hech nima ulanmaydi, single-instance rejimda
 * ishlayveradi (xabar "yo'qolishi" faqat ko'p-instance deploy'da muhim).
 * Har qanday xato — jiddiy emas: warning chiqarib, single-instance rejimda
 * qolamiz (server hech qachon crash bo'lmaydi).
 *
 * ESDA: bu funksiya `server.ts` da chaqirilishi kerak (`io.attach(...)`
 * dan keyin). Hozircha hech kim chaqirmaydi — ulash server.ts egasi.
 *
 * @returns `true` — adapter ulandi, `false` — single-instance rejim.
 */
export async function configureSocketAdapter(server: Server = io): Promise<boolean> {
  if (!isRedisConfigured()) {
    console.warn('[SOCKET] REDIS_URL sozlanmagan — single-instance rejim (ko\'p instance\'da real-time xabarlar yetkazilmaydi).');
    return false;
  }
  try {
    const { pub, sub } = getSharedRedisConnection();
    if (pub.status === 'wait') await pub.connect();
    if (sub.status === 'wait') await sub.connect();
    server.adapter(createAdapter(pub, sub));
    console.log('[SOCKET] Redis adapter ulandi — real-time xabarlar barcha instance\'lar orasida tarqatiladi.');
    return true;
  } catch (err) {
    console.warn('[SOCKET] Redis adapter ulanmadi — single-instance rejimda qolindi:', (err as Error).message);
    return false;
  }
}
