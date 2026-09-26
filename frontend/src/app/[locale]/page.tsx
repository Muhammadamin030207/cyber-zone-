'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { Search, ArrowRight, MapPin } from 'lucide-react';
import api from '@/lib/api';
import type { Room } from '@/lib/types';
import RoomCard from '@/components/rooms/RoomCard';
import HeroCountdownCard from '@/components/home/HeroCountdownCard';

const HOME_ROOM_LIMIT = 6;

export default function HomePage() {
  const t = useTranslations('home');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/api/rooms')
      .then(({ data }) => setRooms(data.data))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    router.push(query ? `/rooms?q=${encodeURIComponent(query)}` : '/rooms');
  }

  const total = rooms.length;
  const visible = rooms.slice(0, HOME_ROOM_LIMIT);

  return (
    <div>
      {/* ===== HERO ===== */}
      <HeroCountdownCard
        targetDate="2026-11-30T20:00:00.000Z"
        eventLabel="Cyber Tournament"
        eventTitle="NEXUS CUP"
        ctaHref="/rooms"
      />

      {/* ===== SEARCH ZONE ===== */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-20 sm:pt-24 pb-12 text-center">
        <h2 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight mb-3">
          <span className="grad-text">{t('heroTitle')}</span>
        </h2>
        <p className="text-sm sm:text-base text-gray-400 max-w-2xl mx-auto mb-8">
          {t('heroSubtitle')}
        </p>

        <form
          onSubmit={submitSearch}
          role="search"
          className="max-w-2xl mx-auto flex flex-col sm:flex-row gap-2 p-1.5 sm:p-2 surface rounded-2xl"
        >
          <label htmlFor="home-room-search" className="flex-1 flex items-center gap-3 px-3 sm:px-4">
            <Search size={18} className="text-gray-400 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t('searchPlaceholder')}</span>
            <input
              id="home-room-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="flex-1 min-w-0 bg-transparent outline-none py-2.5 sm:py-3 text-sm placeholder:text-gray-500"
            />
          </label>
          <button type="submit" className="sm:self-center px-5 py-2.5 sm:py-3 rounded-xl neon-btn text-sm">
            {t('searchBtn')}
          </button>
        </form>
      </section>

      {/* ===== POPULAR ROOMS ===== */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="mb-6 sm:mb-8">
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight">{t('popularTitle')}</h2>
          <p className="text-gray-400 text-sm mt-1">{t('popularSubtitle')}</p>
          <p className="text-neon-cyan text-sm font-bold mt-1" role="status" aria-live="polite">
            {loading ? tCommon('loading') : total > HOME_ROOM_LIMIT
              ? t('roomsCountTruncated', { shown: visible.length, count: total })
              : t('roomsCount', { count: total })}
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6" aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton rounded-2xl h-72" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-500 surface rounded-2xl px-4 py-8 text-center">{t('roomsEmpty')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {visible.map((room) => (
              <RoomCard key={room.id} room={room} />
            ))}
          </div>
        )}
      </section>

      {/* ===== MAP CTA ===== */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="rounded-2xl border border-white/10 bg-[color-mix(in_srgb,var(--bg-1)_85%,transparent)] p-8 sm:p-12 text-center">
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight mb-2 flex items-center justify-center gap-2">
            <MapPin size={20} className="text-neon-cyan shrink-0" aria-hidden="true" /> {t('mapTitle')}
          </h2>
          <p className="text-gray-400 text-sm sm:text-base mb-6">{t('mapSubtitle')}</p>
          <Link href="/rooms" className="inline-flex items-center gap-2 px-7 py-3 rounded-xl neon-btn text-sm">
            {t('mapCta')} <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  );
}
