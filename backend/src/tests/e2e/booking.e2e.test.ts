import { describe, it, expect, beforeAll } from 'vitest';
import { api, resetDb as reset, createUserDirect, createRoomFixture, nextIp, prisma } from './helpers';
import { tashkentTodayISO, tashkentDayISO, tashkentNowHHMM, parseTime, minutesToHHMM } from '../../utils/time';
import { config } from '../../config';

function auth(token: string) {
  return `Bearer ${token}`;
}

async function login(email: string, password: string) {
  const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });
  return res.body.data.accessToken as string;
}

async function register(email: string) {
  await api().post('/api/auth/register').set('X-Forwarded-For', nextIp()).send({ email, password: 'secret123', fullName: 'Book User' });
  return login(email, 'secret123');
}

/**
 * E2E DB'sida DEPOSIT_PERCENT ni o'zgartirib bo'lmaydi (env import vaqtida
 * o'qiladi) — shuning uchun testlar joriy config qiymatini (`config.payments.depositPercent`)
 * nazorat qiladi va shu qiymat bo'yicha 30/70 ga teng bo'lishni tekshiradi.
 * Hardcode "30" ishlatilmaydi: agar admin config'ni o'zgartirsa, test ham o'zgaradi.
 */
const PCT = config.payments.depositPercent;

/** Kelajakdagi ish kuni (Toshkent) — "bugun"ga bog'liq bo'lib qolmaslik uchun. */
function futureWorkDate(): string {
  return tashkentDayISO(3);
}

