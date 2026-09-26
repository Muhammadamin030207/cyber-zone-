import { describe, it, expect, beforeAll } from 'vitest';
import { api, resetDb as reset, createUserDirect, createRoomFixture, nextIp, prisma } from './helpers';
import { tashkentTodayISO, tashkentDayISO, tashkentNowHHMM, parseTime, minutesToHHMM } from '../../utils/time';

function auth(token: string) {
  return `Bearer ${token}`;
}

async function login(email: string, password: string) {
  const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });
  return res.body.data.accessToken;
}

async function register(email: string, phone?: string) {
  await api().post('/api/auth/register').set('X-Forwarded-For', nextIp()).send({ email, password: 'secret123', fullName: 'Sess User' });
  if (phone) await prisma.user.updateMany({ where: { email }, data: { phone } });
  return login(email, 'secret123');
}

describe('E2E: Bron sessiyasi (check-in/check-out, min 1 soat billing)', () => {
  let room: any;
  let zone: any;
  let pc: any;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    await reset();
    const admin = await createUserDirect({ email: 'sess-admin@e2e.test', password: 'secret123', role: 'SUPER_ADMIN' });
    const fixture = await createRoomFixture(admin!.id);
    room = fixture.room;
    zone = fixture.zone;
    pc = await prisma.computer.create({
      data: { zoneId: zone.id, name: 'PC-S', status: 'AVAILABLE', specs: {} },
    });
    userToken = await register('sess-user@e2e.test', '+998700001111');
    userId = (await prisma.user.findUnique({ where: { email: 'sess-user@e2e.test' } }))!.id;
  });

  async function makeConfirmed(durationHours = 2, price = 40000) {
    const total = durationHours * (Number(zone.pricePerHour) || 20000);
    // Sessiya oynasi JORIY Toshkent vaqtiga bog'lanadi — test kechqurun ham,
    // erta tong ham vaqtga bog'liq bo'lib qolmasligi uchun. Sabab: startSessionGate
    // `now >= start` va `now < end` ni tekshiradi; qat'iy "09:00-11:00" faqat
    // ertalab ishga tushsa o'tar edi. Oyna 60 daqiqa — minimal 1 soatlik billing
    // ham shu ichida sig'adi.
    const nowMin = parseTime(tashkentNowHHMM()) ?? 720;
    let startMin = nowMin - 2;
    let dateISO = tashkentTodayISO();
    if (startMin < 0) {
      startMin += 1440;
      dateISO = tashkentDayISO(-1);
    }
    const endMin = startMin + 60;
    return prisma.booking.create({
      data: {
        userId,
        roomId: room.id,
        zoneId: zone.id,
        computerId: pc.id,
        date: new Date(`${dateISO}T00:00:00.000Z`),
        startTime: minutesToHHMM(startMin),
        endTime: minutesToHHMM(endMin),
        durationHours,
        totalPrice: total,
        finalPrice: total,
        advanceAmount: total * 0.3,
        remainingAmount: total * 0.7,
        depositPercent: 30,
        pointsUsed: 0,
        status: 'CONFIRMED',
        // To'lov va tasdiqlash oqimi: "Boshlash" faqat admin tasdig'idan keyin
        // ishlaydi (startSessionGate -> BOOKING_NOT_APPROVED). Odatda to'lov
        // tasdiqlanganda approvalStatus ham APPROVED bo'ladi.
        approvalStatus: 'APPROVED',
      },
    });
  }

  it('check-in: CONFIRMED bronni ACTIVE qiladi, kompyuterni OCCUPIED qiladi', async () => {
    const booking = await makeConfirmed(2);
    const sessionInfo = await api().get(`/api/bookings/${booking.id}/session`).set('Authorization', auth(userToken));
    expect(sessionInfo.status).toBe(200);
    expect(sessionInfo.body.data.session.state).toBe('idle');
    expect(sessionInfo.body.data.session.serverTime).toBeTruthy();

    const startRes = await api().post(`/api/bookings/${booking.id}/session/start`).set('Authorization', auth(userToken));
    expect(startRes.status).toBe(200);
    const { booking: b, session } = startRes.body.data;
    expect(b.status).toBe('ACTIVE');
    expect(b.sessionStartedAt).toBeTruthy();
    expect(session.state).toBe('active');

    const pcAfter = await prisma.computer.findUnique({ where: { id: pc.id } });
    expect(pcAfter!.status).toBe('OCCUPIED');
  });

  it('check-out: min 1 soat hisoblanadi, qo\'shimcha qoldiq PENDING CASH bo\'ladi, kompyuter bo\'shaydi', async () => {
    const booking = await makeConfirmed(2);
    await api().post(`/api/bookings/${booking.id}/session/start`).set('Authorization', auth(userToken));

    const endRes = await api().post(`/api/bookings/${booking.id}/session/end`).set('Authorization', auth(userToken));
    expect(endRes.status).toBe(200);
    const { booking: b, session } = endRes.body.data;
    expect(b.status).toBe('COMPLETED');
    expect(b.sessionEndedAt).toBeTruthy();
    // Elapsed < 60 daqiqa bo'lsa ham — minimal 1 soat hisoblanadi
    expect(b.actualDurationMinutes).toBe(60);
    expect(Number(b.actualPrice)).toBe(20000); // 1 soat × 20 000
    expect(Number(b.billingAdjustment)).toBe(20000); // prepaid 0 → qo'shimcha

    const pendingCash = await prisma.payment.findFirst({
      where: { bookingId: booking.id, status: 'PENDING', method: 'CASH', type: 'REMAINING' },
    });
    expect(pendingCash).toBeTruthy();
    expect(Number(pendingCash!.amount)).toBe(20000);

    const pcAfter = await prisma.computer.findUnique({ where: { id: pc.id } });
    expect(pcAfter!.status).toBe('AVAILABLE');
  });

  it('check-out qisqa sessiyada prepaid ortiqchasini bonus ballga QAYTARADI', async () => {
    const booking = await makeConfirmed(3, 60000);
    // Foydalanuvchi 3 soat uchun to'liq to'lagan (60 000)
    await prisma.payment.create({
      data: { bookingId: booking.id, userId, amount: 60000, type: 'ADVANCE', method: 'PAYME', status: 'COMPLETED' },
    });
    await api().post(`/api/bookings/${booking.id}/session/start`).set('Authorization', auth(userToken));

    const endRes = await api().post(`/api/bookings/${booking.id}/session/end`).set('Authorization', auth(userToken));
    expect(endRes.status).toBe(200);
    const { booking: b, session } = endRes.body.data;
    expect(Number(b.billingAdjustment)).toBe(-40000); // 20000 (1 soat) - 60000 prepaid
    expect(session.refundPoints).toBe(40000);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(Number(user!.loyaltyBalance)).toBe(40000);
    const refundTx = await prisma.loyaltyTransaction.findFirst({
      where: { userId, bookingId: booking.id, type: 'REFUND' },
    });
    expect(refundTx).toBeTruthy();
    expect(refundTx!.amount).toBe(40000);
  });

  it('to\'lanmagan bron uchun check-in rad etiladi (BOOKING_NOT_PAID)', async () => {
    const booking = await prisma.booking.create({
      data: {
        userId, roomId: room.id, zoneId: zone.id, computerId: pc.id,
        date: new Date(`${tashkentTodayISO()}T00:00:00.000Z`),
        startTime: '00:00', endTime: '01:00', durationHours: 1,
        totalPrice: 20000, finalPrice: 20000, advanceAmount: 20000, remainingAmount: 0,
        pointsUsed: 0, status: 'PENDING',
        // Tasdiqlangan, LEKIN to'lanmagan — shuning uchun startSessionGate
        // aynan BOOKING_NOT_PAID qaytarishi kerak (tasdiqlash emas).
        approvalStatus: 'APPROVED',
      },
    });
    const res = await api().post(`/api/bookings/${booking.id}/session/start`).set('Authorization', auth(userToken));
    expect(res.status).toBe(400);
  });
});

