'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  Loader2,
  MessageSquarePlus,
  Trash2,
  Pencil,
  RefreshCw,
  Copy,
  Check,
  History,
  X,
  PanelLeft,
  CalendarCheck,
  Wallet,
  Clock,
  Gift,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from '@/i18n/navigation';
import api, { getApiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { toastSuccess, toastError } from '@/lib/toast';
import { confirmDialog } from '@/lib/confirm';
import { cn } from '@/lib/utils';
import type { AIConversation, ConversationSummary } from '@/lib/webauthn';

// ============================================================================
// CYBER-ZONE AI — yordamchi (redizayn):
// - LOGO: aniq AI belgisi (luside Sparkles — universal chatbot belgisi, §7.1)
// - YANGI JOY: floating FAB (z-70) + mobil to'liq ekran (z-80)
// - TARIX: conversations/yadro DB'dan (rename/delete/new, history drawer)
// - STREAMING: SSE orqali real-time javob
// - XABAR BOSHQARUVI: edit/delete/regenerate/copy, markdown render
// ============================================================================

const WELCOME = `Salom! Men **Cyber-ZONE AI** yordamchisiman.

Narxlar, xonalar, ish vaqti, promo-kodlar va bron qilish bo'yicha savollaringizga javob beraman. Shuningdek, o'z bronlaringiz va to'lovlaringiz holatini ham ko'rsata olaman.`;

const SUGGESTIONS = [
  { icon: CalendarCheck, label: 'Bugun bron', prompt: 'Bugun bron qilish mumkinmi?' },
  { icon: Wallet, label: 'Narxlar', prompt: 'Qanday narxlar bor?' },
  { icon: Clock, label: 'Ish vaqti', prompt: 'Qaysi vaqtlar bo\'sh?' },
  { icon: Gift, label: 'Promo-kod', prompt: 'Faol promo-kodlar bormi?' },
];

/** AI LOGO — "Sparkles" (AI belgisi, §7.1): markazda katta yulduz + kichik yulduz + nuqta. */
export function AILogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="cz-ai-g-1" x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--acc-a, #10b981)" />
          <stop offset="0.5" stopColor="var(--acc-b, #22d3ee)" />
          <stop offset="1" stopColor="var(--acc-c, #f59e0b)" />
        </linearGradient>
      </defs>
      {/* Markazdagi katta 4-burchakli yulduz (spark) */}
      <path
        d="M24 5 L27.6 20.4 L43 24 L27.6 27.6 L24 43 L20.4 27.6 L5 24 L20.4 20.4 Z"
        fill="url(#cz-ai-g-1)"
      />
      {/* Yuqori o'ngda kichik yulduz */}
      <path
        d="M40 5 L41.9 9.5 L46 11.5 L41.9 13.5 L40 18 L38.1 13.5 L34 11.5 L38.1 9.5 Z"
        fill="var(--acc-b, #22d3ee)"
      />
      {/* Pastki chapda nuqta (spark) */}
      <circle cx="12" cy="35" r="3.4" fill="var(--acc-c, #f59e0b)" />
    </svg>
  );
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767.98px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}

interface UiMsg {
  id: string | null; // DB id (null = hali saqlanmagan/stream)
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  error?: boolean;
  streaming?: boolean;
}

