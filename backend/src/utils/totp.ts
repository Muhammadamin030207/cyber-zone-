import crypto from 'crypto';

/**
 * TOTP (RFC 6238) — Google Authenticator / Authy mos keladigan ikki faktorli kod.
 * Tashqi bog'liqlik yo'q: base32 (RFC 4648) + HMAC-SHA1 faqat Node `crypto` bilan.
 * Standart: 6 raqam, 30 sekundlik qadam, ±1 qadam tolerance (soat siljishi uchun).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ============================================================================
// TOTP secret'ni DB'da ENKRIPSIYA (at-rest encryption)
// ============================================================================
// Spec §P2: twoFactorSecret bazaga OCHIQ (plaintext) yozilmaydi — AES-256-GCM
// bilan shifrlanib saqlanadi. Ushbu fayl barcha o'qish (verifyTotp) va yozish
// (encryptTotpSecret) nuqtalarini bitta chokepoint qilib birlashtiradi, shuning
// uchun auth/webauthn/twoFactor controller'larida hech narsa o'zgartirilmaydi.
//
// Mavjud (eski, ochiq) secretlar ham ishlaydi: agar qiymat `ct1:`/`ck1:`
// prefiksiga ega bo'lmasa — legacy plaintext deb qabul qilinadi va SHU SECRET
// bilan verify qilinadi (foydalanuvchi kodini kiritishi shart emas).
// Muvaffaqiyatli keyingi verify'da qiymat `encryptTotpSecret(...)` bilan
// qayta yoziladi (shifrlangan holatga o'tadi).
//
// Kalit manbasi: `TOTP_AT_REST_KEY` — 32+ belgi. O'rnatilmagan yoki qisqa
// bo'lsa — `totpAtRestKey()` JAZIBAT qiladi: zaif fallback (JWT_SECRET yoki
// dev constanti) ISHLATILMAYDI, aks holda DB'dagi 2FA secret'lari taxmin
// qilinadigan kalit bilan "shifrlangan" bo'lib qolardi. Render'da bu qiymat
// `generateValue: true` orqali avtomatik yaratiladi. Kalitni almashtirish =
// DB'dagi barcha shifrlangan secret'lar buziladi (2FA qayta o'rnatiladi).
export const TOTP_AT_REST_KEY_MIN_LENGTH = 32;

const TOTP_ENC_PREFIX = 'ct1:';

const TOTP_ENC_VERSIONS: Record<string, string> = {
  // ck1: — birinchi (ishlatilmagan) format; faqat o'qish uchun qo'llab-quvvatlanadi.
  'ck1:': 'cyber-zone:totp-at-rest:v1',
  // ct1: — joriy format: ct1:<base64(iv[12] || tag[16] || ciphertext)>
  [TOTP_ENC_PREFIX]: 'cyber-zone:totp-at-rest:v2',
};

function totpAtRestKey(info: string): Buffer {
  const raw = String(process.env.TOTP_AT_REST_KEY || '').trim();
  if (raw.length < TOTP_AT_REST_KEY_MIN_LENGTH) {
    throw new Error(
      'TOTP_AT_REST_KEY sozlanmagan yoki 32+ belgidan kam. 2FA secretlarini AES-256-GCM bilan ' +
        'shifrlash uchun kamida 32 ta tasodifiy belgi kerak (masalan: openssl rand -base64 32). ' +
        'Zaif fallback kalit ISHLATILMAYDI.',
    );
  }
  return crypto.createHmac('sha256', raw).update(info).digest();
}

/** Kalit konfiguratsiyasini oldindan tekshiradi (server boot'ida chaqirish uchun). */
export function assertTotpAtRestKey(): void {
  totpAtRestKey(TOTP_ENC_VERSIONS[TOTP_ENC_PREFIX]);
}

/** Secret'ni at-rest shifrlab qaytaradi (DB'da mana shu saqlanadi). */
export function encryptTotpSecret(secretBase32: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', totpAtRestKey(TOTP_ENC_VERSIONS[TOTP_ENC_PREFIX]), iv);
  const ct = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ct]).toString('base64');
  return `${TOTP_ENC_PREFIX}${payload}`;
}

function encPrefixOf(stored: string): string | null {
  const prefix = stored.slice(0, 4);
  return Object.prototype.hasOwnProperty.call(TOTP_ENC_VERSIONS, prefix) ? prefix : null;
}

