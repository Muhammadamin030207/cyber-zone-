import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Backend (Render) origin. Room/avatar rasmlari backend'da `/uploads/...`
 * ko'rinishida saqlanadi, lekin frontend ularni o'z origin'i (Vercel)
 * bo'yicha resolve qiladi -> 404. Shu sabab `/uploads/*` so'rovlari
 * backendga proksi qilinadi (pastdagi `rewrites`).
 *
 * MUHIM: bu URL — maxfiy emas (host), shuning uchun env'dan olinadi.
 * Build paytida `BACKEND_URL` yoki `NEXT_PUBLIC_API_URL` dan olinadi
 * (build'da `process.env` orqali; `NEXT_PUBLIC_*` Vercel'da build env'da
 * bo'lishi shart). Topilmasa — lokal ishlash uchun localhost.
 */
const BACKEND_ORIGIN = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:5000'
).replace(/\/+$/, '');

function remotePattern(origin: string) {
  try {
    const url = new URL(origin);
    return {
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      hostname: url.hostname,
      port: url.port,
      pathname: '/uploads/**',
    };
  } catch {
    return { protocol: 'https' as const, hostname: 'localhost', port: '5000', pathname: '/uploads/**' };
  }
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      // Backend (Render) — absolute URL'dagi rasmlar uchun
      remotePattern(BACKEND_ORIGIN),
    ],
  },
  async rewrites() {
    return {
      // `/uploads/rooms/x.jpg` -> `${BACKEND_ORIGIN}/uploads/rooms/x.jpg`
      // (next/image optimizer ham o'z origin'i orqali so'raydi — shu
      // rewrite optimizer'ga ham kerak, aks holda 400/404).
      afterFiles: [
        {
          source: '/uploads/:path*',
          destination: `${BACKEND_ORIGIN}/uploads/:path*`,
        },
      ],
      // Boshqa narsani backendga proksi qilmaymiz (API frontend orqali
      // axios bilan boradi) — faqat statik fayllar.
      beforeFiles: [],
      fallback: [],
    };
  },
};

export default withNextIntl(nextConfig);