export default function ChatWidget() {
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState(false); // tarix panеli
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMsg[]>([{ id: null, role: 'assistant', text: WELCOME }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [editMsgId, setEditMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [vbHeight, setVbHeight] = useState<number | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);

  // Mobile klaviatura viewport — input fokus bo'lganda (klaviatura ochiq)
  // height ni o'zgartirmaymiz: iOS reflow klaviaturani yopib qo'yadi.
  // zamonaviy brauzerlar interactive-widget=resizes-content bilan o'zi moslashadi.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const onVb = () => {
      const active = document.activeElement as HTMLElement | null;
      if (inputRef.current && active && inputRef.current.contains(active)) return;
      setVbHeight(window.visualViewport!.height);
    };
    window.visualViewport.addEventListener('resize', onVb);
    window.visualViewport.addEventListener('scroll', onVb);
    onVb();
    return () => {
      window.visualViewport?.removeEventListener('resize', onVb);
      window.visualViewport?.removeEventListener('scroll', onVb);
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, open, sending, loadingChat, activeId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editMsgId) setEditMsgId(null);
        else if (drawer) setDrawer(false);
        else {
          setOpen(false);
          toggleRef.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => {
      if (user) inputRef.current?.focus();
    }, 150);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, user, drawer, editMsgId]);

  // Ochilganda suhbatlar ro'yxatini yuklash
  useEffect(() => {
    if (!open || !user) return;
    loadConversations();
  }, [open, user]);

  useEffect(() => {
    return () => streamAbortRef.current?.abort();
  }, []);

  async function loadConversations() {
    setLoadingList(true);
    try {
      const { data } = await api.get<{ success: boolean; data: ConversationSummary[] }>('/api/ai/conversations');
      setConversations(data.data || []);
    } catch {
      setConversations([]);
    } finally {
      setLoadingList(false);
    }
  }

  async function openConversation(id: string) {
    if (loadingChat || sending) return;
    setActiveId(id);
    setLoadingChat(true);
    setDrawer(false);
    setInput('');
    try {
      const { data } = await api.get<{ success: boolean; data: AIConversation }>(`/api/ai/conversations/${id}`);
      const list: UiMsg[] = (data.data.messages || []).map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        text: m.content,
      }));
      setMessages(list.length ? list : [{ id: null, role: 'assistant', text: WELCOME }]);
    } catch (err) {
      toastError(getApiErrorMessage(err, 'Suhbatni ochishda xatolik'));
    } finally {
      setLoadingChat(false);
    }
  }

  async function newConversation() {
    try {
      const { data } = await api.post<{ success: boolean; data: { id: string } }>('/api/ai/conversations', { title: 'Yangi suhbat' });
      setActiveId(data.data.id);
      setMessages([{ id: null, role: 'assistant', text: WELCOME }]);
      setInput('');
      setDrawer(false);
      await loadConversations();
    } catch (err) {
      toastError(getApiErrorMessage(err, 'Yangi suhbat yaratishda xatolik'));
    }
  }

  async function renameConversation(id: string, currentTitle: string) {
    // Native prompt taqiqlangan — o'rniga inline modal (modalPrompt)
    const result = await modalPrompt('Suhbat nomini o\'zgartirish', currentTitle);
    if (result == null) return;
    const name = result.trim();
    if (!name) return;
    try {
      await api.patch(`/api/ai/conversations/${id}`, { title: name });
      toastSuccess('Nomi yangilandi');
      await loadConversations();
    } catch (err) {
      toastError(getApiErrorMessage(err, 'Yangilashda xatolik'));
    }
  }

  async function removeConversation(id: string) {
    const ok = await confirmDialog({
      title: 'Suhbatni o\'chirish',
      message: 'Bu suhbat va uning barcha xabarlari o\'chiriladi. Davom etasizmi?',
      confirmLabel: 'O\'chirish',
      cancelLabel: 'Bekor qilish',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/ai/conversations/${id}`);
      if (activeId === id) {
        setActiveId(null);
        setMessages([{ id: null, role: 'assistant', text: WELCOME }]);
      }
      toastSuccess('Suhbat o\'chirildi');
      await loadConversations();
    } catch (err) {
      toastError(getApiErrorMessage(err, 'O\'chirishda xatolik'));
    }
  }

  /** SSE stream: server javobini real-time qabul qiladigan klient */
  async function send(rawPrompt?: string) {
    const text = (rawPrompt ?? input).trim();
    if (!text || sending || !user) return;
    setInput('');
    setSending(true);

    // 1) Conversation yo'q bo'lsa yaratamiz va activeId ga yozamiz
    let convId = activeId;
    if (!convId) {
      try {
        const { data } = await api.post<{ success: boolean; data: { id: string } }>('/api/ai/conversations', { title: text.slice(0, 40) || 'Yangi suhbat' });
        convId = data.data.id;
        setActiveId(convId);
      } catch (err) {
        toastError(getApiErrorMessage(err, 'Suhbat yaratishda xatolik'));
        setSending(false);
        return;
      }
    }

    const userMsg: UiMsg = { id: null, role: 'user', text };
    setMessages((m) => [...m, userMsg]);
    setMessages((m) => [...m, { id: null, role: 'assistant', text: '', streaming: true, pending: true }]);

    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;
    try {
      // SSE — streaming so'rov (Accept: text/event-stream)
      const resp = await fetch(`${api.defaults.baseURL}/api/ai/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${useAuthStore.getState().token || ''}`,
        },
        body: JSON.stringify({ message: text }),
        signal: ctrl.signal,
      });

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let doneContent = '';
      let streamed = '';

      if (!reader || !resp.ok) {
        setMessages((m) =>
          m.map((mm) => (mm.streaming ? { ...mm, streaming: false, pending: false, text: 'AI xizmatida xatolik. Yana urinib ko\'ring.', error: true } : mm))
        );
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE satrlarni ajratib olamiz: data: {...}\n\n
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
          for (const line of lines) {
            try {
              const payload = JSON.parse(line.slice(6));
              if (payload.type === 'delta') {
                streamed += payload.content || '';
              } else if (payload.type === 'assistant') {
                doneContent = payload.content || '';
              }
            } catch {
              /* noto'g'ri chunk — e'tiborsiz */
            }
          }
        }
        // Real-time: server'ndan kelgan delta bo'laklarini darhol ko'rsatamiz.
        // (Eski server bitta big-chunk `assistant` event yuborsa — doneContent)
        const shown = doneContent || streamed;
        if (shown) {
          setMessages((prev) =>
            prev.map((mm) => (mm.streaming ? { ...mm, text: shown, pending: false, streaming: true } : mm))
          );
        }
      }
    } catch (err: unknown) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      setMessages((m) =>
        m.map((mm) =>
          mm.streaming
            ? { ...mm, streaming: false, pending: false, text: aborted ? 'Javob to\'xtatildi' : getApiErrorMessage(err, 'AI xizmatida vaqtinchalik muammo'), error: !aborted }
            : mm
        )
      );
    } finally {
      streamAbortRef.current = null;
      // Stream tugagach to'liq javobni saqlangan holatiga yozamiz va suhbatlar ro'yxatini yangilaymiz
      const finalMsgs = await api
        .get<{ success: boolean; data: AIConversation }>(`/api/ai/conversations/${convId}`)
        .then((r) => r.data.data.messages)
        .catch(() => null);
      if (finalMsgs && finalMsgs.length) {
        setMessages(finalMsgs.map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', text: m.content })));
      }
      setSending(false);
      loadConversations();
    }
  }

  // ===== XABAR BOSHQARUVI =====
  async function removeMessage(id: string) {
    const ok = await confirmDialog({
      title: 'Xabarni o\'chirish',
      message: 'Bu xabar va undan keyingi barcha xabarlar o\'chiriladi.',
      confirmLabel: 'O\'chirish',
      cancelLabel: 'Bekor qilish',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/ai/messages/${id}`);
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === id);
        return i === -1 ? prev : prev.slice(0, i);
      });
      toastSuccess('Xabar o\'chirildi');
      loadConversations();
    } catch (err) {
      toastError(getApiErrorMessage(err, 'O\'chirishda xatolik'));
    }
  }

  async function regenerateMessage(id: string) {
    if (sending) return;
    setSending(true);
    setMessages((m) =>
      m.map((mm) => (mm.id === id ? { ...mm, streaming: true, pending: true, text: '' } : mm))
    );
    try {
      const { data } = await api.post<{
        success: boolean;
        data: { assistantMessage: { id: string; content: string } };
      }>(`/api/ai/messages/${id}/regenerate`);
      setMessages((m) =>
        m.map((mm) =>
          mm.id === id
            ? { ...mm, streaming: false, pending: false, text: data.data.assistantMessage.content }
            : mm
        )
      );
      loadConversations();
    } catch (err) {
      setMessages((m) =>
        m.map((mm) => (mm.id === id ? { ...mm, streaming: false, pending: false, text: getApiErrorMessage(err, 'Qayta yaratishda xatolik'), error: true } : mm))
      );
      toastError(getApiErrorMessage(err, 'Qayta yaratishda xatolik'));
    } finally {
      setSending(false);
    }
  }

  async function submitEdit(id: string) {
    const content = editText.trim();
    if (!content) return;
    try {
      const { data } = await api.patch<{
        success: boolean;
        data: { editedMessage: { id: string; content: string }; assistantMessage: { id: string; content: string } };
      }>(`/api/ai/messages/${id}`, { content });
      // Tahrirga qadar xabarlar + yangi javob
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === id);
        if (i === -1) return prev;
        const head = prev.slice(0, i);
        return [
          ...head,
          { id: id, role: 'user', text: data.data.editedMessage.content },
          { id: data.data.assistantMessage.id, role: 'assistant', text: data.data.assistantMessage.content },
        ];
      });
      setEditMsgId(null);
      setEditText('');
      loadConversations();
    } catch (err) {
      toastError(getApiErrorMessage(err, 'Tahrirlashda xatolik'));
    }
  }

  async function copyMessage(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toastError('Nusxalash imkoni yo\'q');
    }
  }

  function clearChat() {
    setActiveId(null);
    setMessages([{ id: null, role: 'assistant', text: WELCOME }]);
    setInput('');
  }

  // kichik inline rename modal (native prompt ishlatilmaydi)
  async function modalPrompt(title: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;display:grid;place-items:center;padding:16px';
      const card = document.createElement('div');
      card.style.cssText = 'width:100%;max-width:380px;background:#0d1428;border:1px solid rgba(34,211,238,.3);border-radius:16px;padding:20px';
      const label = document.createElement('div');
      label.textContent = title;
      label.style.cssText = 'font-size:14px;font-weight:700;color:#e6edf7;margin-bottom:10px';
      const inp = document.createElement('input');
      inp.value = initial;
      inp.style.cssText = 'width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#e6edf7;border-radius:10px;padding:10px 12px;font-size:14px;outline:none';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;margin-top:14px;justify-content:flex-end';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Bekor qilish';
      cancelBtn.style.cssText = 'padding:9px 14px;border-radius:10px;font-size:13px;color:#9ca3af;background:transparent;border:1px solid rgba(255,255,255,.12);cursor:pointer';
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Saqlash';
      saveBtn.style.cssText = 'padding:9px 16px;border-radius:10px;font-size:13px;font-weight:700;color:#062028;background:var(--acc-b,#22d3ee);border:none;cursor:pointer';
      let solved = false;
      const done = (v: string | null) => {
        if (solved) return;
        solved = true;
        document.body.removeChild(el);
        el.remove();
        resolve(v);
      };
      cancelBtn.onclick = () => done(null);
      saveBtn.onclick = () => done(inp.value.trim() || null);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(inp.value.trim() || null);
        if (e.key === 'Escape') done(null);
      });
      row.appendChild(cancelBtn);
      row.appendChild(saveBtn);
      card.appendChild(label);
      card.appendChild(inp);
      card.appendChild(row);
      el.appendChild(card);
      card.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('click', () => done(null));
      document.body.appendChild(el);
      setTimeout(() => inp.focus(), 30);
    });
  }

  const chatBusy = sending || loadingChat;

  return (
    <>
      {/* Mobil: to'liq ekran bottom-sheet */}
      {open && isMobile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cyber-ZONE AI yordamchi"
          style={{ height: vbHeight ? `${vbHeight}px` : '100dvh' }}
          className="fixed left-0 bottom-0 w-full z-[80] bg-cyber-950/95 backdrop-blur-xl border-t border-[var(--acc-b)]/25 flex flex-col overflow-hidden"
        >
          <AiHeader
            chatBusy={chatBusy}
            user={!!user}
            drawerOpen={drawer}
            onToggleDrawer={() => setDrawer((d) => !d)}
            onClose={() => setOpen(false)}
            onNew={newConversation}
            onClear={clearChat}
          />
          <div className="flex-1 relative flex overflow-hidden">
            {drawer && (
              <ConvList
                conversations={conversations}
                activeId={activeId}
                loading={loadingList}
                onOpen={openConversation}
                onNew={newConversation}
                onRename={renameConversation}
                onDelete={removeConversation}
              />
            )}
            <AiBody
              bodyRef={bodyRef}
              messages={messages}
              sending={sending}
              loading={loadingChat}
              empty={messages.length <= 1 && !activeId}
              user={!!user}
              onSuggestion={(p) => send(p)}
              onEditOpen={(m) => {
                if (!m.id) return;
                setEditMsgId(m.id);
                setEditText(m.text);
              }}
              editMsgId={editMsgId}
              editText={editText}
              onEditChange={setEditText}
              onEditSubmit={submitEdit}
              onEditCancel={() => setEditMsgId(null)}
              onDelete={removeMessage}
              onRegenerate={regenerateMessage}
              onCopy={copyMessage}
              copiedId={copiedId}
              activeId={activeId}
            />
          </div>
          <div
            className="px-3 pt-3 border-t border-[var(--acc-b)]/15 flex items-end gap-2"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
          >
            <AiInput value={input} onChange={setInput} onSend={() => send()} sending={sending} disabled={!user} ref={inputRef} />
          </div>
        </div>
      )}

      <div
        className="fixed right-4 md:right-6 z-[70] flex flex-col items-end gap-3"
        style={{ bottom: 'var(--fab-bottom, 5rem)' }}
      >
        {/* Desktop: floating panel */}
        {open && !isMobile && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Cyber-ZONE AI yordamchi"
            className="w-[min(880px,94vw)] h-[min(620px,calc(100vh-10rem))] rounded-2xl glass border border-[var(--acc-b)]/25 shadow-2xl overflow-hidden flex flex-col panel-pop"
          >
            <AiHeader
              chatBusy={chatBusy}
              user={!!user}
              drawerOpen={drawer}
              onToggleDrawer={() => setDrawer((d) => !d)}
              onClose={() => setOpen(false)}
              onNew={newConversation}
              onClear={clearChat}
            />
            <div className="flex-1 flex overflow-hidden">
              {drawer && (
                <ConvList
                  conversations={conversations}
                  activeId={activeId}
                  loading={loadingList}
                  onOpen={openConversation}
                  onNew={newConversation}
                  onRename={renameConversation}
                  onDelete={removeConversation}
                />
              )}
              <AiBody
                bodyRef={bodyRef}
                messages={messages}
                sending={sending}
                loading={loadingChat}
                empty={messages.length <= 1 && !activeId}
                user={!!user}
                onSuggestion={(p) => send(p)}
                onEditOpen={(m) => {
                  if (!m.id) return;
                  setEditMsgId(m.id);
                  setEditText(m.text);
                }}
                editMsgId={editMsgId}
                editText={editText}
                onEditChange={setEditText}
                onEditSubmit={submitEdit}
                onEditCancel={() => setEditMsgId(null)}
                onDelete={removeMessage}
                onRegenerate={regenerateMessage}
                onCopy={copyMessage}
                copiedId={copiedId}
                activeId={activeId}
              />
            </div>
            <div className="px-3 py-3 border-t border-[var(--acc-b)]/15 flex items-end gap-2">
              <AiInput value={input} onChange={setInput} onSend={() => send()} sending={sending} disabled={!user} ref={inputRef} />
            </div>
          </div>
        )}

        {/* Toggle (mobil'da ochiq holda yashirin) */}
        {!(open && isMobile) && (
          <button
            ref={toggleRef}
            onClick={() => setOpen((o) => !o)}
            className="w-14 h-14 rounded-full bg-[color-mix(in_srgb,var(--acc-b)_12%,var(--bg-1))] border border-[var(--acc-b)]/40 backdrop-blur-lg flex items-center justify-center text-white ai-fab"
            aria-label={open ? 'AI yordamchini yopish' : 'AI yordamchini ochish'}
            aria-expanded={open}
            data-tip={open ? 'Yopish' : 'AI yordamchi'}
          >
            {open ? <X size={22} /> : <AILogo size={26} />}
          </button>
        )}
      </div>
    </>
  );
}

