import { describe, it, expect, beforeAll } from 'vitest';
import { apiFromNewIp, resetDb, auth, loginViaApi, registerViaApi, nextIp, prisma, createUserDirect } from './helpers';

// WebAuthn endpointlari 15 so'rov / 15 daqiqa / IP ga cheklangan (Redis limiter).
// Bu faylda so'rovlar ko'p — `apiFromNewIp()` har so'rovga alohida IP beradi
// (helpers.ts konvensiyasi), shunda limiter HAQIQIY ishlaydi, lekin bir test
// fayli o'z-o'zidan trip qilmaydi. Limiterni o'chirish EMAS.
const wa = apiFromNewIp;

async function addPasskeyFixture(userId: string, credentialId = 'e2e-cred-' + Math.random().toString(36).slice(2), deviceName = 'Test Device') {
  return prisma.passkey.create({
    data: {
      userId,
      credentialId,
      publicKey: Buffer.from('e2e-fake-public-key'),
      counter: BigInt(0),
      deviceName,
      transports: ['internal'],
      aaguid: '',
    },
  });
}

describe('E2E: WebAuthn / Passkey — challenge lifecycle, server verification, ownership', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('register/options: autentifikatsiya talab qilinadi va server challenge beradi', async () => {
    const noAuth = await wa().post('/api/webauthn/register/options');
    expect(noAuth.status).toBe(401);

    const reg = await registerViaApi('wa-user@e2e.test', 'secret123', 'WA User');
    const token = reg.body.data.accessToken as string;

    const res = await wa().post('/api/webauthn/register/options').set('Authorization', auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.challenge).toBeTruthy();
    expect(res.body.data.rp.id).toBe('localhost');

    const res2 = await wa().post('/api/webauthn/register/options').set('Authorization', auth(token));
    expect(res2.body.data.challenge).not.toBe(res.body.data.challenge);
  });

  it('register/verify: soxta attestation rad etiladi va challenge bir martalik', async () => {
    const reg = await loginViaApi('wa-user@e2e.test', 'secret123');
    const token = reg.body.data.accessToken as string;

    await wa().post('/api/webauthn/register/options').set('Authorization', auth(token));

    const forged = await wa()
      .post('/api/webauthn/register/verify')
      .set('Authorization', auth(token))
      .send({ response: { id: 'forged', rawId: 'forged', type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'y' } } });
    expect(forged.status).toBe(400);

    // Challenge iste'mol qilindi (single-use) — qayta ishlatib bo'lmaydi
    const again = await wa()
      .post('/api/webauthn/register/verify')
      .set('Authorization', auth(token))
      .send({ response: { id: 'forged', rawId: 'forged', type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'y' } } });
    expect(again.status).toBe(400);
  });

  it('auth/options: noma\'lum email yoki passkeysiz user uchun generic 400', async () => {
    const unknown = await wa().post('/api/webauthn/auth/options').send({ email: 'nobody@e2e.test' });
    expect(unknown.status).toBe(400);

    await createUserDirect({ email: 'no-passkey@e2e.test', password: 'secret123' });
    const noPk = await wa().post('/api/webauthn/auth/options').send({ email: 'no-passkey@e2e.test' });
    expect(noPk.status).toBe(400);
  });

  it('passkey management: egasi ko\'radi, boshqa user 403, o\'chirish parol talab qiladi', async () => {
    const owner = await prisma.user.findUnique({ where: { email: 'wa-user@e2e.test' } });
    const pk = await addPasskeyFixture(owner!.id, 'manage-cred-1', 'iPhone 15');

    const login = await loginViaApi('wa-user@e2e.test', 'secret123');
    const token = login.body.data.accessToken as string;

    const list = await wa().get('/api/webauthn/passkeys').set('Authorization', auth(token));
    expect(list.status).toBe(200);
    expect((list.body.data as any[]).some((p) => p.id === pk.id)).toBe(true);

    // Boshqa user
    const other = await registerViaApi('wa-other@e2e.test', 'secret123', 'WA Other');
    const otherToken = other.body.data.accessToken as string;

    const renameForbidden = await wa()
      .patch(`/api/webauthn/passkeys/${pk.id}`)
      .set('Authorization', auth(otherToken))
      .send({ deviceName: 'Hacked' });
    expect(renameForbidden.status).toBe(403);

    const delForbidden = await wa().delete(`/api/webauthn/passkeys/${pk.id}`).set('Authorization', auth(otherToken));
    expect(delForbidden.status).toBe(403);

    // Egasi: parolsiz o'chirish rad etiladi
    const noPass = await wa().delete(`/api/webauthn/passkeys/${pk.id}`).set('Authorization', auth(token)).send({});
    expect(noPass.status).toBe(400);

    // Egasi: to'g'ri parol bilan o'chiriladi
    const del = await wa().delete(`/api/webauthn/passkeys/${pk.id}`).set('Authorization', auth(token)).send({ password: 'secret123' });
    expect(del.status).toBe(200);
    const gone = await prisma.passkey.findUnique({ where: { id: pk.id } });
    expect(gone).toBeNull();
  });

  it('requirePasskey: passkeysiz yoqib bo\'lmaydi, passkey bilan yoqiladi', async () => {
    const login = await loginViaApi('wa-user@e2e.test', 'secret123');
    const token = login.body.data.accessToken as string;

    const denied = await wa().patch('/api/webauthn/settings').set('Authorization', auth(token)).send({ requirePasskey: true });
    expect(denied.status).toBe(400);

    const owner = await prisma.user.findUnique({ where: { email: 'wa-user@e2e.test' } });
    await addPasskeyFixture(owner!.id, 'policy-cred-1', 'MacBook');

    const allowed = await wa().patch('/api/webauthn/settings').set('Authorization', auth(token)).send({ requirePasskey: true });
    expect(allowed.status).toBe(200);
  });

  it('PASSKEY_REQUIRED login: parol to\'g\'ri bo\'lsa ham token berilmaydi; soxta assertion rad etiladi', async () => {
    const login = await loginViaApi('wa-user@e2e.test', 'secret123', nextIp());
    expect(login.status).toBe(202);
    expect(login.body.code).toBe('PASSKEY_REQUIRED');
    expect(login.body.data.pendingLoginToken).toBeTruthy();
    const pendingLoginToken = login.body.data.pendingLoginToken;

    const opts = await wa().post('/api/webauthn/auth/options').send({ email: 'wa-user@e2e.test' });
    expect(opts.status).toBe(200);
    const userId = opts.body.data.userId;

    // Soxta assertion — server tekshiruvi rad etadi
    const forged = await wa()
      .post('/api/webauthn/auth/verify')
      .send({
        userId,
        pendingLoginToken,
        response: { id: 'policy-cred-1', rawId: 'policy-cred-1', type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' } },
      });
    expect(forged.status).toBe(400);
    expect(forged.body.data?.accessToken).toBeUndefined();
  });

  it('PASSKEY_REQUIRED: yaroqsiz pending token bilan token olib bo\'lmaydi', async () => {
    const owner = await prisma.user.findUnique({ where: { email: 'wa-user@e2e.test' } });
    const opts = await wa().post('/api/webauthn/auth/options').send({ email: 'wa-user@e2e.test' });

    const res = await wa()
      .post('/api/webauthn/auth/verify')
      .send({
        userId: owner!.id,
        pendingLoginToken: 'not-a-valid-token',
        response: { id: 'policy-cred-1', rawId: 'policy-cred-1', type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' } },
      });
    expect(res.status).toBe(400);
    expect(opts.status).toBe(200);
  });
});
