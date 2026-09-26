'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Loader2, ShieldCheck, Phone, Mail, Trash2, UserRound, Building2, Pencil,
} from 'lucide-react';
import api, { getApiErrorMessage } from '@/lib/api';
import { confirmDialog } from '@/lib/confirm';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/store/auth';
import { cn } from '@/lib/utils';

export type SupportChannel = 'admin' | 'superadmin';
export type SupportMode = 'user' | 'admin' | 'superadmin';

interface SupportMsg {
  id: string;
  userId: string;
  senderId: string | null;
  message: string;
  recipientRole: string;
  roomId: string | null;
  isRead: boolean;
  createdAt: string;
  editedAt?: string | null;
  user?: { id: string; fullName: string; email: string; phone: string | null; role: string };
  sender?: { id: string; fullName: string; role: string; avatarUrl?: string | null } | null;
}

interface SupportThread {
  user: { id: string; fullName: string; email: string; phone: string | null; role: string };
  room?: { id: string; name: string } | null;
  unread: number;
  total: number;
  lastMessage?: SupportMsg;
}

interface SupportRoom {
  id: string;
  name: string;
  address?: string;
  owner?: { id: string; fullName: string | null };
}

const CHANNEL_UPPER = (c: SupportChannel) => (c === 'admin' ? 'ADMIN' : 'SUPER_ADMIN');

/**
 * Support chat — kanallar (ADMIN / SUPER_ADMIN) bo'yicha ajratilgan murojaatlar.
 *
 * mode='user':
 *   channel='superadmin' → foydalanuvchi super_admin bilan yozishadi
 *   channel='admin'      → foydalanuvchi xona admini bilan (room tanlanadi)
 * mode='admin':
 *   channel='superadmin' → admin o'z murojaatini super_admin'ga yozadi
 *   channel='admin'      → admin inbox: userlar murojaatlari (ism+tel ko'rinadi)
 * mode='superadmin':
 *   channel='superadmin' → super admin inbox (scope=users|admins|all)
 *   channel='admin'      → super admin: xonalarga tushgan murojaatlar kuzatuvi
 */