// ============ HEADER ============
interface HeaderProps {
  chatBusy: boolean;
  user: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onClose: () => void;
  onNew: () => void;
  onClear: () => void;
}

function AiHeader({ chatBusy, user, drawerOpen, onToggleDrawer, onClose, onNew, onClear }: HeaderProps) {
  return (
    <div className="px-4 py-3 flex items-center justify-between border-b border-[var(--acc-b)]/15 bg-[var(--acc-b)]/5 shrink-0">
      <div className="flex items-center gap-2.5">
        <button
          onClick={onToggleDrawer}
          aria-label="Suhbatlar tarixi"
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            drawerOpen ? 'text-[var(--acc-a)] bg-white/5' : 'text-gray-400 hover:bg-white/5 hover:text-white'
          )}
        >
          <PanelLeft size={17} />
        </button>
        <div className="w-9 h-9 rounded-xl bg-[var(--acc-b)]/12 border border-[var(--acc-b)]/30 grid place-items-center">
          <AILogo size={20} />
        </div>
        <div>
          <div className="text-sm font-bold leading-tight">CYBER-ZONE AI</div>
          <div className="text-[10px] text-gray-400 flex items-center gap-1">
            {chatBusy ? (
              <>
                <Loader2 size={10} className="animate-spin text-[var(--acc-a)]" /> ishlayapti...
              </>
            ) : user ? (
              <>
                <span className="w-1 h-1 rounded-full bg-[var(--acc-a)]" /> yordamchi · tarix saqlanadi
              </>
            ) : (
              'kirish talab qilinadi'
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onNew}
          aria-label="Yangi suhbat"
          className="min-w-9 h-9 grid place-items-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <MessageSquarePlus size={16} />
        </button>
        <button
          onClick={onClear}
          aria-label="Yangi suhbat sahifasi"
          className="min-w-9 h-9 grid place-items-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <History size={16} />
        </button>
        <button
          onClick={onClose}
          aria-label="AI yordamchini yopish"
          className="min-w-9 h-9 grid place-items-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <X size={17} />
        </button>
      </div>
    </div>
  );
}

