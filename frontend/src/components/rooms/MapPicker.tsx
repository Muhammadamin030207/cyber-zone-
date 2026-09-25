'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, LocateFixed, Search, Loader2, Navigation } from 'lucide-react';
import { TASHKENT_CENTER, DISTRICT_COORDS, matchDistrictKey } from '@/lib/constants';

interface GeoResult {
  lat: number;
  lng: number;
  label: string;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';

/**
 * Interaktiv joy tanlagich — super_admin xona yaratishda ishlatiladi.
 * - Xaritaga bosing -> marker + avtomatik manzil (reverse geocode)
 * - "Mening joylashuvim" -> brauzer geolokatsiyasi (avtomatik o'qish)
 * - Manzil qidirish -> Nominatim (OSM) bo'yicha qidiruv + tanlash
 *
 * Map xaritani siqmaydigan katta responive maydon (camdan 360px, tablet 420px,
 * desktop 480px), qidiruv esa xarita ustida FLYING search bar ko'rinishida turadi.
 */
export default function MapPicker({
  lat,
  lng,
  onChange,
  onAddress,
  district,
  height,
}: {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  onAddress?: (address: string) => void;
  district?: string | null;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const revAbort = useRef<AbortController | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [locating, setLocating] = useState(false);
  const [resolved, setResolved] = useState<string>('');
  const [geoErr, setGeoErr] = useState<string | null>(null);

  const makeMarker = (la: number, ln: number) => {
    if (markerRef.current) markerRef.current.remove();
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:38px;height:38px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
        background:linear-gradient(135deg,#10b981,#f59e0b);border:2.5px solid #fff;
        box-shadow:0 6px 18px rgba(16,185,129,.55);display:flex;align-items:center;justify-content:center;
      "><div style="transform:rotate(45deg);font-size:14px;color:#000;font-weight:900;">PC</div></div>`,
      iconSize: [38, 38],
      iconAnchor: [8, 34],
    });
    markerRef.current = L.marker([la, ln], { icon }).addTo(mapRef.current!);
  };

  const reverseGeocode = useCallback(async (la: number, ln: number) => {
    revAbort.current?.abort();
    const ctrl = new AbortController();
    revAbort.current = ctrl;
    try {
      const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${la}&lon=${ln}&zoom=16&accept-language=uz`;
      const res = await fetch(url, { signal: ctrl.signal });
      const j = await res.json();
      const label = j?.display_name || '';
      setResolved(label);
      onAddress?.(label);
    } catch {
      /* manzil topilmadi — muhim emas */
    }
  }, [onAddress]);

  const placeMark = useCallback((la: number, ln: number, opts?: { fly?: boolean; geocode?: boolean }) => {
    makeMarker(la, ln);
    onChange(la, ln);
    setResolved('');
    if (opts?.fly) {
      mapRef.current?.flyTo([la, ln], 16, { duration: 1.1 });
    } else {
      mapRef.current?.setView([la, ln], Math.max(mapRef.current?.getZoom() || 14, 14));
    }
    if (opts?.geocode !== false) reverseGeocode(la, ln);
  }, [onChange, reverseGeocode]);

  // District tanlanganda avtomatik koordinataga marker qo'yish
  useEffect(() => {
    if (!mapRef.current) return;
    const key = matchDistrictKey(district);
    const base = key ? DISTRICT_COORDS[key] : null;
    if (base) placeMark(base.lat, base.lng, { fly: true, geocode: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [TASHKENT_CENTER.lat, TASHKENT_CENTER.lng],
      zoom: 13,
      scrollWheelZoom: false,
      zoomControl: false,
    });
    mapRef.current = map;

    // Zoom tugmalari — qidiruv bar bilan yopishib qolmasligi uchun chap pastki
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      placeMark(e.latlng.lat, e.latlng.lng);
    });

    if (lat != null && lng != null) {
      map.setView([lat, lng], 14);
      makeMarker(lat, lng);
      reverseGeocode(lat, lng);
    }

    // Yashirin/siqilgan (collapsible) formada ochilganda Leaflet to'g'ri
    // o'lcham olmagani uchun size'ni qayta hisoblaymiz.
    const reflow = () => map.invalidateSize();
    const t1 = window.setTimeout(reflow, 80);
    const t2 = window.setTimeout(reflow, 320);

    const ro =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(reflow)
        : null;
    if (ro) ro.observe(containerRef.current);

    return () => {
      ro?.disconnect();
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      revAbort.current?.abort();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================= GEOLOKATSIYA =================
  const useMyLocation = () => {
    setLocating(true);
    setGeoErr(null);
    if (!('geolocation' in navigator)) {
      setGeoErr('Brauzerda geolokatsiya qo\'llab-quvvatlanmaydi');
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        placeMark(pos.coords.latitude, pos.coords.longitude, { fly: true });
        setLocating(false);
      },
      () => {
        setGeoErr('Joylashuv o\'qib bo\'lmadi. Ruxsatni tekshiring.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };

  // ================= QIDIRUV (Nominatim) =================
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      return;
    }
    setSearching(true);
    const h = setTimeout(async () => {
      try {
        // Toshkent chegarasida qidirish uchun viewbox
        const url =
          `${NOMINATIM}/search?format=json&addressdetails=0&limit=6&bounded=1` +
          `&viewbox=69.05%2C41.45%2C69.55%2C41.10&q=${encodeURIComponent(q)}`;
        const j = await (await fetch(url)).json();
        setResults(
          (Array.isArray(j) ? j : [])
            .filter((r: any) => r.lat && r.lon)
            .map((r: any) => ({
              lat: parseFloat(r.lat),
              lng: parseFloat(r.lon),
              label: `${r.display_name || (r.name || '')}`.slice(0, 120),
            }))
        );
        setShowResults(true);
      } catch {
        setResults([]);
      }
      setSearching(false);
    }, 450);
    return () => clearTimeout(h);
  }, [query]);

  const pickResult = (r: GeoResult) => {
    placeMark(r.lat, r.lng, { fly: true });
    setQuery(r.label);
    setResults([]);
    setShowResults(false);
  };

  const openInMaps = () => {
    if (lat == null || lng == null) return;
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank', 'noopener');
  };

  return (
    <div className="map-picker overflow-hidden rounded-2xl border border-neon-cyan/20 bg-cyber-900/60">
      {/* XARITA — katta responive maydon (CSS klass orqali: 360/420/480px) */}
      <div className="relative z-0">
        <div
          ref={containerRef}
          className="map-picker-canvas"
          style={height != null && height > 0 ? { height } : undefined}
        />

        {/* Floating qidiruv bar — xarita ustida, xaritadan joy ajratmaydi */}
        <div className="absolute left-3 top-3 right-3 z-[1000] flex items-center gap-1.5 glass rounded-xl px-3 py-2 shadow-lg">
          <Search size={15} className="text-neon-cyan shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length && setShowResults(true)}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            placeholder="Manzilni qidiring (masalan: Yunusobod 9-uy)..."
            aria-label="Xaritada manzil qidirish"
            className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-gray-500"
          />
          {searching && <Loader2 size={14} className="animate-spin text-gray-500 shrink-0" />}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              useMyLocation();
            }}
            title="Mening joylashuvim"
            aria-label="Mening joylashuvimni ishlatish"
            className="shrink-0 ml-0.5 w-8 h-8 grid place-items-center rounded-lg text-neon-cyan hover:bg-white/10 active:scale-95 transition-colors"
          >
            {locating ? <Loader2 size={15} className="animate-spin" /> : <LocateFixed size={16} />}
          </button>
        </div>

        {/* Qidiruv natijalari */}
        {showResults && results.length > 0 && (
          <div className="absolute left-3 right-3 top-[52px] z-[1000] overflow-hidden rounded-xl glass shadow-xl menu-pop">
            <div className="max-h-52 overflow-y-auto scrollbar-thin divide-y divide-white/5">
              {results.map((r, i) => (
                <button
                  key={`${r.lat}-${r.lng}-${i}`}
                  type="button"
                  onMouseDown={() => pickResult(r)}
                  className="w-full text-left px-3.5 py-2.5 text-xs text-gray-200 hover:bg-white/10 flex items-start gap-2"
                >
                  <MapPin size={13} className="text-neon-cyan shrink-0 mt-0.5" /> {r.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tanlangan joy — compact professional footer */}
      <div className="px-3.5 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-400 border-t border-white/5">
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          <MapPin size={14} className="text-neon-cyan shrink-0" />
          <span className="truncate">
            {resolved
              ? resolved
              : lat != null && lng != null
                ? `Tanlangan joy (${lat.toFixed(4)}, ${lng.toFixed(4)})`
                : 'Xaritaga bosing — manzil avtomatik aniqlanadi'}
          </span>
        </span>
        {lat != null && lng != null && (
          <button
            type="button"
            onClick={openInMaps}
            className="ml-auto inline-flex items-center gap-1 font-bold text-neon-cyan hover:underline shrink-0"
          >
            <Navigation size={12} /> Google Maps
          </button>
        )}
      </div>
      {geoErr && <div className="px-3.5 pb-2 text-xs text-red-400">{geoErr}</div>}
    </div>
  );
}