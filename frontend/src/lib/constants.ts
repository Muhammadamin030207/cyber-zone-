export const TASHKENT_DISTRICTS = [
  'Chilonzor',
  'Mirzo Ulug\u2019bek',
  'Yakkasaroy',
  'Yunusobod',
  'Olmazor',
  'Bektemir',
  'Sergeli',
  'Shayxontohur',
  'Uchtepa',
  'Yangihayot',
  'Yashnobod',
  'Mirobod',
  'Tinchlik',
];

// Toshkent tumanlari — taxminiy markaz koordinatalari (xarita uchun)
export const DISTRICT_COORDS: Record<string, { lat: number; lng: number }> = {
  Chilonzor: { lat: 41.2784, lng: 69.1992 },
  'Mirzo Ulug\u2019bek': { lat: 41.2649, lng: 69.3349 },
  Yakkasaroy: { lat: 41.2780, lng: 69.2620 },
  Yunusobod: { lat: 41.3111, lng: 69.2797 },
  Olmazor: { lat: 41.2930, lng: 69.1667 },
  Bektemir: { lat: 41.2200, lng: 69.3200 },
  Sergeli: { lat: 41.2300, lng: 69.2100 },
  Shayxontohur: { lat: 41.3160, lng: 69.2580 },
  Uchtepa: { lat: 41.3270, lng: 69.1920 },
  Yangihayot: { lat: 41.2000, lng: 69.2500 },
  Yashnobod: { lat: 41.3420, lng: 69.3016 },
  Mirobod: { lat: 41.2730, lng: 69.2810 },
  Tinchlik: { lat: 41.3300, lng: 69.2000 },
};

export const TASHKENT_CENTER = { lat: 41.2995, lng: 69.2401 };

