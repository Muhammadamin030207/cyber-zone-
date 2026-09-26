'use client';

import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import {
  Settings, Monitor, Cpu, CalendarDays, BadgePercent, Newspaper, BarChart3, MessageSquare,
  Plus, Pencil, Trash2, Loader2, AlertCircle, Check, ShieldCheck, Users, Zap,
  Save, X, ChevronDown, ChevronUp, Gamepad2, TrendingUp, CircleDollarSign, RefreshCw, LifeBuoy, MessagesSquare, Info,
} from 'lucide-react';
import api, { getApiErrorMessage } from '@/lib/api';
import { toastError, toastSuccess } from '@/lib/toast';
import { confirmDialog, promptDialog } from '@/lib/confirm';
import { getSocket } from '@/lib/socket';
import type { Room, Zone, Computer, Booking, PromoCode, NewsItem } from '@/lib/types';
import { formatPrice, formatDate, formatDateTime, todayISO, zoneTypeLabel, cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import BarAdmin from '@/components/admin/BarAdmin';
import ChatAdmin from '@/components/admin/ChatAdmin';
import SupportChat from '@/components/support/SupportChat';
import SiteSettingsTab from '@/components/admin/SiteSettingsTab';
import Logo from '@/components/brand/Logo';

const MapPicker = dynamic(() => import('@/components/rooms/MapPicker'), { ssr: false });

type Tab = 'room' | 'zones' | 'computers' | 'bookings' | 'bar' | 'chat' | 'requests' | 'support' | 'promos' | 'news' | 'stats' | 'site';

const TABS: { key: Tab; icon: any; label: string }[] = [
  { key: 'room', icon: Settings, label: 'Xona' },
  { key: 'zones', icon: Users, label: 'Zonalar' },
  { key: 'computers', icon: Monitor, label: 'Kompyuterlar' },
  { key: 'bookings', icon: CalendarDays, label: 'Bronlar' },
  { key: 'bar', icon: Gamepad2, label: 'Gaming Bar' },
  { key: 'chat', icon: MessageSquare, label: 'Chat' },
  { key: 'requests', icon: MessagesSquare, label: 'Murojaatlar' },
  { key: 'support', icon: LifeBuoy, label: 'Super Admin' },
  { key: 'site', icon: Info, label: 'Sayt ma\'lumotlari' },
  { key: 'promos', icon: BadgePercent, label: 'Promo' },
  { key: 'news', icon: Newspaper, label: 'Yangiliklar' },
  { key: 'stats', icon: BarChart3, label: 'Statistika' },
];

export default function AdminPage({ params }: { params: Promise<{ locale: string }> }) {
  void params;
  const t = useTranslations('admin');
  const tG = useTranslations('superAdmin');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [tab, setTab] = useState<Tab>('room');
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);

  // Faqat ADMIN roliga ruxsat — SUPER_ADMIN o'z panelliga o'tadi
  useEffect(() => {
    if (!user) return;
    if (user.role !== 'ADMIN') {
      router.replace(user.role === 'SUPER_ADMIN' ? '/super-admin' : '/dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, router]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const { data } = await api.get('/api/rooms/all');
        const myRoom = (data.data as Room[]).find((r) => r.ownerId === user?.id) || null;
        setRoom(myRoom);
      } catch { /* skip */ }
      setLoading(false);
    }
    if (user && user.role === 'ADMIN') load();
  }, [user]);

  if (!user || user.role !== 'ADMIN') {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-24 text-center">
        <ShieldCheck size={56} className="mx-auto mb-4 text-gray-500" />
        <p className="text-gray-300 font-bold text-xl">{tG('accessDenied')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <div className="skeleton rounded-2xl h-96" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight mb-6 flex items-center gap-3">
        <span className="w-11 h-11 neo-card rounded-xl flex items-center justify-center"><Logo size={26} /></span> {t('title')}
      </h1>

      {/* Tabs */}
      <div className="flex items-center gap-1.5 mb-6 overflow-x-auto scrollbar-thin pb-2 px-1">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium border transition-all whitespace-nowrap hover:translate-y-[-1px]',
              tab === tb.key
                ? 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan shadow-[0_0_18px_-6px_var(--acc-a)] animate-pop'
                : 'border-neon-cyan/10 text-gray-400 hover:text-neon-cyan hover:border-neon-cyan/25 hover:bg-neon-cyan/5'
            )}
          >
            <tb.icon size={15} className="transition-transform group-hover:scale-110" />
            {tb.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {!room && tab !== 'room' && tab !== 'bar' && tab !== 'chat' && tab !== 'requests' && tab !== 'support' && tab !== 'site' && tab !== 'bookings' ? (
        <div className="text-center py-20">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center bg-[var(--acc-b)]/10 border border-[var(--acc-b)]/25">
            <Logo size={38} />
          </div>
          <p className="text-gray-400 text-lg mb-4">{t('noRoom')}</p>
          <button onClick={() => setTab('room')} className="px-6 py-3 rounded-xl neon-btn text-sm font-bold">
            <Plus size={16} className="inline mr-1" /> {t('createRoom')}
          </button>
        </div>
      ) : tab === 'room' ? (
        <RoomTab room={room} setRoom={setRoom} />
      ) : tab === 'zones' && room ? (
        <ZonesTab room={room} />
      ) : tab === 'computers' && room ? (
        <ComputersTab room={room} />
      ) : tab === 'bookings' ? (
        <BookingsTab room={room} />
      ) : tab === 'bar' ? (
        <BarAdmin />
      ) : tab === 'chat' ? (
        <ChatAdmin />
      ) : tab === 'requests' ? (
        <SupportChat mode="admin" channel="admin" />
      ) : tab === 'support' ? (
        <SupportChat mode="admin" channel="superadmin" />
      ) : tab === 'site' ? (
        <SiteSettingsTab />
      ) : tab === 'promos' && room ? (
        <PromosTab room={room} />
      ) : tab === 'news' ? (
        <NewsTab room={room} />
      ) : tab === 'stats' && room ? (
        <StatsTab room={room} />
      ) : null}
    </div>
  );
}

