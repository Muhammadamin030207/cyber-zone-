'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useConfirmStore, type ConfirmOptions, type ConfirmResult } from '@/lib/confirm';

/**
 * Dialog ichidagi kiritish qiymati. `key={request.id}` orqali ALMASHGAN
 * so'rovda holat tabiiy ravishda tozalanadi (setState-in-effect kerak emas).
 */
function ConfirmBody({ request, onClose }: { request: ConfirmOptions & { id: string }; onClose: (r: ConfirmResult) => void }) {
  const [value, setValue] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { title, message, confirmLabel, cancelLabel, danger, input } = request;
  const canConfirm = !input?.required || value.trim().length > 0;

  const onConfirm = useCallback(() => {
    if (input?.required && !value.trim()) return;
    onClose({ ok: true, value: value.trim() });
  }, [onClose, input?.required, value]);

  const onCancel = useCallback(() => onClose({ ok: false, value: '' }), [onClose]);

  useEffect(() => {
    // Kiritish so'ralgan bo'lsa maydonga fokus (kichik ekranda klaviatura
    // foydalanuvchi harakatidan keyin ochiladi), aks holda tasdiqlash tugmasi.
    if (input) inputRef.current?.focus();
    else confirmRef.current?.focus();
  }, [input]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby={message ? 'confirm-dialog-desc' : undefined}
      className="relative w-full sm:max-w-sm neo-card rounded-2xl rounded-b-none sm:rounded-2xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 animate-pop max-h-[85dvh] overflow-y-auto"
    >
      <div className="flex items-start gap-4">
        <span
          className={`w-11 h-11 rounded-xl border grid place-items-center shrink-0 ${
            danger ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-yellow-400/10 border-yellow-400/30 text-yellow-300'
          }`}
        >
          <AlertTriangle size={22} />
        </span>
        <div className="min-w-0">
          <h2 id="confirm-dialog-title" className="font-bold text-lg leading-snug break-words">
            {title}
          </h2>
          {message && (
            <p id="confirm-dialog-desc" className="text-sm text-gray-400 mt-1 leading-relaxed break-words">
              {message}
            </p>
          )}
        </div>
      </div>

      {input && (
        <div className="mt-5">
          {input.label && (
            <label htmlFor="confirm-dialog-input" className="block text-sm font-medium text-gray-300 mb-2">
              {input.label}
            </label>
          )}
          <input
            id="confirm-dialog-input"
            ref={inputRef}
            type="text"
            value={value}
            maxLength={input.maxLength ?? 500}
            required={input.required}
            placeholder={input.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canConfirm) onConfirm();
            }}
            className="w-full px-4 py-3 rounded-xl bg-cyber-900/60 border border-neon-cyan/20 text-gray-100 placeholder:text-gray-600 focus:border-neon-cyan/50 focus:outline-none text-base"
          />
        </div>
      )}

      <div className="flex gap-3 mt-6">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl btn-ghost text-sm font-medium"
        >
          {cancelLabel || 'Bekor qilish'}
        </button>
        <button
          type="button"
          ref={confirmRef}
          onClick={onConfirm}
          disabled={!canConfirm}
          className={`flex-1 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            danger
              ? 'bg-red-500/15 border border-red-500/40 text-red-400 hover:bg-red-500/25'
              : 'neon-btn'
          }`}
        >
          {confirmLabel || 'Tasdiqlash'}
        </button>
      </div>
    </div>
  );
}

export default function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const close = useConfirmStore((s) => s.close);

  useEffect(() => {
    if (!request) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, [request]);

  if (!request) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center p-3 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close({ ok: false, value: '' });
      }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <ConfirmBody key={request.id} request={request} onClose={close} />
    </div>
  );
}
