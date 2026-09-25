'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import {
  Loader2, CheckCircle2, Wallet, Banknote, AlertCircle,
  ArrowRight, BadgePercent, Clock, MapPin, Monitor, ChevronLeft, RefreshCw, FlaskConical,
} from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import api, { getApiErrorMessage } from '@/lib/api';
import type { Booking } from '@/lib/types';
import { formatPrice, formatDate, cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import TicketQR from '@/components/booking/TicketQR';
import SplashLoader from '@/components/ui/SplashLoader';
import ProviderLogo from '@/components/payments/ProviderLogo';

type PayMethod = 'PAYME' | 'CLICK' | 'UZUM' | 'PAYNET' | 'CASH';

const PROVIDER_UI: Record<string, { label: string; sub: string }> = {
  PAYME: { label: 'Payme', sub: 'Telefon ilovasi' },
  CLICK: { label: 'Click', sub: 'Tez va oson' },
  UZUM: { label: 'Uzum', sub: 'Raqamli bank' },
  PAYNET: { label: 'Paynet', sub: 'To\'lov terminali' },
  CASH: { label: 'Kassada', sub: 'Naqd pulda to\'lash' },
};

const SETTLED_BOOKING_STATUSES = ['PARTIALLY_PAID', 'PAID', 'CONFIRMED', 'ACTIVE', 'COMPLETED'];
const TERMINAL_FAILED_PAYMENT = ['FAILED', 'CANCELLED', 'EXPIRED'];

interface ProviderInfo {
  method: string;
  label: string;
  available: boolean;
}

export default function CheckoutPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  void params;
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sandbox, setSandbox] = useState(false);
  const [method, setMethod] = useState<PayMethod>('CASH');

  const [paying, setPaying] = useState(false);
  const [cashNotified, setCashNotified] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifyPayment, setVerifyPayment] = useState<{ id: string } | null>(null);
  const [polling, setPolling] = useState(false);

  // Idempotency kaliti: bitta to'lov urinishida barqaror qoladi.
  // Sahifa yangilanganda yangi kalit yaratiladi (yangi to'lov niyati).
  const payIdemKey = useRef<string>(`pay_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`);

  // Provayderlar holati (qaysilari ulangan — backend javobi)
  useEffect(() => {
    api
      .get('/api/payments/providers')
      .then(({ data }) => {
        const d = data.data;
        setProviders((d?.providers as ProviderInfo[]) || []);
        setSandbox(Boolean(d?.sandbox));
      })
      .catch(() => setProviders([]));
  }, []);

  // Bronni yuklash + oynada pid/test bo'lsa tasdiqlash jarayonini boshlash
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/bookings/${id}`)
      .then(({ data }) => {
        const b = data.data as Booking;
        if (cancelled) return;
        setBooking(b);
        if (SETTLED_BOOKING_STATUSES.includes(b.status)) setVerified(true);
      })
      .catch((err) => { if (!cancelled) setError(getApiErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    // Provayderdan qaytish URL: /checkout/:id/pay?pid=...
    const search = new URLSearchParams(window.location.search);
    const pid = search.get('pid');
    if (pid && !cancelled) {
      setVerifyPayment({ id: pid });
    } else if (!cancelled) {
      // Davom etmagan sessiyani qayta boshlash (aktiv to'lov bor bo'lsa)
      api
        .get(`/api/payments/${id}`)
        .then(({ data }) => {
          const active = (data.data?.payments as any[] | undefined)
            ?.find((p) => ['CREATED', 'REDIRECT_REQUIRED', 'PROCESSING'].includes(p.status));
          if (active && !cancelled) setVerifyPayment({ id: active.id });
        })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [id]);

  // To'lov holatini backend'dan kuzatish (server bu yerda provayder bilan verify qiladi)
  useEffect(() => {
    if (!verifyPayment) return;
    let cancelled = false;
    let tries = 0;
    setPolling(true);
    const poll = async () => {
      if (cancelled) return;
      // Background tab — pollingni pauza qilamiz (tries isrof bo'lmasin), qaytganimizda davom etadi.
      if (document.visibilityState === 'hidden') {
        setTimeout(poll, 5000);
        return;
      }
      try {
        const { data } = await api.get(`/api/payments/${verifyPayment.id}/status`);
        const st = data.data?.payment?.status as string | undefined;
        const bst = data.data?.bookingStatus as string | undefined;
        if ((st && ['PAID', 'COMPLETED'].includes(st)) || (bst && SETTLED_BOOKING_STATUSES.includes(bst))) {
          setVerified(true);
          setPolling(false);
          api.get(`/api/bookings/${id}`).then((r) => { if (!cancelled) setBooking(r.data.data); }).catch(() => undefined);
          return;
        }
        if (st && TERMINAL_FAILED_PAYMENT.includes(st)) {
          setError('To\'lov amalga oshmadi. Boshqa usul bilan qayta urinib ko\'ring.');
          setPolling(false);
          return;
        }
      } catch {
        // tarmoq xatosi — qayta urinamiz
      }
      tries += 1;
      if (tries < 16 && !cancelled) setTimeout(poll, 2500);
      else if (!cancelled) {
        setPolling(false);
        if (!verified) setError('To\'lov holati hali tasdiqlanmadi. Bir ozdan so\'ng qayta tekshiring yoki kabinetdan kuzating.');
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [verifyPayment, id]);

  // To'lov sessiyasini yaratish (backend summani o'zi hisoblaydi)
  async function startPay(m: PayMethod) {
    if (!booking) return;
    setPaying(true);
    setError(null);
    try {
      const { data } = await api.post('/api/payments/create', {
        bookingId: booking.id,
        method: m,
        idempotencyKey: payIdemKey.current,
      });
      const d = data.data;
      if (m === 'CASH' || (data.data?.method === 'CASH')) {
        setCashNotified(true);
      } else if (d?.checkoutUrl) {
        window.location.href = d.checkoutUrl;
      } else {
        setError(getApiErrorMessage(null, 'To\'lov xizmati hozircha mavjud emas. Iltimos, kassada to\'lash usulini tanlang.'));
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'To\'lovda xatolik yuz berdi'));
    } finally {
      setPaying(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16">
        <SplashLoader label="Bron yuklanmoqda..." />
      </div>
    );
  }

  if (error && !booking && !verifyPayment) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
        <p className="text-gray-300">{error}</p>
        <Link href="/rooms" className="inline-block mt-4 text-neon-cyan hover:underline">Xonalar</Link>
      </div>
    );
  }
  if (!booking) return null;

  const settled = SETTLED_BOOKING_STATUSES.includes(booking.status);
  const isPending = booking.status === 'PENDING' || booking.status === 'PENDING_PAYMENT';
  const advance = Number(booking.advanceAmount);
  const remaining = Number(booking.remainingAmount);
  const depositPercent = Number(booking.depositPercent) || 30;
  const remainderPercent = Math.max(0, 100 - depositPercent);

  const methodUi = PROVIDER_UI[method];

  const onlineMethods = providers;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 pb-24">
      <button
        onClick={() => router.push('/dashboard')}
        className="flex items-center gap-1 text-sm text-gray-400 hover:text-white mb-5"
      >
        <ChevronLeft size={16} /> Kabinetga qaytish
      </button>

      <h1 className="text-2xl font-extrabold tracking-tight mb-1">To'lov</h1>
      <p className="text-gray-400 text-sm mb-6">Broningizni tasdiqlash uchun {depositPercent}% oldindan to'lov</p>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-300">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {cashNotified && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-sm text-amber-300">
          <Wallet size={16} />
          Ruxsat berildi: {depositPercent}% ini kassada to'laysiz. Admin xabarnoma oldi va bronni tasdiqlaydi. Bronni kuzatish: <Link href="/dashboard" className="underline">Kabinet</Link>
        </div>
      )}

      {polling && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-neon-cyan/10 border border-neon-cyan/30 text-sm text-neon-cyan">
          <Loader2 size={16} className="animate-spin" />
          To'lov holati tekshirilmoqda...
        </div>
      )}

      {/* Booking xulosasi */}
      <div className="neo-card rounded-2xl p-5 mb-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-bold text-lg text-neon-cyan">{booking.room?.name}</h3>
            <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
              <MapPin size={11} /> {booking.room?.address}
            </p>
          </div>
          <span className={cn('px-2.5 py-1 text-xs font-bold rounded-lg border',
            settled ? 'bg-neon-green/15 text-neon-green border-neon-green/30'
              : 'bg-amber-500/15 text-amber-400 border-amber-500/30')}>
            {settled ? 'Tasdiqlandi' : 'To\'lov kutilmoqda'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-white/5 surface px-3 py-2 text-gray-300">
            <span className="text-xs text-gray-500 flex items-center gap-1"><Clock size={11} /> Sana</span>
            {formatDate(booking.date)} · {booking.startTime}—{booking.endTime}
          </div>
          <div className="rounded-lg border border-white/5 surface px-3 py-2 text-gray-300">
            <span className="text-xs text-gray-500 flex items-center gap-1"><Monitor size={11} /> Kompyuter</span>
            {booking.computer?.name || 'Avtomatik'}
          </div>
        </div>

        <div className="h-px bg-white/5 my-3" />

        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between text-gray-400">
            <span>Umumiy summa</span>
            <span>{formatPrice(booking.finalPrice)} so'm</span>
          </div>
          {Number(booking.discountAmount) > 0 && (
            <div className="flex justify-between text-neon-green">
              <span className="flex items-center gap-1"><BadgePercent size={12} /> Chegirma</span>
              <span>-{formatPrice(booking.discountAmount)} so'm</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-lg">
            <span>{depositPercent}% oldindan</span>
            <span className="neon-text">{formatPrice(advance)} so'm</span>
          </div>
          <div className="flex justify-between text-gray-400 text-xs">
            <span>Qolgan {remainderPercent}% (joyda)</span>
            <span>{formatPrice(remaining)} so'm</span>
          </div>
        </div>
      </div>

      {isPending && !settled ? (
        <>
          {sandbox && (
            <div className="rounded-xl border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-200 mb-4">
              <FlaskConical size={15} className="inline mr-1.5 -mt-0.5" />
              <span className="font-semibold">Test rejimi:</span> to'lovlar sinov tariqasida mustaqil o'tadi, haqiqiy pul olinmaydi. Real to'lovlar provayder kalitlari ulangach yoqiladi.
            </div>
          )}

          {/* To'lov usulini tanlash */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 mb-5">
            {[...onlineMethods, { method: 'CASH', label: 'Kassada', available: true }].map((p) => {
              const ui = PROVIDER_UI[p.method];
              const disabled = !p.available;
              const selected = method === p.method;
              return (
                <button
                  key={p.method}
                  onClick={() => setMethod(p.method as PayMethod)}
                  disabled={disabled}
                  className={cn(
                    'flex items-center gap-3 px-3.5 py-3.5 rounded-xl border text-left transition-colors',
                    selected
                      ? 'border-neon-cyan/50 bg-neon-cyan/10'
                      : 'border-white/10 surface hover:border-white/25',
                    disabled && 'opacity-45'
                  )}
                >
                  <span className="shrink-0 grid place-items-center w-10 h-10 rounded-lg bg-white/5 border border-white/10">
                    <ProviderLogo method={p.method} size={24} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold truncate">{ui?.label || p.label}</span>
                    <span className="block text-[11px] text-gray-500 truncate">
                      {p.available ? (ui?.sub || '') : 'Hozircha sozlanmagan'}
                    </span>
                  </span>
                  <span className={cn('shrink-0 w-4 h-4 rounded-full border transition-colors', selected ? 'border-neon-cyan bg-neon-cyan/30' : 'border-white/20')} />
                </button>
              );
            })}
          </div>

          {method !== 'CASH' ? (
            <div className="neo-card rounded-2xl p-5 mb-5 flex items-center gap-4">
              <span className="p-1.5 shrink-0"><ProviderLogo method={method} size={36} /></span>
              <div className="flex-1">
                <h3 className="font-semibold text-sm">{methodUi?.label} orqali to'lash</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  To'lov ilovasi yoki provider sahifasi ochiladi — to'lov server tomonidan tasdiqlanadi.
                </p>
              </div>
              <Link href="/dashboard" className="text-xs text-neon-cyan hover:underline shrink-0">Bekor qilish</Link>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm text-amber-200 mb-5">
              <p className="flex items-center gap-2 font-semibold">
                <Banknote size={16} /> {depositPercent}% ini kassada to'laysiz
              </p>
              <p className="text-xs text-gray-400 mt-1.5">
                Bron davomida qolgan {remainderPercent}% ni ham kassada to'lashingiz mumkin. Admin sizning broningizni kassada to'lov qabul qilgandan so'ng tasdiqlaydi.
              </p>
            </div>
          )}

          {verifyPayment && !verified && polling && (
            <p className="text-xs text-gray-500 text-center mb-3">
              To'lovni ilovada tasdiqlaganingizdan so'ng bu yerda avtomatik yangilanadi.
            </p>
          )}

          <button
            onClick={() => startPay(method)}
            disabled={paying || polling || (method !== 'CASH' && !(providers.find((p) => p.method === method)?.available))}
            className="w-full py-3.5 rounded-xl neon-btn flex items-center justify-center gap-2 font-bold disabled:opacity-40"
          >
            {paying ? (
              <><Loader2 size={18} className="animate-spin" /> To'lanmoqda...</>
            ) : polling ? (
              <><RefreshCw size={18} className="animate-spin" /> Tekshirilmoqda...</>
            ) : (
              <>
                {method === 'CASH' ? 'Kassada to\'layman' : <>To'lash: {formatPrice(advance)} so'm</>}
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </>
      ) : (
        <>
          {(settled || verified) && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-neon-green/10 border border-neon-green/30 text-sm text-neon-green">
              <CheckCircle2 size={16} /> To'lov muvaffaqiyatli. Broningiz tasdiqlandi!
            </div>
          )}
          <TicketQR booking={booking} userName={user?.fullName} />
          <Link
            href="/dashboard"
            className="mt-4 w-full block text-center py-3.5 rounded-xl neon-btn font-bold"
          >
            Qolgan {remainderPercent}% joyda — Kabinetga o'tish
          </Link>
        </>
      )}
    </div>
  );
}