/* ====================== ROOM TAB ====================== */
function RoomTab({ room, setRoom }: { room: Room | null; setRoom: (r: Room) => void }) {
  const t = useTranslations('admin');
  const tC = useTranslations('common');
  const [form, setForm] = useState({
    name: room?.name || '',
    address: room?.address || '',
    phone: room?.phone || '',
    description: room?.description || '',
    workingHoursOpen: room?.workingHours?.open || '08:00',
    workingHoursClose: room?.workingHours?.close || '23:00',
    latitude: room?.latitude ?? null,
    longitude: room?.longitude ?? null,
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const payload: {
        name: string;
        address: string;
        phone: string | undefined;
        description: string | undefined;
        workingHours: { open: string; close: string };
        latitude?: number | null;
        longitude?: number | null;
      } = {
        name: form.name,
        address: form.address,
        phone: form.phone || undefined,
        description: form.description || undefined,
        workingHours: { open: form.workingHoursOpen, close: form.workingHoursClose },
        latitude: form.latitude ?? undefined,
        longitude: form.longitude ?? undefined,
      };
      const { data } = await api.put(`/api/rooms/${room!.id}`, payload);
      setRoom(data.data);
      setMsg('Saqlandi!');
    } catch (err) {
      setMsg(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Xona yaratish faqat SUPER_ADMIN'ga tegishli — adminga xona tayinlanadi
  if (!room) {
    return (
      <div className="neo-card rounded-2xl p-6 max-w-2xl">
        <h2 className="font-bold text-xl mb-3">Sizning xonangiz hali biriktirilmagan</h2>
        <p className="text-gray-400 text-sm leading-relaxed mb-4">
          Kompyuter xona platforma egaligi (Super Admin) tomonidan yaratiladi va sizga tayinlanadi.
          Xona biriktirilgach, bu yerda o\'z xonangizni boshqarishingiz mumkin.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2.5 rounded-xl border border-neon-cyan/30 text-neon-cyan text-sm font-bold flex items-center gap-2 hover:bg-neon-cyan/10"
        >
          <RefreshCw size={16} /> Yangilash
        </button>
      </div>
    );
  }

  return (
    <div className="neo-card rounded-2xl p-6 max-w-2xl">
      <h2 className="font-bold text-xl mb-4">Xona ma\'lumotlari</h2>
      {msg && (
        <div className={cn('mb-4 px-3 py-2.5 rounded-lg text-sm', msg.includes('xatolik') || msg.includes('Xatolik') ? 'bg-red-500/10 border border-red-500/30 text-red-300' : 'bg-neon-green/10 border border-neon-green/30 text-neon-green')}>
          <Check size={14} className="inline mr-1" />{msg}
        </div>
      )}
      <div className="space-y-4">
        <Input label="Nomi" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="Neon Arena" />
        <Input label="Manzil" value={form.address} onChange={(v) => setForm((f) => ({ ...f, address: v }))} placeholder="Toshkent, Yunusobod" />
        <Input label="Telefon" value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} placeholder="+998901112233" />
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Tavsif</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={3}
            className="glass-input w-full rounded-xl px-3 py-2.5 text-sm outline-none resize-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Ish boshlanish" value={form.workingHoursOpen} onChange={(v) => setForm((f) => ({ ...f, workingHoursOpen: v }))} placeholder="08:00" />
          <Input label="Ish tugash" value={form.workingHoursClose} onChange={(v) => setForm((f) => ({ ...f, workingHoursClose: v }))} placeholder="23:00" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Xonaning joylashuvi (xaritadan)</label>
          <MapPicker
            lat={form.latitude}
            lng={form.longitude}
            district={room?.district}
            onChange={(lat, lng) => setForm((f) => ({ ...f, latitude: lat, longitude: lng }))}
            onAddress={(addr) => setForm((f) => ({ ...f, address: addr }))}
          />
          {form.latitude != null && form.longitude != null && (
            <p className="text-[10px] text-gray-500 mt-1">
              Kenglik: {form.latitude.toFixed(5)}, Uzunlik: {form.longitude.toFixed(5)}
            </p>
          )}
        </div>
        <button onClick={save} disabled={saving} className="px-6 py-2.5 rounded-xl neon-btn text-sm font-bold flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {tC('save')}
        </button>
      </div>
    </div>
  );
}

/* ====================== ZONES TAB ====================== */
function ZonesTab({ room }: { room: Room }) {
  const tC = useTranslations('common');
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', type: 'GENERAL_HALL', capacity: 10, pricePerHour: 10000, description: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/rooms/${room.id}/zones`);
      setZones(data.data || []);
    } catch { /* skip */ }
    setLoading(false);
  }, [room.id]);

  useEffect(() => { load(); }, [load]);

  async function saveZone() {
    setSaving(true);
    try {
      const payload = { ...form, pricePerHour: Number(form.pricePerHour), capacity: Number(form.capacity) };
      if (editId) {
        await api.put(`/api/rooms/${room.id}/zones/${editId}`, payload);
      } else {
        await api.post(`/api/rooms/${room.id}/zones`, payload);
      }
      setForm({ name: '', type: 'GENERAL_HALL', capacity: 10, pricePerHour: 10000, description: '' });
      setEditId(null);
      load();
    } catch (err) {
      toastError(getApiErrorMessage(err));
    }
    setSaving(false);
  }

  function edit(z: Zone) {
    setEditId(z.id);
    setForm({ name: z.name, type: z.type, capacity: Number(z.capacity), pricePerHour: Number(z.pricePerHour), description: '' });
  }

  async function remove(id: string) {
    if (!await confirmDialog({ title: 'Zonani o\'chirish', message: 'O\'chirmoqchimisiz?', danger: true })) return;
    try { await api.delete(`/api/rooms/${room.id}/zones/${id}`); load(); } catch { /* skip */ }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="neo-card rounded-2xl p-5">
        <h3 className="font-bold mb-4">{editId ? 'Zonani tahrirlash' : 'Yangi zona'}</h3>
        <div className="space-y-3">
          <Input label="Nomi" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="VIP Zone" />
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Turi</label>
            <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className="glass-input w-full rounded-xl px-3 py-2.5 text-sm outline-none">
              {['GENERAL_HALL', 'VIP', 'CABIN'].map((t) => <option key={t} value={t}>{zoneTypeLabel(t)}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Sig'im" type="number" value={String(form.capacity)} onChange={(v) => setForm((f) => ({ ...f, capacity: Number(v) }))} />
            <Input label="Narx/soat (so'm)" type="number" value={String(form.pricePerHour)} onChange={(v) => setForm((f) => ({ ...f, pricePerHour: Number(v) }))} />
          </div>
          <div className="flex gap-2">
            <button onClick={saveZone} disabled={saving} className="px-5 py-2.5 rounded-xl neon-btn text-sm font-bold flex items-center gap-2 disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {editId ? 'Yangilash' : tC('save')}
            </button>
            {editId && <button onClick={() => { setEditId(null); setForm({ name: '', type: 'GENERAL_HALL', capacity: 10, pricePerHour: 10000, description: '' }); }} className="px-4 py-2.5 rounded-xl border border-gray-500/30 text-gray-400 text-sm"><X size={15} /></button>}
          </div>
        </div>
      </div>

      <div className="neo-card rounded-2xl p-5">
        <h3 className="font-bold mb-4">Zonalar ({zones.length})</h3>
        {loading ? (
          <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-16 rounded-xl bg-cyber-800 animate-pulse" />)}</div>
        ) : zones.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-10">Hali zona yo'q</p>
        ) : (
          <div className="space-y-2">
            {zones.map((z) => (
              <div key={z.id} className="flex items-center justify-between px-4 py-3 rounded-xl border border-neon-cyan/15 bg-cyber-800/50">
                <div>
                  <span className="font-medium">{z.name}</span>
                  <span className="text-xs text-gray-500 ml-2">({zoneTypeLabel(z.type)})</span>
                  <span className="text-xs text-neon-cyan ml-2">{formatPrice(z.pricePerHour)} so'm/soat</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => edit(z)} className="p-1.5 rounded-lg text-neon-cyan hover:bg-neon-cyan/10"><Pencil size={14} /></button>
                  <button onClick={() => remove(z.id)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ====================== COMPUTERS TAB ====================== */
function ComputersTab({ room }: { room: Room }) {
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [computers, setComputers] = useState<Computer[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', cpu: '', gpu: '', ram: '', status: 'AVAILABLE' });
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/api/rooms/${room.id}/zones`).then(({ data }) => {
      const z: Zone[] = data.data || [];
      setZones(z);
      if (z.length) setSelectedZoneId(z[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [room.id]);

  useEffect(() => {
    if (!selectedZoneId) return;
    api.get(`/api/rooms/${room.id}/zones/${selectedZoneId}/computers`).then(({ data }) => setComputers(data.data || [])).catch(() => setComputers([]));
  }, [selectedZoneId, room.id]);

  async function save() {
    setSaving(true);
    try {
      const payload: any = { name: form.name, specs: { cpu: form.cpu, gpu: form.gpu, ram: form.ram }, status: form.status };
      if (editId) {
        await api.put(`/api/rooms/${room.id}/zones/${selectedZoneId}/computers/${editId}`, payload);
      } else {
        await api.post(`/api/rooms/${room.id}/zones/${selectedZoneId}/computers`, payload);
      }
      setForm({ name: '', cpu: '', gpu: '', ram: '', status: 'AVAILABLE' });
      setEditId(null);
      const { data } = await api.get(`/api/rooms/${room.id}/zones/${selectedZoneId}/computers`);
      setComputers(data.data || []);
    } catch (err) { toastError(getApiErrorMessage(err)); }
    setSaving(false);
  }

  function edit(c: Computer) {
    setEditId(c.id);
    setForm({ name: c.name, cpu: c.specs?.cpu || '', gpu: c.specs?.gpu || '', ram: c.specs?.ram || '', status: c.status });
  }

  async function remove(id: string) {
    if (!await confirmDialog({ title: 'Kompyuterni o\'chirish', message: 'O\'chirmoqchimisiz?', danger: true })) return;
    try {
      await api.delete(`/api/rooms/${room.id}/zones/${selectedZoneId}/computers/${id}`);
      setComputers((prev) => prev.filter((c) => c.id !== id));
    } catch { /* skip */ }
  }

  async function toggleStatus(c: Computer) {
    const next = c.status === 'AVAILABLE' ? 'MAINTENANCE' : 'AVAILABLE';
    try {
      await api.patch(`/api/rooms/${room.id}/zones/${selectedZoneId}/computers/${c.id}/status`, { status: next });
      setComputers((prev) => prev.map((x) => x.id === c.id ? { ...x, status: next } : x));
    } catch { /* skip */ }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Zona tanlang</label>
        <select value={selectedZoneId} onChange={(e) => setSelectedZoneId(e.target.value)} className="glass-input rounded-xl px-3 py-2.5 text-sm outline-none max-w-xs">
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.type})</option>)}
        </select>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="neo-card rounded-2xl p-5">
          <h3 className="font-bold mb-4">{editId ? 'Kompyuterni tahrirlash' : 'Yangi kompyuter'}</h3>
          <div className="space-y-3">
            <Input label="Nomi" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="PC-01" />
            <Input label="CPU" value={form.cpu} onChange={(v) => setForm((f) => ({ ...f, cpu: v }))} placeholder="Intel i7-13700K" />
            <Input label="GPU" value={form.gpu} onChange={(v) => setForm((f) => ({ ...f, gpu: v }))} placeholder="RTX 4070" />
            <Input label="RAM" value={form.ram} onChange={(v) => setForm((f) => ({ ...f, ram: v }))} placeholder="32GB DDR5" />
            <div className="flex gap-2">
              <button onClick={save} disabled={saving} className="px-5 py-2.5 rounded-xl neon-btn text-sm font-bold flex items-center gap-2 disabled:opacity-50">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {editId ? 'Yangilash' : 'Saqlash'}
              </button>
              {editId && <button onClick={() => { setEditId(null); setForm({ name: '', cpu: '', gpu: '', ram: '', status: 'AVAILABLE' }); }} className="px-4 py-2.5 rounded-xl border border-gray-500/30 text-gray-400 text-sm"><X size={15} /></button>}
            </div>
          </div>
        </div>

        <div className="neo-card rounded-2xl p-5">
          <h3 className="font-bold mb-4">Kompyuterlar ({computers.length})</h3>
          {computers.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">Hali kompyuter yo'q</p>
          ) : (
            <div className="space-y-2">
              {computers.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-neon-cyan/15 bg-cyber-800/50 text-sm">
                  <div>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{c.specs?.cpu || ''}</span>
                    <span className={cn('ml-2 text-xs px-1.5 py-0.5 rounded', c.status === 'AVAILABLE' ? 'bg-neon-green/15 text-neon-green' : 'bg-yellow-500/15 text-yellow-400')}>{c.status}</span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => toggleStatus(c)} className="p-1.5 rounded-lg text-yellow-400 hover:bg-yellow-500/10" title="Status"><Monitor size={13} /></button>
                    <button onClick={() => edit(c)} className="p-1.5 rounded-lg text-neon-cyan hover:bg-neon-cyan/10"><Pencil size={13} /></button>
                    <button onClick={() => remove(c.id)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ====================== BOOKINGS TAB ====================== */
type BookingsError = { kind: 'unauthorized' | 'server' | 'network' | 'unknown'; message: string };

function classifyBookingsError(err: any): BookingsError {
  const status = err?.response?.status;
  if (status === 401) return { kind: 'unauthorized', message: 'Ruxsat muddati tugagan. Qaytadan kirib ko\'ring.' };
  if (status === 403) return { kind: 'unauthorized', message: 'Sizga bu bo\'limga ruxsat berilmagan.' };
  if (status && status >= 500) return { kind: 'server', message: 'Serverda xatolik yuz berdi. Qayta urinib ko\'ring.' };
  if (!err?.response && err?.request) return { kind: 'network', message: 'Internet aloqasi yo\'q. Tarmoqqa ulanganligingizni tekshiring.' };
  return { kind: 'unknown', message: getApiErrorMessage(err, 'Bronlarni yuklashda xatolik yuz berdi') };
}

function BookingsTab({ room }: { room?: Room | null }) {
  void room;
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<BookingsError | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  const load = useCallback(async (opts?: { silent?: boolean; page?: number }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const currentPage = opts?.page ?? 0;
      const { data } = await api.get('/api/bookings/admin/bookings', {
        params: { limit: PAGE_SIZE, offset: currentPage * PAGE_SIZE },
      });
      // Backend kontrakti: data = { success, message, data: { bookings: Booking[], total } }
      const list = data?.data?.bookings;
      setBookings(Array.isArray(list) ? list : []);
      setTotal(typeof data?.data?.total === 'number' ? data.data.total : (Array.isArray(list) ? list.length : 0));
      setPage(currentPage);
    } catch (err) {
      if (!opts?.silent) setError(classifyBookingsError(err));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Real vaqt: yangi bron / holat o'zgarishi / sahifa fokusiga qaytishda jimgina yangilash
  useEffect(() => {
    const onFocus = () => load({ silent: true, page });
    const onVisibility = () => { if (document.visibilityState === 'visible') load({ silent: true, page }); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const socket = getSocket();
    const onBookingChanged = () => load({ silent: true, page });
    socket.on('booking_status_changed', onBookingChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      socket.off('booking_status_changed', onBookingChanged);
    };
  }, [load, page]);

  // Bron tasdiqlash / rad etish — YAGONA yo'l: /admin/bookings/:id/approval.
  // Eski /status endpoint'i faqat CONFIRMED (approve) va CANCELLED ni qabul
  // qiladi; ACTIVE/COMPLETED o'tishlari faqat sessiya oqimi orqali bo'ladi.
  async function reviewApproval(id: string, action: 'approve' | 'reject', reason?: string) {
    setUpdatingId(id);
    try {
      const { data } = await api.patch(`/api/bookings/admin/bookings/${id}/approval`, { action, reason });
      const updated = data?.data;
      setBookings((prev) => prev.map((b) => (b.id === id
        ? { ...b, ...(updated && typeof updated === 'object' ? updated : {}), approvalStatus: action === 'approve' ? 'APPROVED' : 'REJECTED' }
        : b)));
      toastSuccess(action === 'approve' ? 'Bron tasdiqlandi' : 'Bron rad etildi');
    } catch (err) { toastError(getApiErrorMessage(err)); }
    finally { setUpdatingId(null); }
  }

  async function cancelBooking(id: string) {
    const ok = await confirmDialog({
      title: 'Bronni bekor qilish',
      message: 'Bron bekor qilinsinmi? Foydalanuvchi xabardor qilinadi.',
      confirmLabel: 'Bekor qilish',
      danger: true,
    });
    if (!ok) return;
    setUpdatingId(id);
    try {
      await api.patch(`/api/bookings/admin/bookings/${id}/status`, { status: 'CANCELLED', reason: 'Admin bekor qildi' });
      setBookings((prev) => prev.map((b) => (b.id === id ? { ...b, status: 'CANCELLED' } : b)));
      toastSuccess('Bron bekor qilindi');
    } catch (err) { toastError(getApiErrorMessage(err)); }
    finally { setUpdatingId(null); }
  }

  const STATUS_BADGE: Record<string, string> = {
    PENDING: 'bg-yellow-500/15 text-yellow-400', PENDING_PAYMENT: 'bg-orange-500/15 text-orange-400',
    PARTIALLY_PAID: 'bg-sky-500/15 text-sky-400', PAID: 'bg-neon-green/15 text-neon-green',
    CONFIRMED: 'bg-neon-cyan/15 text-neon-cyan',
    ACTIVE: 'bg-neon-green/15 text-neon-green', COMPLETED: 'bg-gray-500/15 text-gray-400', CANCELLED: 'bg-red-500/15 text-red-400',
  };

  const APPROVAL_BADGE: Record<string, string> = {
    PENDING: 'bg-yellow-500/15 text-yellow-400',
    APPROVED: 'bg-neon-green/15 text-neon-green',
    REJECTED: 'bg-red-500/15 text-red-400',
  };

  // To'lovni "to'langan" deb hisoblaydigan holatlar — backend PAID_STATUSES
  // bilan BIR XIL bo'lishi shart (eski kod faqat COMPLETED ni tekshirgan, shuning
  // uchun real PAYME/CLICK/PAYNET to'lovlari "To'lanmagan" ko'rinardi).
  const PAID_STATUSES = new Set(['PAID', 'COMPLETED']);
  const paidPayments = (b: Booking) => (Array.isArray(b.payments) ? b.payments : []).filter((p) => PAID_STATUSES.has(p.status));
  const paidTotal = (b: Booking) => paidPayments(b).reduce((acc, p) => acc + Number(p.amount || 0), 0);
  const paidMethods = (b: Booking) => paidPayments(b).map((p) => p.method || p.provider).filter(Boolean).join(', ');

  // Admin uchun "tasdiqlash mumkin"mi? Backend SESSION_STARTABLE =
  // CONFIRMED | PARTIALLY_PAID | PAID. Depozit to'langan (PARTIALLY_PAID)
  // bronni tasdiqlash ASOSIY oqim — u ham ko'rsatilishi kerak.
  const SESSION_STARTABLE = new Set(['CONFIRMED', 'PARTIALLY_PAID', 'PAID']);
  const isClosed = (b: Booking) => b.status === 'CANCELLED' || b.status === 'COMPLETED';
  const canApprove = (b: Booking) => !isClosed(b) && b.approvalStatus !== 'APPROVED' && SESSION_STARTABLE.has(b.status);

  return (
    <div className="neo-card rounded-2xl p-5">
      <h3 className="font-bold mb-4">Bronlar ({total})</h3>

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-16 rounded-xl bg-cyber-800 animate-pulse" />)}</div>
      ) : error ? (
        <div className="text-center py-12">
          <AlertCircle size={36} className="mx-auto mb-3 text-red-400" />
          <p className="text-sm text-gray-300 font-medium mb-1">
            {error.kind === 'unauthorized' ? 'Ruxsat muammosi' : error.kind === 'server' ? 'Server xatosi' : error.kind === 'network' ? 'Tarmoq xatosi' : 'Xatolik'}
          </p>
          <p className="text-sm text-gray-500 mb-5">{error.message}</p>
          <button
            onClick={() => load()}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl neon-btn text-sm font-bold"
          >
            <RefreshCw size={15} /> Qayta urinish
          </button>
        </div>
      ) : bookings.length === 0 ? (
        <div className="text-center py-14">
          <CalendarDays size={32} className="mx-auto mb-3 text-gray-600" />
          <p className="text-sm text-gray-500">Bronlar hozircha yo'q</p>
        </div>
      ) : (
        <div className="overflow-x-auto table-scroll-mobile">
          <table className="w-full min-w-[900px] text-sm table-hover">
            <thead>
              <tr className="text-gray-500 text-xs uppercase">
                <th className="text-left pb-2 pr-4">Foydalanuvchi</th>
                <th className="text-left pb-2 pr-4">Telefon</th>
                <th className="text-left pb-2 pr-4">Sana</th>
                <th className="text-left pb-2 pr-4">Vaqt</th>
                <th className="text-left pb-2 pr-4">Kompyuter</th>
                <th className="text-left pb-2 pr-4">Narx</th>
                <th className="text-left pb-2 pr-4">To'lov</th>
                <th className="text-left pb-2 pr-4">Holat</th>
                <th className="text-left pb-2 pr-4">Tasdiq</th>
                <th className="text-left pb-2">Amallar</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="border-t border-neon-cyan/10">
                  <td className="py-3 pr-4">
                    <span className="font-medium text-gray-100 flex items-center gap-2">
                      <span className="w-7 h-7 rounded-lg grid place-items-center text-[10px] font-bold bg-neon-cyan/10 border border-neon-cyan/20 text-neon-cyan shrink-0">
                        {((b.user?.fullName || '?').trim().charAt(0) || '?').toUpperCase()}
                      </span>
                      {b.user?.fullName?.trim() || (b.userId ? b.userId.slice(0, 8) : '—')}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-gray-300">{b.user?.phone || '—'}</td>
                  <td className="py-3 pr-4 text-gray-300">{b.date ? formatDate(b.date) : '—'}</td>
                  <td className="py-3 pr-4 text-gray-300">{b.startTime || '—'}—{b.endTime || '—'}</td>
                  <td className="py-3 pr-4 text-gray-300">{b.computer?.name || '—'}</td>
                  <td className="py-3 pr-4 font-medium text-neon-cyan">{formatPrice(b.finalPrice)}</td>
                  <td className="py-3 pr-4">
                    {paidPayments(b).length === 0 ? (
                      <span className="text-xs text-gray-600">To'lanmagan</span>
                    ) : (
                      <span>
                        <span className="font-medium text-neon-green">{formatPrice(paidTotal(b))} so'm</span>
                        {paidMethods(b) && <span className="text-[10px] text-gray-500 block">{paidMethods(b)}</span>}
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <span className={cn('px-2 py-1 rounded text-xs font-medium', STATUS_BADGE[b.status] || 'bg-gray-500/15 text-gray-400')}>{b.status}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className={cn('px-2 py-1 rounded text-xs font-medium', APPROVAL_BADGE[b.approvalStatus || 'PENDING'] || 'bg-gray-500/15 text-gray-400')}>
                      {b.approvalStatus === 'APPROVED' ? 'Tasdiqlandi' : b.approvalStatus === 'REJECTED' ? 'Rad etildi' : 'Kutilmoqda'}
                    </span>
                    {b.rejectionReason && (
                      <span className="block text-[10px] text-red-400/80 mt-1 max-w-[180px] truncate" title={b.rejectionReason}>
                        {b.rejectionReason}
                      </span>
                    )}
                  </td>
                  <td className="py-3">
                    {updatingId === b.id ? (
                      <Loader2 size={14} className="animate-spin text-neon-cyan" />
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        {canApprove(b) && (
                          <button onClick={() => reviewApproval(b.id, 'approve')} className="text-xs text-neon-green hover:underline">
                            Tasdiqlash
                          </button>
                        )}
                        {canApprove(b) && (
                          <button
                            onClick={async () => {
                              // Sabab MAJBURIY — backend `reason` bo'lmasa rad etadi.
                              const reason = await promptDialog({
                                title: 'Bronni rad etish',
                                message: 'Sababni yozing — foydalanuvchiga ko\'rsatiladi.',
                                confirmLabel: 'Rad etish',
                                danger: true,
                                input: { label: 'Sabab', placeholder: 'Masalan: to\'lov tasdiqlanmadi', required: true, maxLength: 500 },
                              });
                              if (reason) reviewApproval(b.id, 'reject', reason);
                            }}
                            className="text-xs text-red-400 hover:underline"
                          >
                            Rad etish
                          </button>
                        )}
                        {!isClosed(b) && (
                          <button onClick={() => cancelBooking(b.id)} className="text-xs text-gray-400 hover:underline">
                            Bekor qilish
                          </button>
                        )}
                        {b.approvalStatus === 'APPROVED' && b.status === 'ACTIVE' && (
                          <span className="text-[10px] text-gray-500">Sessiya faol</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-neon-cyan/10">
          <span className="text-xs text-gray-500">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} / {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => load({ page: page - 1 })}
              disabled={page === 0 || loading}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-cyber-800 hover:bg-cyber-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Oldingi
            </button>
            <button
              onClick={() => load({ page: page + 1 })}
              disabled={(page + 1) * PAGE_SIZE >= total || loading}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-cyber-800 hover:bg-cyber-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Keyingi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ====================== PROMOS TAB ====================== */
function PromosTab({ room }: { room: Room }) {
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ code: '', discountType: 'PERCENTAGE', discountValue: 10, minBookingAmount: 0, maxUses: 100, startsAt: todayISO(), expiresAt: '', usageLimitPerUser: 1, isPersonal: false, recipientPhone: '', recipientEmail: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get('/api/promo'); setPromos(data.data || []); } catch { /* skip */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      const payload: any = {
        code: form.code.toUpperCase(), discountType: form.discountType,
        discountValue: Number(form.discountValue), minBookingAmount: Number(form.minBookingAmount),
        maxUses: Number(form.maxUses), startsAt: form.startsAt, expiresAt: form.expiresAt,
        usageLimitPerUser: Number(form.usageLimitPerUser) || 1,
      };
      if (form.isPersonal) {
        payload.isPersonal = true;
        if (form.recipientPhone.trim()) payload.recipientPhone = form.recipientPhone.trim();
        if (form.recipientEmail.trim()) payload.recipientEmail = form.recipientEmail.trim().toLowerCase();
      }
      if (editId) { await api.patch(`/api/promo/${editId}`, payload); }
      else { await api.post('/api/promo', payload); }
      setForm({ code: '', discountType: 'PERCENTAGE', discountValue: 10, minBookingAmount: 0, maxUses: 100, startsAt: todayISO(), expiresAt: '', usageLimitPerUser: 1, isPersonal: false, recipientPhone: '', recipientEmail: '' });
      setEditId(null);
      load();
    } catch (err) { toastError(getApiErrorMessage(err)); }
    setSaving(false);
  }

  function edit(p: PromoCode) {
    setEditId(p.id);
    setForm({ code: p.code, discountType: p.discountType, discountValue: Number(p.discountValue), minBookingAmount: Number(p.minBookingAmount || 0), maxUses: p.maxUses || 100, startsAt: p.startsAt.slice(0, 10), expiresAt: p.expiresAt.slice(0, 10), usageLimitPerUser: p.usageLimitPerUser || 1, isPersonal: !!p.isPersonal, recipientPhone: p.recipientPhone || '', recipientEmail: p.recipientEmail || '' });
  }

  async function remove(id: string) {
    if (!await confirmDialog({ title: 'Promo-kodni o\'chirish', message: 'O\'chirmoqchimisiz?', danger: true })) return;
    try { await api.delete(`/api/promo/${id}`); load(); } catch { /* skip */ }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="neo-card rounded-2xl p-5">
        <h3 className="font-bold mb-4">{editId ? 'Promo tahrirlash' : 'Yangi promo-kod'}</h3>
        <div className="space-y-3">
          <Input label="Kod" value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v.toUpperCase() }))} placeholder="YANGIYIL25" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Turi</label>
              <select value={form.discountType} onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value }))} className="glass-input w-full rounded-xl px-3 py-2.5 text-sm outline-none">
                <option value="PERCENTAGE">Foiz (%)</option>
                <option value="FIXED">Aniq (so'm)</option>
              </select>
            </div>
            <Input label="Qiymat" type="number" value={String(form.discountValue)} onChange={(v) => setForm((f) => ({ ...f, discountValue: Number(v) }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Min summa" type="number" value={String(form.minBookingAmount)} onChange={(v) => setForm((f) => ({ ...f, minBookingAmount: Number(v) }))} />
            <Input label="Maks ishlatish" type="number" value={String(form.maxUses)} onChange={(v) => setForm((f) => ({ ...f, maxUses: Number(v) }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="1 foydalanuvchiga necha marta (1-20)" type="number" value={String(form.usageLimitPerUser)} onChange={(v) => setForm((f) => ({ ...f, usageLimitPerUser: Number(v) }))} />
            <label className="flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={form.isPersonal}
                onChange={(e) => setForm((f) => ({ ...f, isPersonal: e.target.checked }))}
                className="accent-neon-cyan w-4 h-4"
              />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Shaxsiy</span>
            </label>
          </div>
          {form.isPersonal && (
            <div className="space-y-3 rounded-xl border border-neon-green/20 bg-neon-green/5 p-3">
              <p className="text-[11px] text-gray-400">Shaxsiy kod faqat aniq foydalanuvchiga beriladi (telefon yoki email orqali identifikatsiya, IP emas).</p>
              <Input label="Qabul qiluvchi telefon" value={form.recipientPhone} onChange={(v) => setForm((f) => ({ ...f, recipientPhone: v }))} placeholder="+998901234567" />
              <Input label="Qabul qiluvchi email" value={form.recipientEmail} onChange={(v) => setForm((f) => ({ ...f, recipientEmail: v }))} placeholder="user@example.com" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Boshlanish" type="date" value={form.startsAt} onChange={(v) => setForm((f) => ({ ...f, startsAt: v }))} />
            <Input label="Tugash" type="date" value={form.expiresAt} onChange={(v) => setForm((f) => ({ ...f, expiresAt: v }))} />
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} className="px-5 py-2.5 rounded-xl neon-btn text-sm font-bold flex items-center gap-2 disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {editId ? 'Yangilash' : 'Saqlash'}
            </button>
            {editId && <button onClick={() => { setEditId(null); setForm({ code: '', discountType: 'PERCENTAGE', discountValue: 10, minBookingAmount: 0, maxUses: 100, startsAt: todayISO(), expiresAt: '', usageLimitPerUser: 1, isPersonal: false, recipientPhone: '', recipientEmail: '' }); }} className="px-4 py-2.5 rounded-xl border border-gray-500/30 text-gray-400 text-sm"><X size={15} /></button>}
          </div>
        </div>
      </div>

      <div className="neo-card rounded-2xl p-5">
        <h3 className="font-bold mb-4">Promo-kodlar ({promos.length})</h3>
        {loading ? <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-16 rounded-xl bg-cyber-800 animate-pulse" />)}</div>
          : promos.length === 0 ? <p className="text-sm text-gray-500 text-center py-10">Promo yo'q</p> : (
          <div className="space-y-2">
            {promos.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3 rounded-xl border border-neon-cyan/15 bg-cyber-800/50">
                <div>
                  <span className="font-bold text-neon-green">{p.code}</span>
                  <span className="text-xs text-gray-500 ml-2">{p.discountType === 'PERCENTAGE' ? `${p.discountValue}%` : `${formatPrice(p.discountValue)} so'm`}</span>
                  <span className="text-xs text-gray-600 ml-2">Ishlatildi: {p.usedCount}/{p.maxUses || '∞'}</span>
                  {p.usageLimitPerUser !== undefined && p.usageLimitPerUser !== 1 && (
                    <span className="text-[10px] text-gray-500 ml-2">1 user: {p.usageLimitPerUser}×</span>
                  )}
                  {(p as any).isPersonal && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neon-green/15 text-neon-green border border-neon-green/25 ml-2 uppercase tracking-wider">Shaxsiy</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => edit(p)} className="p-1.5 rounded-lg text-neon-cyan hover:bg-neon-cyan/10"><Pencil size={14} /></button>
                  <button onClick={() => remove(p.id)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ====================== NEWS TAB ====================== */
function NewsTab({ room }: { room: Room | null }) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ title: '', content: '', type: 'NEWS' as const, imageUrl: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get('/api/news'); setNews(data.data || []); } catch { /* skip */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      const payload: any = { ...form, roomId: room?.id || null, imageUrl: form.imageUrl || undefined };
      if (editId) { await api.put(`/api/news/${editId}`, payload); }
      else { await api.post('/api/news', payload); }
      setForm({ title: '', content: '', type: 'NEWS', imageUrl: '' });
      setEditId(null);
      load();
    } catch (err) { toastError(getApiErrorMessage(err)); }
    setSaving(false);
  }

  function edit(n: NewsItem) {
    setEditId(n.id);
    setForm({ title: n.title, content: n.content, type: n.type as any, imageUrl: n.imageUrl || '' });
  }

  async function remove(id: string) {
    if (!await confirmDialog({ title: 'Yangilikni o\'chirish', message: 'O\'chirmoqchimisiz?', danger: true })) return;
    try { await api.delete(`/api/news/${id}`); load(); } catch { /* skip */ }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="neo-card rounded-2xl p-5">
        <h3 className="font-bold mb-4">{editId ? 'Yangilikni tahrirlash' : 'Yangi yangilik'}</h3>
        <div className="space-y-3">
          <Input label="Sarlavha" value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v }))} placeholder="Yangi tarif!" />
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Matn</label>
            <textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} rows={4} className="glass-input w-full rounded-xl px-3 py-2.5 text-sm outline-none resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Turi</label>
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as any }))} className="glass-input w-full rounded-xl px-3 py-2.5 text-sm outline-none">
                <option value="NEWS">Yangilik</option>
                <option value="PROMOTION">Aktsiya</option>
                <option value="BANNER">Reklama</option>
              </select>
            </div>
            <Input label="Rasm URL" value={form.imageUrl} onChange={(v) => setForm((f) => ({ ...f, imageUrl: v }))} placeholder="https://..." />
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} className="px-5 py-2.5 rounded-xl neon-btn text-sm font-bold flex items-center gap-2 disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {editId ? 'Yangilash' : 'Saqlash'}
            </button>
            {editId && <button onClick={() => { setEditId(null); setForm({ title: '', content: '', type: 'NEWS', imageUrl: '' }); }} className="px-4 py-2.5 rounded-xl border border-gray-500/30 text-gray-400 text-sm"><X size={15} /></button>}
          </div>
        </div>
      </div>

      <div className="neo-card rounded-2xl p-5">
        <h3 className="font-bold mb-4">Yangiliklar ({news.length})</h3>
        {loading ? <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-16 rounded-xl bg-cyber-800 animate-pulse" />)}</div>
          : news.length === 0 ? <p className="text-sm text-gray-500 text-center py-10">Yangilik yo'q</p> : (
          <div className="space-y-2">
            {news.map((n) => (
              <div key={n.id} className="flex items-center justify-between px-4 py-3 rounded-xl border border-neon-cyan/15 bg-cyber-800/50">
                <div>
                  <span className="font-medium">{n.title}</span>
                  <span className="text-xs text-gray-500 ml-2">{n.type}</span>
                  <span className="text-xs text-gray-600 ml-2">{formatDate(n.publishedAt)}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => edit(n)} className="p-1.5 rounded-lg text-neon-cyan hover:bg-neon-cyan/10"><Pencil size={14} /></button>
                  <button onClick={() => remove(n.id)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ====================== STATS TAB ====================== */
function StatsTab({ room }: { room: Room }) {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/rooms/${room.id}/stats`).then(({ data }) => setStats(data.data)).finally(() => setLoading(false));
  }, [room.id]);

  if (loading) return <div className="neo-card rounded-2xl h-64 animate-pulse" />;
  if (!stats) return <p className="text-gray-500 text-center py-10">Statistika mavjud emas</p>;

  const cards = [
    { icon: CalendarDays, label: 'Jami bronlar', value: stats.totalBookings ?? 0, color: 'text-neon-cyan' },
    { icon: CircleDollarSign, label: 'Jami tushum', value: `${formatPrice(stats.totalRevenue ?? 0)} so'm`, color: 'text-neon-green' },
    { icon: TrendingUp, label: 'O\'rtacha narx', value: `${formatPrice(stats.avgBookingPrice ?? 0)} so'm`, color: 'text-neon-magenta' },
    { icon: Users, label: 'Zonalar', value: stats.totalZones ?? room._count?.zones ?? 0, color: 'text-neon-purple' },
    { icon: Monitor, label: 'Kompyuterlar', value: stats.totalComputers ?? 0, color: 'text-yellow-400' },
    { icon: Zap, label: 'Aktiv bronlar', value: stats.activeBookings ?? 0, color: 'text-neon-green' },
  ];

  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((c, i) => (
        <div
          key={c.label}
          className="neo-card rounded-2xl p-5 text-center hover-glow animate-pop"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl grid place-items-center border border-white/10 bg-cyber-800/60">
            <c.icon size={22} className={c.color} />
          </div>
          <div className="text-2xl font-extrabold neon-text">{c.value}</div>
          <div className="text-xs text-gray-500 mt-1 uppercase tracking-wider">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ====================== SHARED INPUT ====================== */
function Input({ label, value, onChange, type = 'text', placeholder = '' }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="glass-input w-full rounded-xl px-3 py-2.5 text-sm outline-none"
      />
    </div>
  );
}