export default function SupportChat({
  mode = 'user',
  channel = 'superadmin',
  scope = 'all',
}: {
  mode?: SupportMode;
  channel?: SupportChannel;
  scope?: 'all' | 'users' | 'admins';
}) {
  const me = useAuthStore((s) => s.user);
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [supportRooms, setSupportRooms] = useState<SupportRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<SupportRoom | null>(null);
  const [active, setActive] = useState<{ userId: string; roomId?: string | null } | null>(null);
  const [messages, setMessages] = useState<SupportMsg[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chUpper = CHANNEL_UPPER(channel);

  const isListMode = mode === 'superadmin' || (mode === 'admin' && channel === 'admin');
  const isSuperAdmin = me?.role === 'SUPER_ADMIN';
  const hiddenForSuperAdmin = isSuperAdmin && mode === 'user';
  const visitorName = activeRoom?.owner?.fullName || (isSuperAdmin ? 'Super Admin' : 'Xona admini');

  const visibleThreads = threads.filter((t) =>
    scope === 'all' ? true : scope === 'users' ? t.user.role === 'USER' : t.user.role === 'ADMIN'
  );

  const merge = (list: SupportMsg[], incoming: SupportMsg | SupportMsg[]) =>
    Array.from(new Map([...list, ...(Array.isArray(incoming) ? incoming : [incoming])].map((m) => [m.id, m])).values())
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const loadThreads = useCallback(async () => {
    const params = new URLSearchParams({ channel: chUpper });
    try {
      const { data } = await api.get(`/api/support/threads?${params}`);
      setThreads(data.data || []);
    } catch { /* skip */ }
  }, [chUpper]);

  const loadSupportRooms = useCallback(async () => {
    try {
      const { data } = await api.get('/api/support/my-rooms');
      setSupportRooms(data.data || []);
    } catch { /* skip */ }
  }, []);

  const loadThreadMessages = useCallback(async (uId: string, rId?: string | null) => {
    const p = new URLSearchParams({ recipient: chUpper });
    if (uId) p.set('userId', uId);
    if (chUpper === 'ADMIN' && rId) p.set('roomId', rId);
    const { data } = await api.get(`/api/support/messages?${p}`);
    setMessages(data.data.messages || []);
  }, [chUpper]);

  const openThread = useCallback(async (userId: string, roomId?: string | null) => {
    setActive({ userId, roomId });
    setMessages([]);
    try {
      await loadThreadMessages(userId, roomId);
      loadThreads();
    } catch { /* skip */ }
  }, [loadThreadMessages, loadThreads]);

  const openRoom = useCallback(async (room: SupportRoom) => {
    setActiveRoom(room);
    setActive(null);
    setMessages([]);
    const p = new URLSearchParams({ recipient: 'ADMIN', roomId: room.id });
    try {
      const { data } = await api.get(`/api/support/messages?${p}`);
      setMessages(data.data.messages || []);
      setActive({ userId: data.data.userId || me?.id || '', roomId: room.id });
    } catch { /* skip */ }
  }, [me]);

  // Dastlabki yuklash
  useEffect(() => {
    if (!me || hiddenForSuperAdmin) return;
    let alive = true;
    const run = async () => {
      try {
        if (isListMode) {
          await loadThreads();
        } else if (mode === 'user' && channel === 'admin') {
          await loadSupportRooms();
        } else {
          const { data } = await api.get('/api/support/messages');
          if (!alive) return;
          setMessages(data.data.messages || []);
          setActive({ userId: data.data.userId || me.id || '' });
        }
      } catch { /* skip */ }
      finally {
        if (alive) setLoading(false);
      }
    };
    run();
    return () => { alive = false; };
  }, [me, hiddenForSuperAdmin, isListMode, mode, channel, loadThreads, loadSupportRooms]);

  // Jonli yangilanish (socket)
  useEffect(() => {
    if (!me || hiddenForSuperAdmin) return;
    const socket = getSocket();
    socket.emit('register', me.id);
    if (isSuperAdmin) socket.emit('joinSupport');
    const threadUserId = active?.userId;
    if (threadUserId) socket.emit('joinSupportThread', threadUserId, chUpper);

    const onNew = (payload: { userId: string; message: SupportMsg }) => {
      if (isListMode) {
        if (active?.userId === payload.userId) setMessages((m) => merge(m, payload.message));
        loadThreads();
      } else if (mode === 'user' && channel === 'admin') {
        if (activeRoom) {
          if (payload.message.roomId === activeRoom.id) setMessages((m) => merge(m, payload.message));
          loadSupportRooms();
        }
      } else {
        setMessages((m) => merge(m, payload.message));
      }
    };
    socket.on('support:new', onNew);
    socket.on('support:thread:new', onNew);

    const onUpdated = (payload: { userId: string; message: SupportMsg }) => {
      if (isListMode) {
        if (active?.userId === payload.userId) setMessages((m) => merge(m, payload.message));
        loadThreads();
      } else if (mode === 'user' && channel === 'admin') {
        if (activeRoom) {
          if (payload.message.roomId === activeRoom.id) setMessages((m) => merge(m, payload.message));
          loadSupportRooms();
        }
      } else {
        setMessages((m) => merge(m, payload.message));
      }
    };
    const onDeleted = (payload: { userId: string; messageId: string; roomId?: string | null }) => {
      const inCurrent =
        isListMode
          ? active?.userId === payload.userId && payload.roomId === (active.roomId ?? null)
          : mode === 'user' && channel === 'admin'
            ? payload.roomId === activeRoom?.id
            : payload.userId === (active?.userId ?? me.id);
      if (inCurrent) setMessages((prev) => prev.filter((x) => x.id !== payload.messageId));
      if (isListMode) loadThreads();
      if (mode === 'user' && channel === 'admin') loadSupportRooms();
    };
    socket.on('support:updated', onUpdated);
    socket.on('support:deleted', onDeleted);

    return () => {
      socket.off('support:new', onNew);
      socket.off('support:thread:new', onNew);
      socket.off('support:updated', onUpdated);
      socket.off('support:deleted', onDeleted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, isSuperAdmin, hiddenForSuperAdmin, isListMode, mode, channel, active, activeRoom, loadThreads, loadSupportRooms]);

  // Polling fallback
  useEffect(() => {
    if (!me || hiddenForSuperAdmin) return;
    const timer = window.setInterval(async () => {
      try {
        if (isListMode) {
          loadThreads();
          if (active) {
            const { data } = await api.get(`/api/support/messages?${new URLSearchParams({ recipient: chUpper, ...(active.userId ? { userId: active.userId } : {}), ...(chUpper === 'ADMIN' && active.roomId ? { roomId: active.roomId } : {}) })}`);
            setMessages((m) => merge(m, data.data.messages || []));
          }
        } else if (mode === 'user' && channel === 'admin') {
          if (activeRoom) {
            const { data } = await api.get(`/api/support/messages?${new URLSearchParams({ recipient: 'ADMIN', roomId: activeRoom.id })}`);
            setMessages((m) => merge(m, data.data.messages || []));
          }
        } else {
          const { data } = await api.get('/api/support/messages');
          setMessages((m) => merge(m, data.data.messages || []));
        }
      } catch { /* skip */ }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [me, hiddenForSuperAdmin, isListMode, mode, channel, active, activeRoom, loadThreads, chUpper]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [messages.length, active, activeRoom]);

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    setErr(null);
    try {
      const payload: Record<string, string | undefined> = { message: text.trim(), recipient: chUpper };
      if (isListMode && active?.userId) payload.userId = active.userId;
      if (channel === 'admin') {
        if (mode === 'user' && activeRoom) payload.roomId = activeRoom.id;
        else if (active?.roomId) payload.roomId = active.roomId;
      }
      const { data } = await api.post('/api/support/messages', payload);
      setMessages((m) => merge(m, data.data));
      if (isListMode) loadThreads();
      if (mode === 'user' && channel === 'admin') loadSupportRooms();
      setText('');
    } catch (e) {
      setErr(getApiErrorMessage(e));
    }
    setSending(false);
  }

  async function clearThread() {
    if (!active?.userId) return;
    if (!await confirmDialog({ title: 'Murojaatni tozalash', message: 'Bu murojaatni tozalashni tasdiqlaysizmi?', danger: true })) return;
    try {
      const p = new URLSearchParams({ channel: chUpper });
      if (chUpper === 'ADMIN' && active.roomId) p.set('roomId', active.roomId);
      await api.delete(`/api/support/threads/${active.userId}?${p}`);
      setMessages([]);
      loadThreads();
    } catch { /* skip */ }
  }

  // Tahrirlash/o'chirish huquqi: xabar muallifi yoki ADMIN/SUPER_ADMIN
  const canManage = (m: SupportMsg) => !!me && (m.senderId === me.id || me.role === 'ADMIN' || me.role === 'SUPER_ADMIN');

  const startEdit = (m: SupportMsg) => {
    setErr(null);
    setEditing({ id: m.id, text: m.message });
  };
  const cancelEdit = () => {
    setEditing(null);
    setErr(null);
  };

  const saveEdit = async () => {
    if (!editing || !editing.text.trim() || changingId) return;
    const id = editing.id;
    setChangingId(id);
    setErr(null);
    try {
      const { data } = await api.patch(`/api/support/messages/${id}`, { message: editing.text.trim() });
      setMessages((m) => merge(m, data.data));
      setEditing(null);
      if (isListMode) loadThreads();
      if (mode === 'user' && channel === 'admin') loadSupportRooms();
    } catch (e) {
      setErr(getApiErrorMessage(e));
    }
    setChangingId(null);
  };

  const deleteMsg = async (m: SupportMsg) => {
    if (changingId) return;
    if (!await confirmDialog({ title: 'Xabarni o\'chirish', message: 'Bu xabarni o\'chirishni tasdiqlaysizmi?', danger: true })) return;
    setChangingId(m.id);
    setErr(null);
    try {
      await api.delete(`/api/support/messages/${m.id}`);
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
      if (editing?.id === m.id) setEditing(null);
      if (isListMode) loadThreads();
      if (mode === 'user' && channel === 'admin') loadSupportRooms();
    } catch (e) {
      setErr(getApiErrorMessage(e));
    }
    setChangingId(null);
  };

  // Xavfsizlik: super_admin o'ziga o'zi "Super Admin'ga yozish" ko'rinmaydi
  if (hiddenForSuperAdmin) {
    return (
      <div className="neo-card rounded-2xl p-8 text-center">
        <ShieldCheck size={38} className="mx-auto text-yellow-400 mb-3" />
        <p className="font-bold mb-1">Super Admin</p>
        <p className="text-sm text-gray-400">
          Murojaatlar boshqaruv panelidagi chat tablarida boshqariladi.
        </p>
      </div>
    );
  }

  if (!me) return null;

  const heading =
    isSuperAdmin
      ? channel === 'admin' ? 'Xona murojaatlari' : 'Murojaatlar'
      : mode === 'admin'
        ? channel === 'admin' ? 'Mening murojaatlar' : 'Super Admin bilan bog\'lanish'
        : channel === 'admin' ? 'Xona admini bilan bog\'lanish' : 'Super Admin bilan bog\'lanish';

  return (
    <div className="neo-card rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-neon-cyan/15 bg-gradient-to-r from-yellow-400/10 via-transparent to-neon-cyan/10 flex items-center justify-between">
        <h3 className="font-bold flex items-center gap-2">
          <ShieldCheck size={18} className={channel === 'admin' ? 'text-neon-cyan' : 'text-yellow-400'} />
          {heading}
        </h3>
        <span className="text-[10px] px-2 py-1 rounded-full bg-yellow-400/10 text-yellow-300 font-bold uppercase tracking-wider">
          {channel === 'admin' ? 'Admin PM' : 'Support'}
        </span>
      </div>

      {isListMode ? (
        <div className="grid lg:grid-cols-3 gap-4 p-5">
          {/* Threads */}
          <div className="space-y-1.5 max-h-[400px] overflow-y-auto scrollbar-thin lg:border-r lg:border-white/10 lg:pr-3">
            {loading ? (
              <div className="space-y-2" role="status" aria-live="polite" aria-label="Murojaatlar yuklanmoqda">
                {[1, 2, 3].map((i) => <div key={i} className="h-14 rounded-xl bg-cyber-800 animate-pulse" />)}
              </div>
            ) : visibleThreads.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-10">Hozircha murojaatlar yo&apos;q</p>
            ) : (
              visibleThreads.map((t) => (
                <button
                  key={`${t.user.id}${t.room?.id || ''}`}
                  onClick={() => openThread(t.user.id, t.room?.id)}
                  aria-current={active?.userId === t.user.id && (active.roomId ?? null) === (t.room?.id ?? null) ? 'true' : undefined}
                  className={cn(
                    'w-full text-left rounded-xl border px-3 py-2.5 transition-colors',
                    active?.userId === t.user.id && (active.roomId ?? null) === (t.room?.id ?? null)
                      ? 'border-yellow-400/40 bg-yellow-400/10'
                      : 'border-white/10 bg-cyber-900 hover:border-yellow-400/25'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium truncate flex items-center gap-1.5">
                      <UserRound size={12} className="text-yellow-400 shrink-0" /> {t.user.fullName}
                    </span>
                    {t.unread > 0 && (
                      <span className="w-5 h-5 rounded-full bg-yellow-400 text-black text-[10px] font-extrabold grid place-items-center shrink-0">{t.unread}</span>
                    )}
                  </div>
                  {t.room?.name && (
                    <p className="text-[10px] text-neon-cyan flex items-center gap-1 mt-0.5 truncate">
                      <Building2 size={9} /> {t.room.name}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1 truncate">{t.lastMessage?.message || ('Xabar yo\'q')}</p>
                </button>
              ))
            )}
          </div>

          {/* Thread view */}
          <div className="lg:col-span-2">
            {!active ? (
              <div className="h-64 grid place-items-center text-sm text-gray-500">Suhbatni tanlang</div>
            ) : (
              <div className="flex flex-col h-[400px]">
                <ThreadHeader
                  name={threads.find((t) => t.user.id === active.userId && (t.room?.id ?? null) === (active.roomId ?? null))?.user.fullName || 'Foydalanuvchi'}
                  email={threads.find((t) => t.user.id === active.userId && (t.room?.id ?? null) === (active.roomId ?? null))?.user.email}
                  phone={threads.find((t) => t.user.id === active.userId && (t.room?.id ?? null) === (active.roomId ?? null))?.user.phone}
                  role={threads.find((t) => t.user.id === active.userId && (t.room?.id ?? null) === (active.roomId ?? null))?.user.role}
                  roomName={threads.find((t) => t.user.id === active.userId && (t.room?.id ?? null) === (active.roomId ?? null))?.room?.name}
                  onClear={isSuperAdmin || (me.role === 'ADMIN' && channel === 'admin') ? clearThread : undefined}
                />
                <MessageList
                  messages={messages}
                  meId={me.id}
                  boxRef={boxRef}
                  canManage={canManage}
                  onEdit={startEdit}
                  onDelete={deleteMsg}
                  editing={editing}
                  onTextChange={(t) => setEditing((e) => (e ? { ...e, text: t } : e))}
                  onSaveEdit={saveEdit}
                  onCancelEdit={cancelEdit}
                  changingId={changingId}
                />
                {err && <p role="alert" className="px-5 pb-1 text-xs text-red-400">{err}</p>}
                <InputBar value={text} onChange={setText} onSend={send} sending={sending} placeholder="Javob yozing..." />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {/* Room picker — user -> admin kanali */}
          {mode === 'user' && channel === 'admin' && (
            <div className="px-5 pt-4">
              {loading ? (
                <div className="flex gap-2" role="status" aria-live="polite" aria-label="Xonalar yuklanmoqda">
                  {[1, 2, 3].map((i) => <div key={i} className="h-9 w-28 rounded-full bg-cyber-800 animate-pulse" />)}
                </div>
              ) : supportRooms.length === 0 ? (
                <p className="text-sm text-gray-500">Hozircha suhbat boshlash uchun xona topilmadi.</p>
              ) : (
                <>
                  <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1.5 font-medium" id="support-room-picker">
                    Xona tanlang
                  </p>
                  <div className="flex flex-wrap gap-2" role="group" aria-labelledby="support-room-picker">
                    {supportRooms.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => openRoom(r)}
                        aria-pressed={activeRoom?.id === r.id}
                        className={cn(
                          'text-xs font-medium rounded-full border px-3 py-1.5 flex items-center gap-1.5 transition-colors',
                          activeRoom?.id === r.id ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan' : 'border-white/10 bg-cyber-900 text-gray-300 hover:border-neon-cyan/30'
                        )}
                      >
                        <Building2 size={11} className="shrink-0" /> {r.name}
                        {r.owner?.fullName && <span className="text-gray-500">· {r.owner.fullName}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className={cn(mode === 'user' && channel === 'admin' && 'pt-3', 'max-h-[360px] min-h-[200px]')}>
            <MessageList
              messages={messages}
              meId={me.id}
              boxRef={boxRef}
              loading={loading}
              canManage={canManage}
              onEdit={startEdit}
              onDelete={deleteMsg}
              editing={editing}
              onTextChange={(t) => setEditing((e) => (e ? { ...e, text: t } : e))}
              onSaveEdit={saveEdit}
              onCancelEdit={cancelEdit}
              changingId={changingId}
              empty={
                mode === 'user' && channel === 'admin'
                  ? activeRoom
                    ? `Savol yoki muammo bo'lsa ${visitorName}ga yozing. Xona adminlari odatda tez javob beradi.`
                    : 'Suhbatlashish uchun xona tanlang.'
                  : "Muammo/savol bo'lsa super admin'ga yozing. Odatda qisqa vaqt ichida javob beramiz."
              }
            />
          </div>
          {err && <p role="alert" className="px-5 text-xs text-red-400">{err}</p>}
          <div className="border-t border-white/10 p-3">
            <InputBar
              value={text}
              onChange={setText}
              onSend={send}
              sending={sending}
              placeholder={mode === 'user' && channel === 'admin' ? (activeRoom ? `${visitorName}ga xabar yozing...` : 'Avval xona tanlang...') : 'Xabar yozing...'}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadHeader({ name, email, phone, role, roomName, onClear }: {
  name: string;
  email?: string;
  phone?: string | null;
  role?: string;
  roomName?: string;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center justify-between pb-2 border-b border-white/10">
      <div>
        <b className="flex items-center gap-1.5 text-sm">
          {name}
          {role && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-400/10 text-yellow-300 font-bold uppercase">{role === 'USER' ? 'User' : (role === 'ADMIN' ? 'Admin' : 'Super Admin')}</span>
          )}
        </b>
        <div className="text-xs text-gray-500 flex items-center gap-3 mt-0.5 flex-wrap">
          {phone && <span className="flex items-center gap-1"><Phone size={10} /> {phone}</span>}
          {email && <span className="flex items-center gap-1 truncate"><Mail size={10} /> {email}</span>}
          {roomName && <span className="flex items-center gap-1 text-neon-cyan"><Building2 size={10} /> {roomName}</span>}
        </div>
      </div>
      {onClear && (
        <button onClick={onClear} title="Murojaatni tozalash" aria-label="Murojaatni tozalash" className="p-2 rounded-lg text-red-400 hover:bg-red-500/10 shrink-0"><Trash2 size={14} /></button>
      )}
    </div>
  );
}

function MessageList({ messages, meId, boxRef, loading, empty, canManage, onEdit, onDelete, editing, onTextChange, onSaveEdit, onCancelEdit, changingId }: {
  messages: SupportMsg[];
  meId: string;
  boxRef: React.RefObject<HTMLDivElement | null>;
  loading?: boolean;
  empty?: string;
  canManage?: (m: SupportMsg) => boolean;
  onEdit?: (m: SupportMsg) => void;
  onDelete?: (m: SupportMsg) => void;
  editing?: { id: string; text: string } | null;
  onTextChange?: (t: string) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  changingId?: string | null;
}) {
  if (loading) {
    return (
      <div className="p-5 space-y-2" role="status" aria-live="polite" aria-label="Xabarlar yuklanmoqda">
        {[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-lg bg-cyber-800 animate-pulse w-3/5" />)}
      </div>
    );
  }
  if (messages.length === 0) {
    return <p className="text-sm text-gray-500 text-center py-12 px-5">{empty || ('Xabar yo\'q')}</p>;
  }
  return (
    <div ref={boxRef} role="log" aria-live="polite" aria-label="Xabarlar" className="h-[360px] overflow-y-auto scrollbar-thin p-5 space-y-2.5">
      {messages.map((m) => {
        const mine = m.senderId === meId;
        const author = m.senderId === m.userId ? m.user : m.sender;
        const isSupport = author?.role === 'SUPER_ADMIN';
        const isRoomReply = Boolean(!mine && author && author.id !== m.userId && author.role === 'ADMIN');
        const isEditing = editing?.id === m.id;
        const manageable = canManage?.(m) ?? false;
        const busy = changingId === m.id;
        return (
          <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
            <div className={cn('group relative max-w-[80%] rounded-2xl px-3.5 py-2 text-sm', mine ? 'bg-yellow-400/15 border border-yellow-400/25 text-gray-100' : 'bg-cyber-800 border border-white/10 text-gray-200')}>
              <div className={cn('flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide mb-0.5', mine ? 'text-yellow-400' : 'text-gray-500')}>
                <AuthorLabel isSupport={isSupport} isRoomReply={isRoomReply} authorName={author?.fullName} role={author?.role} />
              </div>
              {isEditing ? (
                <textarea
                  autoFocus
                  value={editing?.text || ''}
                  onChange={(e) => onTextChange?.(e.target.value)}
                  rows={2}
                  aria-label="Xabarni tahrirlash"
                  className="w-full bg-cyber-900/80 border border-yellow-400/30 rounded-lg px-2.5 py-1.5 text-sm outline-none resize-none focus:border-yellow-400/60"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit?.(); } }}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words">{m.message}</p>
              )}
              <p className="text-[9px] text-gray-600 mt-1 text-right flex items-center justify-end gap-1">
                {m.editedAt && <span className="text-yellow-400/70 italic">tahrirlangan</span>}
                <span>{new Date(m.createdAt).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })}</span>
              </p>
              {isEditing ? (
                <div className="flex justify-end items-center gap-1.5 mt-1">
                  <button
                    onClick={onCancelEdit}
                    disabled={busy}
                    className="text-[10px] px-2 py-1 rounded-md bg-white/5 text-gray-400 hover:text-gray-200 disabled:opacity-40"
                  >
                    Bekor qilish
                  </button>
                  <button
                    onClick={onSaveEdit}
                    disabled={busy || !editing?.text.trim()}
                    className="text-[10px] px-2 py-1 rounded-md bg-yellow-400 text-black font-bold hover:bg-yellow-300 disabled:opacity-40 flex items-center gap-1"
                  >
                    {busy ? <Loader2 size={10} className="animate-spin" /> : 'Saqlash'}
                  </button>
                </div>
              ) : manageable ? (
                <div className="flex justify-end gap-1 mt-1 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => onEdit?.(m)}
                    title="Tahrirlash"
                    aria-label="Xabarni tahrirlash"
                    disabled={busy}
                    className="p-1 rounded-md text-gray-500 hover:text-yellow-400 hover:bg-yellow-400/10 disabled:opacity-40"
                  >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : <Pencil size={11} />}
                  </button>
                  <button
                    onClick={() => onDelete?.(m)}
                    title="O'chirish"
                    aria-label="Xabarni o'chirish"
                    disabled={busy}
                    className="p-1 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                  >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AuthorLabel({ isSupport, isRoomReply, authorName, role }: {
  isSupport: boolean;
  isRoomReply: boolean;
  authorName?: string;
  role?: string;
}) {
  const name = isSupport ? 'Super Admin' : isRoomReply ? (authorName || 'Admin') : (authorName || 'Siz');
  return (
    <>
      {isSupport && <ShieldCheck size={10} className="text-yellow-400" />}
      {isRoomReply && <Building2 size={10} className="text-neon-cyan" />}
      {name}
      {isRoomReply && role && <span className="text-gray-600"> · {authorName || 'Admin'}</span>}
    </>
  );
}

function InputBar({ value, onChange, onSend, sending, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
}) {
  return (
    <div className="flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        placeholder={placeholder}
        aria-label="Xabar matni"
        rows={1}
        className="glass-input flex-1 min-w-0 rounded-xl px-3 py-2 text-sm outline-none resize-none max-h-24"
      />
      <button
        onClick={onSend}
        disabled={sending || !value.trim()}
        aria-label="Xabar yuborish"
        className="w-10 h-10 rounded-xl neon-btn grid place-items-center shrink-0 disabled:opacity-40"
      >
        {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
      </button>
    </div>
  );
}
