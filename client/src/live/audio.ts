// The recorded mushaf of each riwaya (mp3quran.net): one mp3 per surah, and the time of every ayah in the
// riwaya's own count (checked against the KFGQPC data). Pure module: the session plays what it returns.
import type { RiwayaKey } from './riwayat';
import type { Ayah, HafsDiffs, SurahInfo } from './reference';
import { bestHits, findPhrase } from './phrase';
import { normalizeArabic } from '../utils/arabic';

const CDN = 'https://cdn.mp3quran.net/audio/';
const TIMING = 'https://www.mp3quran.net/api/v3/ayat_timing';

export interface Reciter {
  name: string;
  folder: string;
  read?: number; // mp3quran timing id; none: whole surahs only
  words?: string; // word timings: client/public/riwayat/<riwaya>/words/<words>/NNN.json (scripts/build_word_timings.py)
}

// Murattal only (no mujawwad). The first is the default: the shortest recording among the best-known reciters
// (user, 2026-10-28; durations of al-Kahf + Ya-Sin + al-Mulk); Minshawi for Hafs, Husary and Abd al-Samad for Warsh asked by name.
export const RECITERS: Record<RiwayaKey, Reciter[]> = {
  warsh: [
    { name: 'العيون الكوشي', folder: CDN + 'laayoun-kouchi/r1/', read: 16, words: 'laayoun-kouchi' },
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

// ── From a jumla or a phrase: word timings (forced alignment of the recording, scripts/align_timings.py --words) ──
// The unit is the jumla (user, 2026-10-30): the stretch between two breaths of the reciter in the recording (measured
// pauses, waqf marks where he stops). Playback starts at a jumla; an exact word only when asked for (or a 1–2 word fath).

/** One ayah of a recording's word timings (scripts/build_word_timings.py): its end, the start of every printed word
 *  (null: no time), the free time before each word as aligned, and the first word of each jumla (0 first). */
export interface AyahWords {
  a: number;
  e: number; // ms
  w: (number | null)[];
  g: (number | null)[];
  j: number[];
}

/** A place in a surah. word = printed word of the ayah, 0-based (a token with letters); none = the whole ayah. */
export interface WordPlace {
  ayah: number;
  word?: number;
}

/** Where playback starts: 'jumla' (the default) at the beginning of the jumla the word is in; 'word' at the word
 *  itself (the reciter named it; a fath). Where it ends: 'word' right after `to`'s word; 'jumla' at the end of its jumla. */
export type StartAt = 'word' | 'jumla';

// A word clip starts up to 100 ms before the word's aligned onset (the pilot clips the user approved), not into the
// word before it (the free time g); at least 30 ms, as the aligned onset tends to be a little late.
const LEAD_MS = 100, MIN_LEAD_MS = 30;

/** The jumla word k of this ayah is in: its first word, and the first word after it (= word count at the ayah end). */
export function jumlaOf(x: AyahWords, k: number): { first: number; next: number } {
  const first = Math.max(0, ...x.j.filter((m) => m <= k));
  return { first, next: x.j.find((m) => m > k) ?? x.w.length };
}

/** Pure: seconds to play from `from` through `to` (inclusive; none = the end of `from`'s ayah, no word = the end of
 *  that ayah). `from` in the answer: where it really starts. null: not in these timings. */
export function wordsSpan(
  list: AyahWords[],
  from: WordPlace,
  to: WordPlace | undefined,
  at: StartAt = 'jumla',
  until: StartAt = 'word',
): { start: number; end: number; from: WordPlace } | null {
  const i = list.findIndex((x) => x.a === from.ayah);
  const j = list.findIndex((x) => x.a === (to?.ayah ?? from.ayah));
  if (i < 0 || j < i) return null;
  const A = list[i], B = list[j];
  let k = Math.max(0, Math.min(from.word ?? 0, A.w.length - 1));
  if (at === 'jumla') k = jumlaOf(A, k).first;
  while (k > 0 && A.w[k] == null) k--; // a word with no time: from the one before it
  const onset = (x: AyahWords, m: number) => (m === 0 ? x.w[0]! : x.w[m]! - Math.max(MIN_LEAD_MS, Math.min(LEAD_MS, x.g[m] ?? 0)));
  const start = onset(A, k);
  let end = B.e;
  if (to?.word !== undefined) {
    const after = until === 'jumla' ? jumlaOf(B, to.word).next : to.word + 1;
    for (let m = after; m < B.w.length; m++)
      if (B.w[m] != null) {
        end = onset(B, m); // up to the next word
        break;
      }
  }
  return end > start ? { start: start / 1000, end: end / 1000, from: { ayah: A.a, word: k } } : null;
}

const wordFiles = new Map<string, Promise<AyahWords[] | null>>();

/** A surah's word timings in this recording; null when it has none (yet). */
export function surahWords(key: RiwayaKey, r: Reciter, surah: number): Promise<AyahWords[] | null> {
  if (!r.words) return Promise.resolve(null);
  const url = `/riwayat/${key}/words/${r.words}/${String(surah).padStart(3, '0')}.json`;
  if (!wordFiles.has(url))
    wordFiles.set(
      url,
      fetch(url)
        .then((x) => (x.ok ? x.json() : null)) // a missing file is the app's index.html (SPA fallback): no JSON
        .then((x) => (Array.isArray(x) ? (x as AyahWords[]) : null))
        .catch((e) => {
          if (!(e instanceof SyntaxError)) wordFiles.delete(url); // offline: try again next time
          return null;
        }),
    );
  return wordFiles.get(url)!;
}

/**
 * Where to play from (surah, from) through `to` in the recording — from the start of `from`'s jumla unless
 * opts.at = 'word' — when the reciter's word timings have this surah; else from the ayah start (exact = false).
 * Meant for the fath and the mutashabihat too, later.
 */
export async function phraseSpan(
  key: RiwayaKey,
  surah: number,
  from: WordPlace,
  to?: WordPlace,
  opts: { reciter?: string; at?: StartAt; until?: StartAt } = {},
): Promise<(Span & { exact: boolean; from: WordPlace }) | { error: string }> {
  const asked = reciterOf(key, opts.reciter);
  const r = asked ?? RECITERS[key][0];
  const list = await surahWords(key, r, surah);
  const ws = list && wordsSpan(list, from, to, opts.at ?? 'jumla', opts.until ?? 'word');
  if (ws) return { url: r.folder + String(surah).padStart(3, '0') + '.mp3', start: ws.start, end: ws.end, reciter: r.name, missing: !asked, exact: true, from: ws.from };
  const span = await ayahSpan(key, surah, from.ayah, to?.ayah ?? from.ayah, opts.reciter);
  return 'error' in span ? span : { ...span, exact: !from.word, from: { ayah: from.ayah, word: 0 } };
}

/** play_recitation's arguments (prompt.ts). */
export interface RecitationArgs {
  surah?: number;
  from_ayah?: number;
  to_ayah?: number;
  from_words?: string;
  to_words?: string;
  from_word?: number; // 1-based
  start_at?: string;
  reciter?: string;
}

/** Did he name an end? If not, one ayah is played, whatever range the model chose (the mic is shut while it plays). A surah or a portion of it, «إلى آخر…», «إلى قوله…», or a number of ayat. The range the model
 *  fills in by itself otherwise runs to the surah's end (2026-10-30: «شغل الآية التي وقفت عندها» → 23:72–119). */
export function namesAnEnd(said: string): boolean {
  return /[\d\u0660-\u0669]/.test(said)
    || /سوره|كامل|حزب|جزء|ثمن|ربع|صفحه|(الي|حتي) (اخر|نهايه|الايه|ايه|قوله|اثن|ثلاث|اربع|خمس|ست|سبع|ثمان|تسع|عشر|مئه|مائه)|ايتين|(ثلاث|اربع|خمس|ست|سبع|ثمان|ثماني|تسع|عشر|عشرين|ثلاثين) (ايات|ايه)/.test(normalizeArabic(said));
}

const LETTERS = /[ء-يٱ-ۓ]/;
const printedWords = (x: Ayah) => x.t.split(/\s+/).filter((t) => LETTERS.test(t)).map((t) => t.replace(/[ۖ-ۛ]/g, ''));

/**
 * The tool call → what to play. The phrase named is looked for in the ayah given, else the surah, else the whole
 * mushaf (Hafs forms of the transcription count); several equally good places → an error listing them (ask which).
 */
export async function recitationSpan(
  m: { key: RiwayaKey; quran: Ayah[]; diffs: HafsDiffs; surahs: SurahInfo[] },
  args: RecitationArgs,
  surahNow?: number,
  said?: string, // what he asked in, when the end of the range should be checked against it
): Promise<{ span: Span; label: string; note: string; ayat: Ayah[] } | { error: string }> {
  const played = (s: number, from: number, to: number) => m.quran.filter((x) => x.s === s && x.a >= from && x.a <= to);
  const nameOf = (s: number) => m.surahs.find((x) => x.no === s)?.name_ar ?? String(s);
  let s = Number(args.surah) || surahNow || 1;
  const knownSurah = !!(Number(args.surah) || surahNow);
  // «شغل هذه الآية» after talking of النور 56, nothing recited yet: surah 1 played (2026-11-03 07:37)
  if (!knownSurah && !String(args.from_words ?? '').trim())
    return { error: 'لم تُمرَّر السورة ولا يُعرف موضعه. استدعِ play_recitation ثانية بـ surah و from_ayah مما ذُكر في الكلام، أو اسأله أي سورة.' };
  const fromAyah = Number(args.from_ayah) || 0;
  const toAyah = Number(args.to_ayah) || 0;
  let shortened = 0;
  const upTo = (first: number) => {
    if (said === undefined || toAyah <= first || namesAnEnd(said)) return toAyah;
    return (shortened = first);
  };
  const shortNote = () => (shortened ? `لم يذكر أين يقف، فتُتلى الآية ${shortened} وحدها، فلا تزد عليها إلا إن طلب. ` : '');
  const phrase = String(args.from_words ?? '').trim();
  let from: WordPlace;
  let note = '';
  if (phrase) {
    const scopes: { surah?: number; ayah?: number }[] = [
      ...(fromAyah && knownSurah ? [{ surah: s, ayah: fromAyah }] : []),
      ...(knownSurah ? [{ surah: s }] : []),
      {},
    ];
    let hits: ReturnType<typeof findPhrase> = [];
    let scope = -1;
    while (!hits.length && ++scope < scopes.length) hits = findPhrase(m.quran, m.diffs, phrase, scopes[scope]);
    if (!hits.length) return { error: `لم أجد «${phrase}» في المصحف. اسأله عن الموضع.` };
    const places = [...new Map(bestHits(hits).map((h) => [h.ayah.id, h])).values()].sort((a, b) => a.ayah.id - b.ayah.id);
    if (places.length > 1 && !scopes[scope].ayah) {
      const list = places.slice(0, 6).map((h) => `سورة ${nameOf(h.ayah.s)} (${h.ayah.s}) الآية ${h.ayah.a}`).join('، ');
      return { error: `«${phrase}» في أكثر من موضع: ${list}${places.length > 6 ? ' وغيرها' : ''}. اسأله أيّها يريد، ثم استدعِ play_recitation بـ surah و from_ayah مع from_words.` };
    }
    const hit = places[0];
    if (scope > 0 && (fromAyah || hit.ayah.s !== s))
      note = `ليست «${phrase}» حيث قيل؛ وجدتُها في سورة ${nameOf(hit.ayah.s)} الآية ${hit.ayah.a}. `;
    s = hit.ayah.s;
    from = { ayah: hit.ayah.a, word: hit.word };
  } else if (Number(args.from_word) > 1 && fromAyah) {
    from = { ayah: fromAyah, word: Number(args.from_word) - 1 };
  } else {
    // whole ayat, as before
    const a = fromAyah || 1;
    const last = upTo(a);
    const span = await ayahSpan(m.key, s, a, last || a, args.reciter);
    if ('error' in span) return span;
    return { span, label: `${span.reciter} · سورة ${nameOf(s)} ${a}${last > a ? '–' + last : ''}`, note: note + shortNote(), ayat: played(s, a, span.end === Infinity ? Infinity : last || a) };
  }
  let to: WordPlace | undefined;
  const endPhrase = String(args.to_words ?? '').trim();
  if (endPhrase) {
    const after = findPhrase(m.quran, m.diffs, endPhrase, { surah: s })
      .filter((h) => h.last.ayah.a > from.ayah || (h.last.ayah.a === from.ayah && h.last.word >= (from.word ?? 0)))
      .sort((a, b) => a.last.ayah.id - b.last.ayah.id || a.last.word - b.last.word);
    if (after.length) to = { ayah: after[0].last.ayah.a, word: after[0].last.word };
    else note += `لم أجد «${endPhrase}» بعد موضع البدء، فيُتلى إلى آخر الآية. `;
  } else if (toAyah > from.ayah) to = { ayah: upTo(from.ayah) };
  const at: StartAt = args.start_at === 'jumla' ? 'jumla' : 'word';
  const span = await phraseSpan(m.key, s, from, to, { reciter: args.reciter, at });
  if ('error' in span) return span;
  const ayah = m.quran.find((x) => x.s === s && x.a === span.from.ayah);
  const k = span.from.word ?? 0;
  const words = ayah ? printedWords(ayah).slice(k, k + 4).join(' ') : '';
  if (!span.exact) note += `ليس لهذه السورة توقيت للكلمات في تسجيل ${span.reciter} بعد، فيُتلى من أول الآية ${from.ayah}؛ أخبره بذلك. `;
  else if (k < (from.word ?? 0)) note += `يبدأ من أول الجملة: «${words}…». `;
  const last = to && to.ayah > span.from.ayah ? '–' + to.ayah : '';
  return { span, label: `${span.reciter} · سورة ${nameOf(s)} ${span.from.ayah}${last} «${words}…»`, note: note + shortNote(), ayat: played(s, span.from.ayah, to?.ayah ?? span.from.ayah) };
}
