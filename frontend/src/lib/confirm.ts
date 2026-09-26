'use client';

import { create } from 'zustand';

export interface ConfirmInput {
  label?: string;
  placeholder?: string;
  /** true bo'lsa — bo'sh qiymat bilan tasdiqlashga BO'LMAYDI. */
  required?: boolean;
  maxLength?: number;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Matn kiritish maydoni. Masalan: bron rad etish SABABI majburiy
   * (backend `reason` bo'lmasa 400 qaytaradi) — shuning uchun oddiy
   * boolean confirm yetarli emas.
   */
  input?: ConfirmInput;
}

export interface ConfirmResult {
  ok: boolean;
  value: string;
}

interface ConfirmRequest extends ConfirmOptions {
  id: string;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolver: ((r: ConfirmResult) => void) | null;
  open: (opts: ConfirmOptions) => Promise<ConfirmResult>;
  close: (r: ConfirmResult) => void;
}

let counter = 0;

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  request: null,
  resolver: null,
  open: (opts) =>
    new Promise<ConfirmResult>((resolve) => {
      set({
        request: { ...opts, id: `confirm-${++counter}-${Date.now()}` },
        resolver: resolve,
      });
    }),
  close: (r) => {
    const { resolver } = get();
    set({ request: null, resolver: null });
    resolver?.(r);
  },
}));

/**
 * Oddiy tasdiqlash — `true` / `false` (eski API, o'zgarishsiz).
 * `input.required` so'ralgan bo'lsa, bo'sh qiymat bilan tasdiqlashga bo'lmaydi.
 */
export async function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const r = await useConfirmStore.getState().open(opts);
  if (!r.ok) return false;
  if (opts.input?.required && !r.value.trim()) return false;
  return true;
}

/**
 * Matn so'raydigan tasdiqlash (masalan rad etish sababi).
 * Kiritilgan qiymatni qaytaradi, bekor qilinsa `null`.
 */
export async function promptDialog(opts: ConfirmOptions): Promise<string | null> {
  const r = await useConfirmStore.getState().open({ ...opts, input: { ...opts.input, required: true } });
  if (!r.ok) return null;
  return r.value.trim();
}