describe('E2E: Promo-kod — usageLimitPerUser (1|2|N) va shaxsiy promo-kod', () => {
  let room: any;
  let zone: any;
  let adminToken: string;
  let userToken: string;

  const DATE = '2026-12-20';

  beforeAll(async () => {
    const admin = await createUserDirect({ email: 'promo2-admin@e2e.test', password: 'secret123', role: 'SUPER_ADMIN' });
    adminToken = await login('promo2-admin@e2e.test', 'secret123');
    const fixture = await createRoomFixture(admin!.id);
    room = fixture.room;
    zone = fixture.zone;
    await prisma.computer.create({ data: { zoneId: zone.id, name: 'PC-P', status: 'AVAILABLE', specs: {} } });
    await prisma.computer.create({ data: { zoneId: zone.id, name: 'PC-P2', status: 'AVAILABLE', specs: {} } });
    await prisma.computer.create({ data: { zoneId: zone.id, name: 'PC-P3', status: 'AVAILABLE', specs: {} } });
    userToken = await register('promo2-user@e2e.test', '+998722334455');
  });

  async function book(token: string, key: string, start: string, promo: string) {
    return api().post('/api/bookings').set('Authorization', auth(token)).send({
      roomId: room.id, zoneId: zone.id, date: DATE, startTime: start, durationHours: 5,
      promoCode: promo, idempotencyKey: key,
    });
  }

  it('usageLimitPerUser=2: bitta user 2 marta ishlata oladi, uchinchisi rad etiladi', async () => {
    const created = await api().post('/api/promo').set('Authorization', auth(adminToken)).send({
      code: 'USE2', discountType: 'PERCENTAGE', discountValue: 10, usageLimitPerUser: 2,
      usageScope: 'MULTI_USE', startsAt: '2026-01-01', expiresAt: '2099-01-01',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.usageLimitPerUser).toBe(2);

    const first = await book(userToken, 'use2-1', '09:00', 'USE2');
    expect(first.status).toBe(201);
    expect(first.body.data.promoCodeId).toBeTruthy();

    const second = await book(userToken, 'use2-2', '12:00', 'USE2');
    console.log('USE2-SECOND', second.status, JSON.stringify(second.body).slice(0, 500));
    expect(second.status).toBe(201);

    const third = await book(userToken, 'use2-3', '15:00', 'USE2');
    expect(third.status).toBe(400);
    expect((third.body.message || '') as string).toContain('limiti tugagan');

    const redemptions = await prisma.promoRedemption.count({ where: { promoCode: { code: 'USE2' } } });
    expect(redemptions).toBe(2);
  });

  it('shaxsiy promokod faqat qabul qiluvchiga; boshqasiga rad; o\'zimga limit 1', async () => {
    const created = await api().post('/api/promo').set('Authorization', auth(adminToken)).send({
      code: 'PERSONALX', discountType: 'PERCENTAGE', discountValue: 10,
      isPersonal: true, recipientPhone: '+998722334455',
      usageScope: 'MULTI_USE', startsAt: '2026-01-01', expiresAt: '2099-01-01',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.isPersonal).toBe(true);

    // Qabul qiluvchining /api/promo/me ro'yxatida paydo bo'ladi
    const mine = await api().get('/api/promo/me').set('Authorization', auth(userToken));
    expect(mine.status).toBe(200);
    const found = (mine.body.data as any[]).find((x) => x.code === 'PERSONALX');
    expect(found).toBeTruthy();
    expect(found.remaining).toBe(1);

    // Boshqa foydalanuvchi — rad etiladi
    const strangerToken = await register('promo2-stranger@e2e.test', '+998733334455');
    const forbidden = await book(strangerToken, 'personal-stranger', '09:00', 'PERSONALX');
    expect(forbidden.status).toBe(400);
    expect((forbidden.body.message || '') as string).toContain('shaxsiy va siz uchun emas');

    // Qabul qiluvchi ishlatadi (1 marta), ikkinchisi limit
    const ok = await book(userToken, 'personal-1', '12:00', 'PERSONALX');
    expect(ok.status).toBe(201);
    const again = await book(userToken, 'personal-2', '15:00', 'PERSONALX');
    expect(again.status).toBe(400);
    expect((again.body.message || '') as string).toContain('limiti tugagan');
  });
});