describe('E2E: Bron yaratish — server avtoriteti, depozit 30/70, idempotency, concurrency', () => {
  let room: any;
  let zone: any;
  let pc: any;
  let token: string;

  beforeAll(async () => {
    await reset();
    const admin = await createUserDirect({ email: 'book-admin@e2e.test', password: 'secret123', role: 'SUPER_ADMIN' });
    const fixture = await createRoomFixture(admin!.id);
    room = fixture.room;
    zone = fixture.zone;
    pc = await prisma.computer.create({
      data: { zoneId: zone.id, name: 'PC-B1', status: 'AVAILABLE', specs: {} },
    });
    token = await register('book-user@e2e.test');
  });

  const pricePerHour = () => Number(zone.pricePerHour);

  it('depozit server hisoblaydi: final = advance + remaining, foiz config\'dan', async () => {
    const res = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date: futureWorkDate(), startTime: '10:00', durationHours: 2 });

    expect(res.status).toBe(201);
    const b = res.body.data;
    const total = pricePerHour() * 2;
    expect(Number(b.totalPrice)).toBe(total);
    expect(Number(b.finalPrice)).toBe(total);
    expect(Number(b.depositPercent)).toBe(PCT);
    expect(Number(b.advanceAmount)).toBe(Math.round(total * PCT) / 100);
    expect(Number(b.remainingAmount)).toBe(total - Math.round(total * PCT) / 100);
    // ENG MUHIM: hech qanday yo'zuvda "yo'qotish" yo'q
    expect(Number(b.advanceAmount) + Number(b.remainingAmount)).toBe(Number(b.finalPrice));
  });

  it('frontend yuborgan narx/foiz butunlay e\'tiborsiz qoldiriladi', async () => {
    const res = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({
        roomId: room.id,
        zoneId: zone.id,
        computerId: pc.id,
        date: futureWorkDate(),
        startTime: '12:00',
        durationHours: 1,
        // HUJUMATLI: frontend o'ziga xosh narx/foiz yuboradi
        totalPrice: 1,
        finalPrice: 1,
        advanceAmount: 0,
        remainingAmount: 999999,
        depositPercent: 100,
        pricePerHour: 1,
      });

    expect(res.status).toBe(201);
    const b = res.body.data;
    const total = pricePerHour() * 1;
    expect(Number(b.totalPrice)).toBe(total);
    expect(Number(b.finalPrice)).toBe(total);
    expect(Number(b.advanceAmount)).toBe(Math.round(total * PCT) / 100);
    expect(Number(b.remainingAmount)).toBe(total - Math.round(total * PCT) / 100);
    expect(Number(b.depositPercent)).toBe(PCT);
  });

  it('durationHours backend tomondan endTime hisoblaydi (frontend yubormaydi)', async () => {
    const res = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date: futureWorkDate(), startTime: '14:00', durationHours: 3 });

    expect(res.status).toBe(201);
    const b = res.body.data;
    expect(b.endTime).toBe('17:00');
    expect(Number(b.durationHours)).toBe(3);
  });

  it('idempotencyKey bilan takroriy so\'rov BIR xil bron qaytaradi (yangisi yaratilmaydi)', async () => {
    const key = `idem-${Date.now()}`;
    // 17:00-18:00 — oldingi testlarning bandlariga USTMA-UST TUSHMAYDI
    const payload = { roomId: room.id, zoneId: zone.id, computerId: pc.id, date: futureWorkDate(), startTime: '17:00', durationHours: 1, idempotencyKey: key };

    const first = await api().post('/api/bookings').set('X-Forwarded-For', nextIp()).set('Authorization', auth(token)).send(payload);
    expect(first.status).toBe(201);

    const second = await api().post('/api/bookings').set('X-Forwarded-For', nextIp()).set('Authorization', auth(token)).send(payload);
    expect(second.status).toBe(201);
    // Ikkalasi BIR xil id -> bitta bron
    expect(second.body.data.id).toBe(first.body.data.id);

    const count = await prisma.booking.count({ where: { userId: first.body.data.userId, idempotencyKey: key } });
    expect(count).toBe(1);
  });

  it('o\'tgan sanaga bron rad etiladi (server vaqt avtoriteti)', async () => {
    const res = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date: '2020-01-01', startTime: '10:00', durationHours: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOOKING_IN_PAST');
  });

  it('ish vaqti tashqarisidagi bron rad etiladi', async () => {
    // Xona ish vaqti 09:00-23:00
    const res = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date: futureWorkDate(), startTime: '07:00', durationHours: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOOKING_OUTSIDE_WORKING_HOURS');
  });

  it('bir xil kompyuter + vaqt oralig\'ida CONCURRENCY: faqat bitta bron yaratiladi', async () => {
    const date = futureWorkDate();
    const body = { roomId: room.id, zoneId: zone.id, computerId: pc.id, date, startTime: '18:00', durationHours: 1 };

    // 5 ta PARALLEL so'rov — race condition bo'lsa 2+ bron yaratilardi
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api().post('/api/bookings').set('X-Forwarded-For', nextIp()).set('Authorization', auth(token)).send(body)
      )
    );

    const created = results.filter((r) => r.status === 201);
    // Kamida bitta muvaffaqiyatli bo'lishi kerak (test flakiness dan qat'i nazar)
    expect(created.length).toBeGreaterThanOrEqual(1);
    // LEKIN bir vaqt oralig'ida faqat BITTA qator bo'lishi kerak.
    // `date` — DateTime tipida, shuning uchun ISO satrga aylantiriladi.
    const overlapping = await prisma.booking.count({
      where: {
        computerId: pc.id,
        date: new Date(`${date}T00:00:00.000Z`),
        status: { in: ['PENDING', 'CONFIRMED', 'PARTIALLY_PAID', 'PAID'] },
        startTime: '18:00',
      },
    });
    expect(overlapping).toBe(1);
  });

  it('booking ID vaqt oralig\'i ch-sqla (adminsayeq) boshqa bron bilan ustma-ust tushmaydi', async () => {
    const date = futureWorkDate();
    const res = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date, startTime: '19:00', durationHours: 1 });

    expect(res.status).toBe(201);
    // 19:00-20:00 band. 19:30 da boshlanuvchi bron ustma-ust tushmasligi kerak
    const overlap = await api()
      .post('/api/bookings')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth(token))
      .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date, startTime: '19:30', durationHours: 1 });

    expect(overlap.status).toBe(400);
  });

  /**
   * TODO-1/2: admin UI aynan shu endpoint'ni chaqiradi va `frontend/src/lib/types.ts`
   * dagi maydonlarga tayanadi. Shu yerda ham KESIB chiqishni (contract drift)
   * oldini olamiz: agar backend maydon nomini/o'zgarishini o'zgartirsa, bu test
   * qizil bo'ladi va frontend build'i emas, CI'ning E2E qismi ushlaydi.
   */
  describe('admin approval endpoint + frontend type contract', () => {
    it('tasdiqlash faqat to\'langan bronda ishlaydi va maydonlar to\'liq qaytadi', async () => {
      const date = futureWorkDate();
      const created = await api()
        .post('/api/bookings')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', auth(token))
        .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date, startTime: '20:00', durationHours: 1 });
      expect(created.status).toBe(201);
      const bookingId = created.body.data.id as string;

      const adminToken = await login('book-admin@e2e.test', 'secret123');
      const authH = auth(adminToken);

      // 1) PENDING bronning to'lovsiz tasdiqlanishi RAD etiladi
      const tooEarly = await api()
        .patch(`/api/bookings/admin/bookings/${bookingId}/approval`)
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', authH)
        .send({ action: 'approve' });
      expect(tooEarly.status).toBe(400);
      expect(tooEarly.body.code).toBe('BOOKING_NOT_PAID');

      // 2) To'lovni tasdiqlaymiz (provider webhook o'rniga — DB orqali)
      await prisma.booking.update({ where: { id: bookingId }, data: { status: 'PAID' } });

      // 3) Endi tasdiqlash ishlaydi
      const approved = await api()
        .patch(`/api/bookings/admin/bookings/${bookingId}/approval`)
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', authH)
        .send({ action: 'approve' });
      expect(approved.status).toBe(200);

      const b = approved.body.data;
      expect(b.approvalStatus).toBe('APPROVED');
      expect(b.approvedAt).toBeTruthy();
      expect(b.approvedById).toBeTruthy();
      expect(b.rejectedAt).toBeNull();
      expect(b.rejectionReason).toBeNull();

      // frontend/src/lib/types.ts `Booking` maydonlari — hammasi bor bo'lishi shart
      for (const field of [
        'id', 'date', 'startTime', 'endTime', 'durationHours',
        'totalPrice', 'discountAmount', 'finalPrice', 'pointsUsed',
        'advanceAmount', 'remainingAmount', 'depositPercent', 'status',
        'holdExpiresAt', 'approvalStatus', 'approvedAt', 'approvedById',
        'rejectedAt', 'rejectedById', 'rejectionReason', 'createdAt',
        'room', 'zone', 'computer', 'user',
      ]) {
        expect(b, `Booking maydoni yo\'q: ${field}`).toHaveProperty(field);
      }
      expect(b.room).toHaveProperty('ownerId');
    });

    it('rad etish sababsiz RAD etiladi; sabab bilan bron yopiladi', async () => {
      const date = futureWorkDate();
      const created = await api()
        .post('/api/bookings')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', auth(token))
        .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date, startTime: '21:00', durationHours: 1 });
      const bookingId = created.body.data.id as string;
      await prisma.booking.update({ where: { id: bookingId }, data: { status: 'PAID' } });

      const adminToken = await login('book-admin@e2e.test', 'secret123');
      const authH = auth(adminToken);

      // Sababsiz rad etish — 400
      const noReason = await api()
        .patch(`/api/bookings/admin/bookings/${bookingId}/approval`)
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', authH)
        .send({ action: 'reject' });
      expect(noReason.status).toBe(400);

      // Sabab bilan — bron yopiladi (UI shu maydonlarni ko'rsatadi)
      const rejected = await api()
        .patch(`/api/bookings/admin/bookings/${bookingId}/approval`)
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', authH)
        .send({ action: 'reject', reason: 'To\'lov hujjati topilmadi' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.approvalStatus).toBe('REJECTED');
      expect(rejected.body.data.status).toBe('CANCELLED');
      expect(rejected.body.data.rejectionReason).toBe('To\'lov hujjati topilmadi');
    });

    it('admin ro\'li emasdagi foydalanuvchi tasdiqlay OLMAYDI (403)', async () => {
      const date = futureWorkDate();
      const created = await api()
        .post('/api/bookings')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', auth(token))
        .send({ roomId: room.id, zoneId: zone.id, computerId: pc.id, date, startTime: '22:00', durationHours: 1 });
      const bookingId = created.body.data.id as string;
      await prisma.booking.update({ where: { id: bookingId }, data: { status: 'PAID' } });

      // Oddiy USER token bilan tasdiqlashga urinish
      const res = await api()
        .patch(`/api/bookings/admin/bookings/${bookingId}/approval`)
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', auth(token))
        .send({ action: 'approve' });
      expect(res.status).toBe(403);
    });
  });
});