// ============ SUHBATLAR RO'YXATI (tarix drawer) ============
interface ConvListProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function ConvList({ conversations, activeId, loading, onOpen, onNew, onRename, onDelete }: ConvListProps) {
  return (
    <div className="w-64 shrink-0 border-r border-white/10 bg-black/20 flex flex-col overflow-hidden">
      <div className="p-3 border-b border-white/5">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-[var(--acc-b)]/40 text-[var(--acc-b)] hover:bg-[var(--acc-b)]/10 text-sm font-semibold transition-colors"
        >
          <MessageSquarePlus size={15} /> Yangi suhbat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
        {loading ? (
          <div className="flex items-center gap-2 text-gray-500 text-xs px-2 py-3">
            <Loader2 size={13} className="animate-spin" /> Yuklanmoqda...
          </div>
        ) : conversations.length === 0 ? (
          <p className="text-xs text-gray-500 px-2 py-3">Suhbatlar hali yo&apos;q.</p>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                'group px-3 py-2 rounded-xl text-sm transition-colors cursor-pointer',
                activeId === c.id ? 'bg-[var(--acc-b)]/10 border border-[var(--acc-b)]/25' : 'hover:bg-white/5 border border-transparent'
              )}
              onClick={() => onOpen(c.id)}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="font-semibold leading-tight text-[13px] line-clamp-2">{c.title}</span>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    aria-label="Nomlash"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(c.id, c.title);
                    }}
                    className="p-1 rounded text-gray-400 hover:text-white"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    aria-label="O'chirish"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.id);
                    }}
                    className="p-1 rounded text-gray-400 hover:text-red-400"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
              {c.lastMessage && <p className="text-[11px] text-gray-500 line-clamp-2 mt-0.5">{c.lastMessage}</p>}
              <p className="text-[10px] text-gray-600 mt-0.5">{c.messageCount} xabar</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============ BODY ============