/** Qiymat shifrlangan formatda (ct1:/ck1:) yoki legacy (ochiq) ekanini aniqlaydi. */
export function isEncryptedTotpSecret(stored: string | null | undefined): boolean {
  return encPrefixOf(String(stored || '')) !== null;
}

function decryptWithPrefix(stored: string, prefix: string): string {
  const buf = Buffer.from(stored.slice(prefix.length), 'base64');
  if (buf.length < 28) throw new Error('TOTP secret ciphertext buzuq (juda qisqa)');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    totpAtRestKey(TOTP_ENC_VERSIONS[prefix]),
    iv,
  );
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  if (!plain) throw new Error('TOTP secret ciphertext bo\'sh');
  return plain;
}

/**
 * Shifrlangan secret'ni ochadi. Legacy (ochiq) bo'lsa — o'zini qaytaradi.
 * Ciphertext buzilgan/kalit noto'g'ri bo'lsa — THROW qiladi (jazibatsiz
 * "ochiq" deb qabul qilinmaydi, aks holda buzuq yozuv ham "secret" bo'lib
 * ko'rinib qolardi).
 */
export function decryptTotpSecret(stored: string): string {
  const value = String(stored || '');
  const prefix = encPrefixOf(value);
  if (!prefix) return value; // legacy plaintext
  return decryptWithPrefix(value, prefix);
}

/**
 * DB'dagi qiymatni o'qish uchun yagona nuqta (controller'lar shuni ishlatadi):
 * shifrlangan bo'lsa — ochadi; legacy (ochiq) bo'lsa `needsReencrypt: true`
 * bilan qaytaradi, shunda muvaffaqiyatli verify'dan keyingi yozuvda qiymat
 * avtomatik ravishda shifrlangan holatga o'tadi.
 */
export function readTotpSecret(stored: string | null | undefined): {
  secret: string;
  encrypted: boolean;
  needsReencrypt: boolean;
} {
  const value = String(stored || '');
  const prefix = encPrefixOf(value);
  if (!prefix) return { secret: value, encrypted: false, needsReencrypt: Boolean(value) };
  return { secret: decryptWithPrefix(value, prefix), encrypted: true, needsReencrypt: false };
}

/** Xavfsiz tasodifiy base32 secret (default 20 bayt = 160 bit, RFC tavsiyasi). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Noto\'g\'ri base32 belgi');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Berilgan counter uchun HOTP qiymati (RFC 4226). */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** digits).padStart(digits, '0');
}

/** TOTP kodni hisoblash (default: 30s qadam, 6 raqam). */
export function generateTotp(secretBase32: string, timestampMs = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * Kodni tekshirish. ±1 qadam (±30s) tolerance — foydalanuvchi soati biroz
 * farq qilishi mumkin. Vaqtga bog'liq bo'lmagan taqqoslash ishlatiladi.
 *
 * Birinchi argument DB'dagi qiymat bo'lishi MUMKIN: shifrlangan (`ct1:`) bo'lsa
 * — avtomatik ochiladi, legacy ochiq bo'lsa — o'zicha ishlatiladi. Shu sabab
 * bu funksiya barcha call-site'lar (auth/webauthn/twoFactor) uchun xavfsiz
 * chokepoint bo'lib qoladi — hech kim shifrlangan qiymatni base32 deb
 * ishlatmaydi.
 */
export function verifyTotp(
  storedSecret: string,
  token: string,
  opts: { window?: number; stepSeconds?: number; digits?: number; timestampMs?: number } = {}
): boolean {
  const { window = 1, stepSeconds = 30, digits = 6, timestampMs = Date.now() } = opts;
  const normalized = String(token || '').replace(/\D/g, '');
  if (normalized.length !== digits) return false;

  const secretBase32 = isEncryptedTotpSecret(storedSecret) ? decryptTotpSecret(storedSecret) : storedSecret;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  for (let i = -window; i <= window; i += 1) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + i, digits)), Buffer.from(normalized))) {
      return true;
    }
  }
  return false;
}

/** Authenticator ilovasi uchun otpauth:// URI (QR kod shu asosida chiziladi). */
export function buildOtpAuthUrl(secretBase32: string, accountName: string, issuer = 'Cyber-ZONE'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Bir martalik tiklash kodlari (parol o'rniga ishlatiladi). */
export function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}
