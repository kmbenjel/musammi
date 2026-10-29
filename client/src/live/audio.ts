// The recorded mushaf of each riwaya (mp3quran.net): one mp3 per surah, and the time of every ayah in the
// riwaya's own count (checked against the KFGQPC data). Pure module: the session plays what it returns.
import type { RiwayaKey } from './riwayat';

const CDN = 'https://cdn.mp3quran.net/audio/';
const TIMING = 'https://www.mp3quran.net/api/v3/ayat_timing';

export interface Reciter {
  name: string;
  folder: string;
  read?: number; // mp3quran timing id; none: whole surahs only
}

// Murattal only (no mujawwad). The first is the default: the shortest recording among the best-known reciters
// (user, 2026-10-28; durations of al-Kahf + Ya-Sin + al-Mulk); Minshawi for Hafs, Husary and Abd al-Samad for Warsh asked by name.
export const RECITERS: Record<RiwayaKey, Reciter[]> = {
  warsh: [
    { name: 'العيون الكوشي', folder: CDN + 'laayoun-kouchi/r1/', read: 16 },
    { name: 'محمود خليل الحصري', folder: CDN + 'mahmoud-husary/r3/', read: 120 },
    { name: 'عبد الباسط عبد الصمد', folder: CDN + 'abdulbasit-abdulsamad/r2/' },
    { name: 'عمر القزابري', folder: CDN + 'omar-kazabri/r1/', read: 80 }, // user, 2026-10-29
    { name: 'ياسين الجزائري', folder: CDN + 'yassen-jazairi/r1/', read: 14 },
  ],
  qaloon: [{ name: 'علي الحذيفي', folder: CDN + 'ali-hudhaifi/r2/', read: 75 }],
  hafs: [
    { name: 'سعود الشريم', folder: CDN + 'saud-shuraim/r1/', read: 31 },
    { name: 'محمد صديق المنشاوي', folder: CDN + 'muhammad-minshawi/r1/', read: 112 },
  ],
  shouba: [{ name: 'علي الحذيفي', folder: CDN + 'ali-hudhaifi/r3/', read: 305 }],
  doori: [{ name: 'محمود خليل الحصري', folder: CDN + 'mahmoud-husary/r4/', read: 269 }],
  soosi: [{ name: 'عبد الرشيد صوفي', folder: CDN + 'abdulrasheed-sufi/r2/', read: 65 }],
  bazzi: [{ name: 'عكاشة كميني', folder: CDN + 'okasha-kameny/r2/', read: 296 }],
  qumbul: [{ name: 'أحمد ديبان', folder: CDN + 'ahmad-deeban/r3/' }],
};

/** The reciter asked for by (part of) his name («الحصري», «عبد الصمد»); none asked: the riwaya's default;
 *  a name this riwaya has no recording of: null. */
export function reciterOf(key: RiwayaKey, asked = ''): Reciter | null {
  const bare = (t: string) => t.replace(/[\u064B-\u0652\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه');
  const words = bare(asked).split(/\s+/).map((w) => w.replace(/^ال/, '')).filter((w) => w.length >= 3);
  const score = (r: Reciter) => words.filter((w) => bare(r.name).replace(/\s+/g, '').includes(w)).length;
  const list = RECITERS[key];
  const best = list.reduce((a, r) => (score(r) > score(a) ? r : a), list[0]);
  return !words.length ? list[0] : score(best) ? best : null;
}

export interface Span {
  url: string;
  start: number; // seconds
  end: number; // seconds; Infinity = to the end of the file
  reciter: string;
  missing?: boolean; // the reciter asked for has no recording in this riwaya: the default plays
}

/** The recordings of a riwaya, for the teacher: the default first, and which play whole surahs only. */
export function recitersText(key: RiwayaKey): string {
  const list = RECITERS[key];
  return list.map((r, i) => r.name + (i === 0 && list.length > 1 ? ' (الافتراضي)' : '') + (r.read ? '' : ' (السور كاملة فقط)')).join('، ');
}

const timings = new Map<string, Promise<{ ayah: number; start_time: number; end_time: number }[]>>();

/** Where ayat `from`..`to` of a surah are in the recording (from ayah 1, with the basmala before it). */
export async function ayahSpan(key: RiwayaKey, surah: number, from: number, to: number, reciter?: string): Promise<Span | { error: string }> {
  const asked = reciterOf(key, reciter);
  const r = asked ?? RECITERS[key][0];
  const url = r.folder + String(surah).padStart(3, '0') + '.mp3';
  if (!r.read) {
    if (from > 1) return { error: `لا توجد توقيتات الآيات لتسجيل ${r.name}؛ يمكن تشغيل السورة كاملة من أولها فقط، أو هذه الآيات بقارئ آخر.` };
    return { url, start: 0, end: Infinity, reciter: r.name, missing: !asked };
  }
  const id = `${r.read}:${surah}`;
  if (!timings.has(id)) timings.set(id, fetch(`${TIMING}?surah=${surah}&read=${r.read}`).then((x) => x.json()));
  let list;
  try {
    list = (await timings.get(id)!).filter((x) => x.ayah >= 1); // ayah 0: the basmala in some recordings
  } catch {
    timings.delete(id);
    return { error: 'تعذّر تحميل توقيتات التسجيل' };
  }
  const a = list.find((x) => x.ayah === from);
  const b = list.find((x) => x.ayah === Math.min(Math.max(to, from), list.length));
  if (!a || !b) return { error: 'لا توجد هذه الآية في التسجيل' };
  return { url, start: from === 1 ? 0 : a.start_time / 1000, end: b.end_time / 1000, reciter: r.name, missing: !asked };
}