interface BodyProps {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  messages: UiMsg[];
  sending: boolean;
  loading: boolean;
  empty: boolean;
  user: boolean;
  activeId: string | null;
  onSuggestion: (prompt: string) => void;
  onEditOpen: (m: UiMsg) => void;
  editMsgId: string | null;
  editText: string;
  onEditChange: (v: string) => void;
  onEditSubmit: (id: string) => void;
  onEditCancel: () => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string) => void;
  onCopy: (text: string, id: string) => void;
  copiedId: string | null;
}

function AiBody(props: BodyProps) {
  const {
    bodyRef, messages, user, empty, loading, onSuggestion,
    onEditOpen, editMsgId, editText, onEditChange, onEditSubmit, onEditCancel,
    onDelete, onRegenerate, onCopy, copiedId, activeId,
  } = props;

  return (
    <div
      ref={bodyRef}
      role="log"
      aria-live="polite"
      aria-label="AI yordamchi suhbati"
      className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 scrollbar-thin min-w-0"
    >
      {!user ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-gray-300 mb-3">
            AI yordamchi <span className="text-[var(--acc-a)]">Cyber-ZONE</span> haqidagi savollarga javob beradi,
            bron/to&apos;lov holatingizni ko&apos;rsatadi va suhbat tarixini saqlaydi.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link href="/login" className="px-4 py-2 rounded-xl neon-btn text-sm">Kirish</Link>
            <Link href="/register" className="px-4 py-2 rounded-xl text-sm border border-[var(--acc-b)]/30 text-[var(--acc-b)] hover:bg-[var(--acc-b)]/10 transition-colors">
              Ro&apos;yxatdan o&apos;tish
            </Link>
          </div>
        </div>
      ) : loading ? (
        <div className="flex justify-start">
          <div className="px-3 py-2 rounded-2xl rounded-bl-sm bg-cyber-800/80 border border-[var(--acc-b)]/15 flex items-center gap-2 text-sm text-gray-400">
            <Loader2 size={14} className="animate-spin text-[var(--acc-a)]" /> suhbat yuklanmoqda...
          </div>
        </div>
      ) : (
        <>
          {empty && (
            <div className="px-1 pb-1">
              <p className="text-xs text-gray-500 mb-2">Qanday yordam bera olaman? Tanlang yoki o&apos;z savolingizni yozing:</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.prompt}
                    onClick={() => onSuggestion(s.prompt)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-[var(--acc-b)]/25 text-[var(--acc-b)] hover:bg-[var(--acc-b)]/10 transition-colors"
                  >
                    <s.icon size={13} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={msg.id ?? `local-${i}`} className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              {msg.role === 'user' && editMsgId === msg.id ? (
                <div className="max-w-[86%] w-full">
                  <textarea
                    value={editText}
                    onChange={(e) => onEditChange(e.target.value)}
                    rows={3}
                    autoFocus
                    className="glass-input w-full rounded-2xl px-3 py-2.5 text-sm outline-none resize-y"
                  />
                  <div className="flex items-center justify-end gap-2 mt-1.5">
                    <button
                      onClick={onEditCancel}
                      className="text-xs text-gray-400 px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5"
                    >
                      Bekor qilish
                    </button>
                    <button
                      onClick={() => onEditSubmit(msg.id!)}
                      className="text-xs font-bold text-[var(--acc-b)] px-3 py-1.5 rounded-lg border border-[var(--acc-b)]/40 hover:bg-[var(--acc-b)]/10"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <MessageBubble
                  msg={msg}
                  canDelete={!!msg.id}
                  onEditOpen={() => onEditOpen(msg)} // faqat user xabari
                  onDelete={() => onDelete(msg.id!)}
                  onRegenerate={() => onRegenerate(msg.id!)}
                  onCopy={() => onCopy(msg.text, msg.id ?? `n${i}`)}
                  copied={copiedId === (msg.id ?? `n${i}`)}
                />
              )}
            </div>
          ))}

          {!activeId && !empty && null}
        </>
      )}
    </div>
  );
}

