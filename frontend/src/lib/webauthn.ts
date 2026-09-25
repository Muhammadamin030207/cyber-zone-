'use client';

import { startRegistration, startAuthentication, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export interface PasskeyRecord {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt?: string | null;
  aaguid?: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIConversation {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AIMessage[];
}

/** Brauzer platforma authenticator (Face ID/Fingerprint/Windows Hello) qo'llab-quvvatlanadimi? */
export async function supportsBiometric(): Promise<boolean> {
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

export type BiometricMethod = 'faceid' | 'touchid' | 'fingerprint' | 'android' | 'generic';

export interface BiometricInfo {
  method: BiometricMethod;
  /** Interfeysda ko'rsatiladigan qurilma nomi (masalan "Face ID"). */
  label: string;
}

const hasCameraDevice = (): Promise<boolean> => {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.enumerateDevices) return Promise.resolve(false);
  return md
    .enumerateDevices()
    .then((devices) => devices.some((d) => d.kind === 'videoinput'))
    .catch(() => false);
};

/**
 * Ushbu qurilmada qaysi biometrik usul mavjudligini aniqlaydi:
 * - iPhone/iPad -> Face ID, Mac -> Touch ID
 * - Windows (kamera bor) -> Windows Hello Face, aks holda barmoq izi
 * - Android -> Android biometriya
 * WebAuthn o'zi OS so'rovini (yuz/parol/barmoq) ochadi — bu faqat
 * interfeysda to'g'ri belgi va yozuv ko'rsatish uchun.
 */
export async function detectBiometric(): Promise<BiometricInfo> {
  const s = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const maxTouch = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0;

  // Zamonaviy iPad'lar (desktop UA bilan "Macintosh" deb qaytaradi) — sensor orqali aniqlaymiz
  const isIPad = /iPad/.test(s) || (/Macintosh/.test(s) && maxTouch > 1 && !/Windows/.test(s));

  if (/iPhone/.test(s)) return { method: 'faceid', label: 'Face ID' };
  if (isIPad) return { method: 'faceid', label: 'Face ID' };
  if (/Mac/.test(s)) return { method: 'touchid', label: 'Touch ID' };

  if (s.includes('Android')) return { method: 'android', label: 'Android biometriya' };

  if (/Windows/.test(s)) {
    const hasCamera = await hasCameraDevice();
    return hasCamera
      ? { method: 'faceid', label: 'Windows Hello (Face ID)' }
      : { method: 'fingerprint', label: 'Windows Hello (barmoq izi)' };
  }

  return { method: 'generic', label: 'Biometrik qurilma' };
}

export async function platformName(): Promise<string> {
  const info = await detectBiometric();
  if (info.method === 'android') return 'Android biometriya';
  if (info.method === 'touchid') return 'Apple Touch ID';
  if (info.method === 'fingerprint') return 'Windows Hello (barmoq izi)';
  if (info.method === 'generic') return 'Biometrik qurilma';
  return info.label;
}

// ============ REGISTRATION (passkey qo'shish) ============
export async function addPasskey(deviceName?: string): Promise<PasskeyRecord> {
  const { data: optsData } = await api.post<{ success: boolean; data: any }>('/api/webauthn/register/options');
  const assertion = await startRegistration({ optionsJSON: optsData.data });
  const { data: results } = await api.post<{ success: boolean; data: PasskeyRecord; message?: string }>(
    '/api/webauthn/register/verify',
    { response: assertion, deviceName: deviceName || (await platformName()) }
  );
  return results.data;
}

// ============ PASSWORDLESS LOGIN (passkey faqat) ============
// Login sahifasi: email -> options -> brauzer so'rovi -> verify -> session.
export async function passwordlessLogin(email: string): Promise<{ success: boolean; message?: string; code?: string }> {
  const { data } = await api.post<{ success: boolean; data: { options: any; userId: string } }>('/api/webauthn/auth/options', { email });
  const assertion = await startAuthentication({ optionsJSON: data.data.options });
  const verifyRes = await api.post<
    { success: boolean; data: { user: any; accessToken: string; refreshToken: string }; message?: string; code?: string }
  >('/api/webauthn/auth/verify', { response: assertion, userId: data.data.userId });
  if (verifyRes.data?.data?.accessToken) {
    useAuthStore.getState().setAuth(verifyRes.data.data);
  }
  return { success: true, code: verifyRes.data?.code, message: verifyRes.data?.message };
}

// ============ FACE ID BILAN KIRISH — email majburiy EMAS (spec §20) ============
// Discoverable (usernavigatsiyasiz) passkey: allowCredentials bo'sh bo'lgani uchun
// brauzer shu domen uchun saqlangan passkeylarni o'zi ko'rsatadi. Foydalanuvchi
// Face ID / Touch ID / Windows Hello bilan tasdiqlaydi — email kiritilmaydi.
// Xavfsizlik: foydalanuvchi credential orqali kriptografik imzo bilan aniqlanadi.
export async function biometricLogin(): Promise<{ success: boolean; message?: string; code?: string }> {
  if (!window.PublicKeyCredential) {
    return { success: false, message: 'Bu brauzer WebAuthnni qo\'llamaydi' };
  }
  const { data } = await api.post<{ success: boolean; data: { options: any; discoverable: boolean } }>(
    '/api/webauthn/auth/options',
    {}
  );
  const assertion = await startAuthentication({ optionsJSON: data.data.options });
  const verifyRes = await api.post<
    { success: boolean; data: { user: any; accessToken: string; refreshToken: string }; message?: string; code?: string }
  >('/api/webauthn/auth/verify', { response: assertion });
  if (verifyRes.data?.data?.accessToken) {
    useAuthStore.getState().setAuth(verifyRes.data.data);
  }
  return { success: true, code: verifyRes.data?.code, message: verifyRes.data?.message };
}

// ============ SECOND STEP (paroldan keyin passkey, PASSKEY_REQUIRED) ============
// Server parolni tasdiqladi (pendingLoginToken) — endi passkey ham talab qilinadi.
export async function finishPasskeyLogin(
  email: string,
  pendingLoginToken: string
): Promise<{ success: boolean; message?: string; code?: string }> {
  const { data } = await api.post<{ success: boolean; data: { options: any; userId: string } }>(
    '/api/webauthn/auth/options',
    { email }
  );
  const assertion = await startAuthentication({ optionsJSON: data.data.options });
  const verifyRes = await api.post<
    { success: boolean; data: { user: any; accessToken: string; refreshToken: string; mustChangePassword?: boolean }; message?: string; code?: string }
  >('/api/webauthn/auth/verify', {
    response: assertion,
    userId: data.data.userId,
    pendingLoginToken,
  });
  if (verifyRes.data?.data?.accessToken) {
    useAuthStore.getState().setAuth(verifyRes.data.data);
  }
  return {
    success: !!verifyRes.data?.data?.accessToken,
    code: verifyRes.data?.code,
    message: verifyRes.data?.message,
  };
}