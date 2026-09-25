'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Loader2, LocateFixed, Navigation } from 'lucide-react';
import type { Room } from '@/lib/types';
import { resolveRoomCoords, TASHKENT_CENTER } from '@/lib/constants';
import { formatPrice } from '@/lib/utils';

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export default function RoomsMap({ rooms, height = 440, linkBase = '/rooms' }: { rooms: Room[]; height?: number; linkBase?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const userMarkerRef = useRef<L.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locErr, setLocErr] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [TASHKENT_CENTER.lat, TASHKENT_CENTER.lng],
      zoom: 12,
      scrollWheelZoom: false,
      zoomControl: true,
    });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    setReady(true);

    const markerMap = markersRef.current;
    return () => {
      map.remove();
      mapRef.current = null;
      markerMap.clear();
      userMarkerRef.current = null;
      setReady(false);
    };
  }, []);

  const applyMarkers = useCallback((roomsList: Room[], active: string | null, my: { lat: number; lng: number } | null) => {
    const map = mapRef.current;
    if (!map) return;

    map.eachLayer((layer) => {
      // Joylashuv marker'ini o'chirmaymiz — u keyingi qo'llamada qayta ishlatiladi.
      if (layer instanceof L.Marker && layer !== userMarkerRef.current) map.removeLayer(layer);
    });
    markersRef.current.clear();

    // Joylashuv ma'lum bo'lsa — xonalar masofa bo'yicha saralanadi (eng yaqin = №1).
    // Aks holda tuman nomi bo'yicha guruhlanadi, shunda bir tuman xonalari yonma-yon chiqadi.
    const sortedRooms = [...roomsList].sort((a, b) => {
      const ca = resolveRoomCoords(a);
      const cb = resolveRoomCoords(b);
      if (my) {
        const d = haversineKm(my, ca) - haversineKm(my, cb);
        if (Math.abs(d) > 0.0001) return d;
      }
      const ka = ca.districtKey ?? 'zzz';
      const kb = cb.districtKey ?? 'zzz';
      if (ka !== kb) return ka.localeCompare(kb, 'uz');
      return a.name.localeCompare(b.name, 'uz');
    });

    // Bir xil nuqtaga tushgan xonalar ustma-ust ko'rinmasin uchun kichik radial surish.
    const groupByKey = new Map<string, number>();
    const markers = sortedRooms.map((room, i) => {
      const resolved = resolveRoomCoords(room);
      const { lat, lng, precise, districtKey } = resolved;
      // Aniq koordinatasi yo'q xonalar uchun joylashuv kaliti
      const groupKey = precise ? room.id : `approx:${lat.toFixed(4)},${lng.toFixed(4)}`;
      const idxInGroup = groupByKey.get(groupKey) ?? 0;
      groupByKey.set(groupKey, idxInGroup + 1);

      // Oltin burchak — marker'lar bir-birining ustiga tushmasdan teng taqsimlanadi
      const angle = idxInGroup * 2.399963;
      const spread = idxInGroup === 0 ? 0 : 0.0014 * Math.sqrt(idxInGroup);
      const markerLat = lat + Math.cos(angle) * spread;
      const markerLng = lng + Math.sin(angle) * spread;

      const isActive = active === room.id;
      const dist = my ? haversineKm(my, { lat, lng }) : null;
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:${isActive ? 42 : 34}px;height:${isActive ? 42 : 34}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
          background:linear-gradient(135deg,#10b981,#f59e0b);border:2.5px solid ${isActive ? '#22d3ee' : '#fff'};
          box-shadow:0 6px 16px rgba(16,185,129,.55);display:flex;align-items:center;justify-content:center;
          transition:all .2s ease;
        "><div style="transform:rotate(45deg);font-size:${isActive ? 15 : 13}px;color:#000;font-weight:900;">${i + 1}</div></div>`,
        iconSize: [isActive ? 42 : 34, isActive ? 42 : 34],
        iconAnchor: [isActive ? 10 : 8, isActive ? 38 : 31],
      });

      const price = room.zones?.length ? Math.min(...room.zones.map((z) => Number(z.pricePerHour))) : 0;
      const popupHtml = `
        <div style="font-family:Inter,system-ui,sans-serif;min-width:210px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#10b981,#f59e0b);color:#000;font-weight:900;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${i + 1}</span>
            <div style="font-weight:800;color:#0b3b33;font-size:14px;line-height:1.2;">${room.name}</div>
          </div>
          <div style="font-size:12px;color:#555;margin-bottom:4px;">${room.address || ''}</div>
          ${districtKey && !precise ? `<div style="font-size:11px;color:#92400e;background:#fef3c7;padding:3px 7px;border-radius:6px;margin-bottom:5px;display:inline-block;">Taxminiy joylashuv — ${districtKey} markazi</div>` : ''}
          ${!districtKey && !precise ? '<div style="font-size:11px;color:#b91c1c;background:#fee2e2;padding:3px 7px;border-radius:6px;margin-bottom:5px;display:inline-block;">Aniq koordinata kiritilmagan</div>' : ''}
          <div style="font-size:13px;color:#b45309;font-weight:800;margin-bottom:4px;">${formatPrice(price)} so&apos;m/soat dan</div>
          ${dist != null ? `<div style="font-size:12px;color:#0b7285;font-weight:700;margin-bottom:8px;">Sizdan ${dist.toFixed(1)} km${precise ? '' : ' (taxminiy)'}</div>` : ''}
          <div style="display:flex;gap:6px;">
            <a href="${linkBase}/${room.id}" style="display:inline-flex;font-size:12px;font-weight:800;color:#fff;background:linear-gradient(135deg,#10b981,#0d9668);padding:5px 12px;border-radius:9999px;text-decoration:none;box-shadow:0 4px 10px rgba(16,185,129,.4);">Batafsil →</a>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener" style="display:inline-flex;font-size:12px;font-weight:800;color:#fff;background:linear-gradient(135deg,#6366f1,#4338ca);padding:5px 12px;border-radius:9999px;text-decoration:none;box-shadow:0 4px 10px rgba(99,102,241,.4);">Yo&apos;nalish</a>
          </div>
        </div>`;

      const marker = L.marker([markerLat, markerLng], { icon }).addTo(map);
      marker.bindPopup(popupHtml, { closeButton: false });
      marker.on('click', () => setActiveId(room.id));
      marker.on('popupclose', () => setActiveId(null));
      markersRef.current.set(room.id, marker);
      return { marker, room, lat, lng, precise };
    });

    // Joylashuv markerini yangilash
    if (my) {
      if (!userMarkerRef.current) {
        userMarkerRef.current = L.marker([my.lat, my.lng], {
          icon: L.divIcon({
            className: '',
            html: '<div style="width:18px;height:18px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 0 6px rgba(59,130,246,.25),0 4px 10px rgba(0,0,0,.4);"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          zIndexOffset: 500,
          interactive: false,
        }).addTo(map);
      } else {
        userMarkerRef.current.setLatLng([my.lat, my.lng]);
      }
    }

    if (markers.length) {
      // BARCHA xonalar ko'rinib tursin — hech qanday marker ekrandan chiqib ketmasin.
      // Oldingi xato: faqat eng yaqin xonaga flyTo(zoom 14) qilinardi, qolganlari
      // (masalan Chilonzor Yunusoboddan 7 km uzoqda) ekrandan tushib qolardi.
      const points: [number, number][] = markers.map((m) => [m.lat, m.lng] as [number, number]);
      if (my) points.push([my.lat, my.lng]);
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [56, 56], maxZoom: 14, animate: true, duration: 0.6 });

      // Eng yaqin xona faqat ajratib ko'rsatiladi (zo'omlash emas).
      if (my) {
        const nearest = markers.reduce((a, b) =>
          haversineKm(my, { lat: a.lat, lng: a.lng }) < haversineKm(my, { lat: b.lat, lng: b.lng }) ? a : b
        );
        nearest.marker.openPopup();
      }
    } else {
      map.setView([TASHKENT_CENTER.lat, TASHKENT_CENTER.lng], 12);
    }
  }, [linkBase]);

  useEffect(() => {
    applyMarkers(rooms, activeId, myPos);
  }, [rooms, ready, activeId, myPos, applyMarkers]);

  // ===== Eng yaqin xona =====
  const requestPosition = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocErr('Brauzeringiz geolokatsiyani qo\'llab-quvvatlamaydi');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocErr(null);
      },
      () => {
        setLocErr('Joylashuv o\'qib bo\'lmadi. Ruxsatni tekshiring.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, []);

  const findNearest = useCallback(() => {
    setLocating(true);
    if (!('geolocation' in navigator)) {
      setLocErr('Brauzeringiz geolokatsiyani qo\'llab-quvvatlamaydi');
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMyPos(p);
        setLocating(false);
        setLocErr(null);
        if (rooms.length) {
          const nearest = rooms.reduce((a, b) => {
            const ca = resolveRoomCoords(a);
            const cb = resolveRoomCoords(b);
            return haversineKm(p, ca) < haversineKm(p, cb) ? a : b;
          });
          setActiveId(nearest.id);
        }
      },
      () => {
        setLocErr('Joylashuv o\'qib bo\'lmadi. Ruxsatni tekshiring.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, [rooms]);

  // Sahifa ochilganda joylashuvni avtomatik so'raymiz — foydalanuvchi "Eng yaqin"
  // tugmasini bosishini kutmasdan eng yaqin xona ko'rsatilsin.
  useEffect(() => {
    if (!ready || myPos) return;
    const timer = window.setTimeout(() => requestPosition(), 0);
    return () => window.clearTimeout(timer);
  }, [ready, myPos, requestPosition]);

  const nearestRoom = myPos && rooms.length
    ? rooms.reduce((a, b) => {
        const ca = resolveRoomCoords(a);
        const cb = resolveRoomCoords(b);
        return haversineKm(myPos, ca) < haversineKm(myPos, cb) ? a : b;
      }, rooms[0])
    : null;
  const nearestText = nearestRoom
    ? `Eng yaqin: ${nearestRoom.name} · ${haversineKm(myPos!, resolveRoomCoords(nearestRoom)).toFixed(1)} km`
    : null;
  const impreciseCount = rooms.filter((r) => !resolveRoomCoords(r).precise).length;

  return (
    <div className="neo-card rounded-2xl overflow-hidden">
      <div className="relative z-0">
        <div style={{ height }} ref={containerRef} />
        {!ready && (
          <div className="absolute inset-0 grid place-items-center bg-cyber-900/80">
            <Loader2 size={22} className="animate-spin text-neon-cyan" />
          </div>
        )}
        {rooms.length > 0 && (
          <button
            onClick={findNearest}
            disabled={locating}
            className="absolute bottom-3 right-3 z-[1000] inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl glass border border-neon-cyan/30 text-neon-cyan hover:bg-white/10 transition-colors shadow-lg disabled:opacity-50"
          >
            {locating ? <Loader2 size={13} className="animate-spin" /> : <LocateFixed size={13} />}
            Eng yaqin
          </button>
        )}
      </div>
      <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
        <span className="flex items-center gap-1.5">
          <MapPin size={14} className="text-neon-cyan" />
          {rooms.length} ta xona xaritada · marker ustiga bosing — batafsil ma&apos;lumot ko&apos;rinadi
        </span>
        {nearestText && (
          <span className="inline-flex items-center gap-1.5 text-neon-green font-bold">
            <Navigation size={12} /> {nearestText}
          </span>
        )}
        {locErr && <span className="text-red-400">{locErr}</span>}
        {impreciseCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-amber-300/90">
            <MapPin size={12} />
            {impreciseCount} ta xona uchun aniq koordinata kiritilmagan — tuman markazi bo&apos;yicha taxmin qilingan
          </span>
        )}
      </div>
    </div>
  );
}