// ============ XABAR PUFAQ (bir xabar) ============
function MessageBubble({
  msg, canDelete, onEditOpen, onDelete, onRegenerate, onCopy, copied,
}: {
  msg: UiMsg;
  canDelete: boolean;
  onEditOpen: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  if (msg.role === 'user') {
    return (
      <div className="max-w-[82%] group">
        <div className="px-3 py-2 rounded-2xl rounded-br-sm neon-btn text-sm whitespace-pre-line break-words">
          {msg.text}
        </div>
        {canDelete && (
          <div className="flex items-center justify-end gap-1 mt-0.5 text-gray-400">
            <button aria-label="Tahrirlash" onClick={onEditOpen} className="p-1.5 rounded hover:text-[var(--acc-b)]">
              <Pencil size={12} />
            </button>
            <button aria-label="O'chirish" onClick={onDelete} className="p-1.5 rounded hover:text-red-400">
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[86%] group">
      <div
        className={cn(
          'px-3 py-2 rounded-2xl rounded-bl-sm bg-cyber-800/80 border border-[var(--acc-b)]/15 text-sm text-gray-200 break-words',
          msg.error && 'border-red-500/40 text-red-300'
        )}
      >
        {msg.streaming || msg.pending ? (
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 size={14} className="animate-spin text-[var(--acc-a)]" />
            javob yozilmoqda...
          </div>
        ) : (
          <div className="md-body max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{msg.text || ''}</Markdown>
          </div>
        )}
      </div>
      {!msg.pending && !msg.streaming && canDelete && (
        <div className="flex items-center gap-1 mt-0.5 text-gray-400">
          <button aria-label="Nusxalash" onClick={onCopy} className="p-1.5 rounded hover:text-[var(--acc-b)]">
            {copied ? <Check size={12} className="text-neon-green" /> : <Copy size={12} />}
          </button>
          <button aria-label="Qayta yaratish" onClick={onRegenerate} className="p-1.5 rounded hover:text-[var(--acc-b)]">
            <RefreshCw size={12} />
          </button>
          <button aria-label="O'chirish" onClick={onDelete} className="p-1.5 rounded hover:text-red-400">
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

// ============ INPUT ============
interface InputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
}

const AiInput = React.forwardRef<HTMLInputElement, InputProps>(function AiInput(
  { value, onChange, onSend, sending, disabled },
  ref
) {
  return (
    <>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={disabled ? 'Avval tizimga kiring' : 'Savol yozing...'}
        aria-label="AI yordamchiga savol yozish"
        disabled={disabled}
        className="glass-input flex-1 rounded-xl px-3 py-2.5 text-sm outline-none disabled:opacity-50"
      />
      <button
        onClick={onSend}
        disabled={sending || disabled || !value.trim()}
        aria-label="Xabar yuborish"
        className="min-w-11 h-11 rounded-xl neon-btn disabled:opacity-40 grid place-items-center"
      >
        {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
      </button>
    </>
  );
});