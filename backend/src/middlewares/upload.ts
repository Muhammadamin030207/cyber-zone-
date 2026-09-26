import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

// Avatar yuklash — lokal uploads/avatars papkasiga (Render'da ephimeral disk, ok)
const uploadsRoot = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(uploadsRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsRoot),
  filename: (_req, file, cb) => {
    // Kengaytma fayl nomidan EMAS — MIME-tipdan olinadi (XSS / path-traversal himoyasi)
    const ext =
      file.mimetype === 'image/jpeg'
        ? '.jpg'
        : file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : '.gif';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

export const uploadAvatar = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Faqat rasm yuklash mumkin (JPG/PNG/WEBP/GIF)'));
  },
});

// Xona rasmlari (cover/gallery) — uploads/rooms papkasiga.
// MIME-dan kengaytma olinadi (path traversal / XSS himoyasi).
const roomsRoot = path.join(process.cwd(), 'uploads', 'rooms');
fs.mkdirSync(roomsRoot, { recursive: true });

const roomsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, roomsRoot),
  filename: (_req, file, cb) => {
    const ext =
      file.mimetype === 'image/jpeg'
        ? '.jpg'
        : file.mimetype === 'image/png'
        ? '.png'
        : file.mimetype === 'image/webp'
        ? '.webp'
        : file.mimetype === 'image/avif'
        ? '.avif'
        : file.mimetype === 'image/gif'
        ? '.gif'
        : '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

export const uploadRoomImage = multer({
  storage: roomsStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Faqat rasm yuklash mumkin (JPG/PNG/WEBP/AVIF/GIF)'));
  },
});

// ============ TO'LOV CHEGI (o'tkazma screenshot / PDF bank cheki) ============
// Bu fayllar ADMIN tomonidan ko'riladi va tasdiqlash qarorida asos bo'ladi.
// MIME tipi "allow list" orqali tekshiriladi — fayl nomi KENGAYMA bo'yicha
// emas, MIME bo'yicha yaratiladi (path traversal / XSS himoyasi).
const evidenceRoot = path.join(process.cwd(), 'uploads', 'evidence');
fs.mkdirSync(evidenceRoot, { recursive: true });

const EVIDENCE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

const evidenceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, evidenceRoot),
  filename: (_req, file, cb) => {
    const ext = EVIDENCE_EXT[file.mimetype] || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

export const uploadPaymentEvidence = multer({
  storage: evidenceStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }, // 8MB, bitta fayl
  fileFilter: (_req, file, cb) => {
    if (EVIDENCE_EXT[file.mimetype]) cb(null, true);
    else cb(new Error('Faqat chek screenshot (JPG/PNG/WEBP) yoki PDF yuklash mumkin'));
  },
});