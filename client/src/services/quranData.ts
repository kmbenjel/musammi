import { DEFAULT_RIWAYA, type RiwayaKey } from '../live/riwayat';

export interface SurahMeta {
  no: number;
  name_ar: string;
  name_en: string;
  ayah_count: number;
  start_page: number;
  start_juz: number;
}

export interface CompactAyah {
  id: number;
  s: number; // sura
  a: number; // aya (Warsh Madani count)
  p: number; // page
  j: number; // jozz
  h: number | null; // hizb (null in KFGQPC)
  th: number | null; // thumun (null in KFGQPC)
  t: string; // original Warsh text
  c: string; // clean normalized
}

export interface MutashabihOccurrence {
  sura: number;
  aya: number;
  page: number;
  juz: number;
  cue: string;
  full_text: string;
}

export interface MutashabihGroup {
  phrase_norm: string;
  word_count: number;
  cue: string;
  occurrences: MutashabihOccurrence[];
}

// Everything below follows the current riwaya (client/public/riwayat/<key>/, scripts/build_riwayat.py).
// Each riwaya has its own text, font, ayah counting and surah ayah counts.

export interface RiwayaData {
  key: RiwayaKey;
  quran: CompactAyah[];
  surahs: SurahMeta[];
  diffs: Record<string, [string, string][]>; // words read differently from Hafs, by "surah:ayah"
  toHafs: Record<string, number>; // "surah:ayah" → Hafs global ayah id
}

let current: RiwayaKey = DEFAULT_RIWAYA;
const cache = new Map<RiwayaKey, Promise<RiwayaData>>();
const mutashabihatCache = new Map<RiwayaKey, Promise<MutashabihGroup[]>>();
const loaded = new Map<RiwayaKey, RiwayaData>();

const get = async <T,>(key: RiwayaKey, file: string, fallback?: T): Promise<T> => {
  const res = await fetch(`/riwayat/${key}/${file}`);
  if (!res.ok) {
    if (fallback !== undefined) return fallback;
    throw new Error('تعذّر تحميل بيانات المصحف');
  }
  return res.json();
};

export function loadRiwaya(key: RiwayaKey): Promise<RiwayaData> {
  if (!cache.has(key)) {
    const p = Promise.all([
      get<CompactAyah[]>(key, 'quran.json'),
      get<SurahMeta[]>(key, 'surahs.json'),
      get<Record<string, [string, string][]>>(key, 'diff.json', {}),
      get<Record<string, number>>(key, 'to_hafs.json', {}),
    ]).then(([quran, surahs, diffs, toHafs]) => {
      const d = { key, quran, surahs, diffs, toHafs };
      loaded.set(key, d);
      return d;
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key)!;
}

/** Switch the riwaya used by the exam generator and lookups below. */
export async function setRiwaya(key: RiwayaKey): Promise<RiwayaData> {
  const d = await loadRiwaya(key);
  current = key;
  return d;
}

export async function loadQuranData(): Promise<CompactAyah[]> {
  return (await loadRiwaya(current)).quran;
}

export function loadMutashabihatData(): Promise<MutashabihGroup[]> {
  if (!mutashabihatCache.has(current)) mutashabihatCache.set(current, get<MutashabihGroup[]>(current, 'mutashabihat.json', []));
  return mutashabihatCache.get(current)!;
}

export function getSurahByNo(no: number): SurahMeta | undefined {
  return loaded.get(current)?.surahs.find((s) => s.no === no);
}