// ===== Tuman nomini normallashtirish =====
// Muammo: tuman nomi DB'da bir necha ko'rinishda yozilishi mumkin
//   "Mirzo Ulug'bek" (oddiy apostrof)  vs  "Mirzo Ulug’bek" (typografik)
//   "Yunusobod"                        vs  "Yunusabad"
// Bunday farq `includes()` ni buzadi va xona TASHKENT_CENTER ga tushib qoladi —
// ya'ni xaritada barcha marker'lar bitta nuqtada ustma-ust ko'rinadi.
// Barcha apostrof variantlari (oddiy ', typografik ’, ʻ, ʼ, ‘, modulli ‘, ʹ, gʻ)
// va trek/bo'linish belgilari bitta bo'shliqqa almashtiriladi.
const APOSTROPHES = /['’ʻʼ‘´`ʹʼʻ]/g;
const SEPARATORS = /[\s_\-–—/]+/g;

export function normalizeDistrict(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(APOSTROPHES, ' ')
    .replace(SEPARATORS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bo'shliq/apostrof umuman yo'q ko'rinish: "Mirzo Ulugbek" ~ "Mirzo Ulug'bek". */
function squashDistrict(value: string | null | undefined): string {
  return normalizeDistrict(value).replace(/[^a-z0-9]/g, '');
}

/** O'zbek tilidagi yozuv farqlari → kanonik tuman kaliti. */
const DISTRICT_ALIASES: Record<string, string> = {
  'yunusobod': 'Yunusobod',
  'yunusabad': 'Yunusobod',
  'yunusobod tumani': 'Yunusobod',
  'yunusabad tumani': 'Yunusobod',
  'chilonzor': 'Chilonzor',
  'chilonzor tumani': 'Chilonzor',
  'yakkasaroy': 'Yakkasaroy',
  'yakkasaroy tumani': 'Yakkasaroy',
  'mirzo ulug bek': 'Mirzo Ulug’bek',
  'mirzo ulug bek tumani': 'Mirzo Ulug’bek',
  'mirzoulugbek': 'Mirzo Ulug’bek',
  'olmazor': 'Olmazor',
  'olmazor tumani': 'Olmazor',
  'bektemir': 'Bektemir',
  'bektemir tumani': 'Bektemir',
  'sergeli': 'Sergeli',
  'sergeli tumani': 'Sergeli',
  'shayxontohur': 'Shayxontohur',
  'shayxantohor': 'Shayxontohur',
  'shaykhontohur': 'Shayxontohur',
  'shayxontohur tumani': 'Shayxontohur',
  'uchtepa': 'Uchtepa',
  'uchtepa tumani': 'Uchtepa',
  'yangihayot': 'Yangihayot',
  'yangi hayot': 'Yangihayot',
  'yangihayot tumani': 'Yangihayot',
  'yashnobod': 'Yashnobod',
  'yashnobod tumani': 'Yashnobod',
  'mirobod': 'Mirobod',
  'mirobod tumani': 'Mirobod',
  'tinchlik': 'Tinchlik',
  'tinchlik tumani': 'Tinchlik',
  'toshkent': 'Yunusobod',
  'toshkent shahri': 'Yunusobod',
};

/** District kalitini normallashgan holda topadi. `null` — mos kelmadi. */
export function matchDistrictKey(district: string | null | undefined): string | null {
  const normalized = normalizeDistrict(district);
  if (!normalized) return null;

  if (DISTRICT_ALIASES[normalized]) return DISTRICT_ALIASES[normalized];

  // "yunusobod tumani, toshkent shahri" — kalit matn ichida bo'lsa mos keladi
  const direct = Object.keys(DISTRICT_COORDS).find(
    (key) => normalized === normalizeDistrict(key),
  );
  if (direct) return direct;

  const contained = Object.keys(DISTRICT_COORDS).find((key) => {
    const k = normalizeDistrict(key);
    return k.length > 3 && normalized.includes(k);
  });
  if (contained) return contained;

  const alias = Object.keys(DISTRICT_ALIASES).find((a) => normalized.includes(a));
  if (alias) return DISTRICT_ALIASES[alias];

  // Bo'shliq/apostrof yo'q yozuvlar: "Mirzo Ulugbek" ~ "Mirzo Ulug'bek"
  const squashed = squashDistrict(district);
  if (squashed) {
    const squashedAlias = Object.keys(DISTRICT_ALIASES).find((a) => squashDistrict(a) === squashed);
    if (squashedAlias) return DISTRICT_ALIASES[squashedAlias];
    const squashedKey = Object.keys(DISTRICT_COORDS).find((key) => {
      const sk = squashDistrict(key);
      return sk.length > 4 && squashed.includes(sk);
    });
    if (squashedKey) return squashedKey;
  }

  return null;
}

export type RoomCoordsResult = {
  lat: number;
  lng: number;
  /** true = haqiqiy GPS koordinata, false = taxminiy (tuman markazi) */
  precise: boolean;
  districtKey: string | null;
};

/** Xona koordinatasini aniqlaydi — aniq yoki taxminiy belgilangan holda. */
export function resolveRoomCoords(room: {
  latitude?: number | null;
  longitude?: number | null;
  district?: string | null;
}): RoomCoordsResult {
  if (typeof room.latitude === 'number' && typeof room.longitude === 'number') {
    return { lat: room.latitude, lng: room.longitude, precise: true, districtKey: matchDistrictKey(room.district) };
  }
  const key = matchDistrictKey(room.district);
  if (key) {
    const c = DISTRICT_COORDS[key];
    return { lat: c.lat, lng: c.lng, precise: false, districtKey: key };
  }
  return { lat: TASHKENT_CENTER.lat, lng: TASHKENT_CENTER.lng, precise: false, districtKey: null };
}

// Xonaning koordinatasi bo'lmasa, tuman markazidan foydalanamiz
export function roomCoords(room: { latitude?: number | null; longitude?: number | null; district?: string | null }): { lat: number; lng: number } {
  const { lat, lng } = resolveRoomCoords(room);
  return { lat, lng };
}

export const REAL_TIME_BADGE = { free: 'Bo\u2019sh', busy: 'Ishladi' } as const;