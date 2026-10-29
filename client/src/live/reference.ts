// Warsh reference ranges + live position tracking (pure; runs in browser and Node tests).
import { normalizeTranscript } from '../utils/arabic';

export interface Ayah {
  id: number;
  s: number;
  a: number;
  p: number;
  j: number;
  t: string; // KFGQPC Warsh text (ends with the ayah number glyph)
  c: string; // normalized
}

export interface SurahInfo {
  no: number;
  name_ar: string;
  ayah_count: number;
}

const ind = (n: number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]);

/** From the chosen ayah to ~one hizb ahead (10 muṣḥaf pages; KFGQPC data has no hizb markers). */
export function rangeFrom(quran: Ayah[], s: number, a: number, pages = 10, maxAyat = 160): Ayah[] {
  let i = quran.findIndex((x) => x.s === s && x.a === a);
  if (i < 0) i = quran.findIndex((x) => x.s === s);
  if (i < 0) return [];
  const lastPage = quran[i].p + pages - 1;
  const out: Ayah[] = [];
  for (let k = i; k < quran.length && quran[k].p <= lastPage && out.length < maxAyat; k++) out.push(quran[k]);
  return out;
}

/** Words a riwaya reads differently from Hafs, keyed by "surah:ayah" in its numbering (scripts/build_riwayat.py). */
export type HafsDiffs = Record<string, [warsh: string, hafs: string][]>;

export function formatReference(
  ayat: Ayah[],
  surahs: SurahInfo[],
  diffs: HafsDiffs = {},
  riwaya = 'ورش',
): string {
  if (!ayat.length) return '';
  const lines: string[] = [`REFERENCE TEXT (KFGQPC، رواية ${riwaya}) — كل آية مضبوطة برسم مصحف الرواية (منها وحدها تنطق ما تنطقه)، وبعدها ‹الكلمات مجردة› للمقارنة بالتفريغ فقط، فلا تنطقها:`];
  let cur = -1;
  for (const x of ayat) {
    if (x.s !== cur) {
      cur = x.s;
      const name = surahs.find((q) => q.no === x.s)?.name_ar ?? String(x.s);
      lines.push(`— سورة ${name} (رقمها ${x.s}) —`);
    }
    lines.push(`[${x.s}:${x.a}] ${x.t.replace(/\u00a0?[\u0660-\u0669]+\s*$/, '').trim()} (${ind(x.a)})  ‹${x.c}›`);
  }
  const farsh = ayat.flatMap((x) => (diffs[`${x.s}:${x.a}`] ?? []).map(([w, h]) => `[${x.s}:${x.a}] ${riwaya}: ${w} — (حفص: ${h})`));
  if (farsh.length) {
    lines.push('', `فروق ${riwaya} عن حفص في هذا المقطع (صيغة ${riwaya} هي الصواب هنا، وصيغة حفص خطأ):`, ...farsh);
  }
  return lines.join('\n');
}

const sim = (a: string, b: string) => {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
};

/**
 * Finds where in the whole mushaf the last recited words are. In salat the reciter cannot say where they
 * are, and the model does not look it up by itself. Each word votes for the places it occurs at; a similar
 * passage elsewhere (mutashabihat) splits the vote, so no place is chosen until the words tell them apart.
 */
export class MushafLocator {
  private words: number[] = []; // word → index in quran
  private at = new Map<string, number[]>();

  constructor(private quran: Ayah[]) {
    quran.forEach((x, idx) => {
      for (const w of normalizeTranscript(x.c || x.t).split(' ')) {
        if (!w) continue;
        const list = this.at.get(w) ?? [];
        if (!list.length) this.at.set(w, list);
        list.push(this.words.length);
        this.words.push(idx);
      }
    });
  }

  /** The ayah, and the index in `recited` of the first word that belongs there. */
  locate(recited: string[], skip: (a: Ayah) => boolean = () => false): { ayah: Ayah; from: number } | null {
    const votes = new Map<number, number>();
    const first = new Map<number, number>(); // the first recited word that fits there
    recited.forEach((w, i) => {
      const hits = this.at.get(w);
      if (!hits || hits.length > 300) return; // «الله», «من»… tell nothing
      for (const k of hits) {
        if (skip(this.quran[this.words[k]])) continue; // the place already open
        votes.set(k - i, (votes.get(k - i) ?? 0) + 1);
        if (!first.has(k - i)) first.set(k - i, i);
      }
    });
    // a dropped or merged word shifts the start by one or two
    const score = (st: number) => [-2, -1, 0, 1, 2].reduce((n, d) => n + (votes.get(st + d) ?? 0), 0);
    let best = -1, bestScore = 0;
    for (const st of votes.keys()) {
      const sc = score(st);
      if (sc > bestScore) [best, bestScore] = [st, sc];
    }
    let second = 0;
    for (const st of votes.keys()) if (Math.abs(st - best) > 8) second = Math.max(second, score(st));
    if (bestScore < 3 || bestScore < second * 1.5 + 1) return null;
    // the window may still hold words from before the jump: the place starts at the first word that fits
    const from = first.get(best) ?? 0;
    return { ayah: this.quran[this.words[Math.max(0, Math.min(best + from, this.words.length - 1))]], from };
  }
}

/**
 * Does `target` read like the ayah he stopped in (`anchor`, with its neighbours: Warsh splits some ayat)? Shared
 * words that are rare in the mushaf, at least 3 and 40% of the target's own: Yunus 75 against al-Muʾminun 45–47
 * shares 9 of 12; random pairs of ayat pass 0.2% of the time.
 */
const rareWords = new WeakMap<Ayah[], Map<string, number>>();
export function readsLike(quran: Ayah[], anchor: Ayah, target: Ayah): boolean {
  let freq = rareWords.get(quran);
  if (!freq) {
    freq = new Map();
    for (const x of quran) for (const w of normalizeTranscript(x.c || x.t).split(' ')) if (w) freq.set(w, (freq.get(w) ?? 0) + 1);
    rareWords.set(quran, freq);
  }
  const rare = (x: Ayah) =>
    normalizeTranscript(x.c || x.t)
      .split(' ')
      .filter((w) => w.length >= 2 && (freq!.get(w) ?? 0) < 300)
      .map((w) => w.replace(/^[وف](?=..)/, '')); // «وهارون» / «هارون»
  const i = quran.indexOf(anchor);
  const near = new Set<string>();
  for (let k = i - 1; k <= i + 2; k++) if (quran[k]?.s === anchor.s) rare(quran[k]).forEach((w) => near.add(w));
  const own = new Set(rare(target));
  const n = [...own].filter((w) => near.has(w)).length;
  return n >= 3 && n >= own.size * 0.4;
}

/** The input transcription leans to Hafs: at a farsh word its Hafs form also counts as reaching that word. */
const simWord = (w: string, x: { w: string; h?: string }) => (x.h ? Math.max(sim(w, x.w), sim(w, x.h)) : sim(w, x.w));

/** Follows the reciter through the reference range using the live input transcription. */
export class PositionTracker {
  // idx → index in ayat; t: the word as printed; h: the word as Hafs reads it, where this riwaya differs (farsh)
  private words: { w: string; idx: number; t?: string; h?: string }[] = [];
  private ptr = 0;
  private pending = '';
  ayat: Ayah[] = [];
  /** Set when a stretch was found further on than where the reciter was: the ayat in between were left out. */
  skipped: { from: Ayah; to: Ayah; moved: boolean } | null = null;
  matched = 0; // words matched since the range was opened
  reached = 0; // furthest word reached since the range was opened
  seen = 0; // words heard, and those that matched the text (nearly) exactly
  exact = 0;

  /**
   * A whole stretch (the transcript arrives per stretch): where in the range does it fit best? If clearly
   * further on than the current place, the reciter jumped (often to a similar ayah) and left ayat out.
   */
  private placeStretch(ws: string[]): void {
    if (ws.length < 4 || this.matched < 6) return; // not before the starting place is confirmed
    const fits = (k: number) => {
      let hit = 0, j = k;
      for (const w of ws) {
        for (let t = j; t < Math.min(j + (hit ? 3 : 6), this.words.length); t++) {
          if (simWord(w, this.words[t]) >= 0.8) { hit++; j = t + 1; break; }
        }
      }
      return { hit, end: j };
    };
    const here = fits(Math.max(0, this.ptr - 3));
    if (here.hit >= ws.length * 0.5) return; // continues where it was
    let best = -1, bestHit = 0, bestEnd = 0;
    for (let k = this.ptr + 8; k < this.words.length; k++) {
      const f = fits(k);
      if (f.hit > bestHit) { best = k; bestHit = f.hit; bestEnd = f.end; }
    }
    if (best < 0 || bestHit < Math.max(4, ws.length * 0.7)) return;
    const from = this.ayat[this.words[Math.max(0, Math.min(this.ptr, this.words.length) - 1)].idx]; // last ayah reached
    const to = this.ayat[this.words[best].idx];
    if (to.id - from.id >= 2) {
      // a finished ayah, then a fresh start at the beginning of another: a deliberate move (to review the
      // mutashabihat, say), not a slip into a similar ayah halfway through
      const finished = this.ptr >= this.words.length || this.words[this.ptr].idx !== this.words[this.ptr - 1]?.idx;
      const fresh = best === 0 || this.words[best - 1].idx !== this.words[best].idx;
      this.skipped = { from, to, moved: finished && fresh };
      this.ptr = bestEnd;
    }
  }

  setRange(ayat: Ayah[], keepPosition = false, diffs: HafsDiffs = {}) {
    const curId = keepPosition ? this.current()?.id : undefined;
    this.ayat = ayat;
    this.words = [];
    ayat.forEach((x, idx) => {
      const ws = normalizeTranscript(x.c || x.t).split(' ').filter(Boolean);
      const printed = x.t.split(/\s+/).filter((t) => /[\u0621-\u064A\u0671-\u06D3]/.test(t));
      const hafs = new Map<number, string>();
      for (const [r, h] of diffs[`${x.s}:${x.a}`] ?? []) {
        const [nr, nh] = [normalizeTranscript(r), normalizeTranscript(h)];
        if (nr === nh || nr.includes(' ') || nh.includes(' ')) continue; // same once unvowelled, or several words
        const k = ws.findIndex((w, i) => w === nr && !hafs.has(i));
        if (k >= 0) hafs.set(k, nh);
      }
      ws.forEach((w, k) => this.words.push({ w, idx, t: printed.length === ws.length ? printed[k] : undefined, h: hafs.get(k) }));
    });
    this.ptr = 0;
    if (curId !== undefined) {
      const k = this.words.findIndex((x) => ayat[x.idx].id === curId);
      if (k >= 0) this.ptr = k;
    }
    this.pending = '';
    this.matched = 0;
    this.reached = this.ptr;
  }

  /** Start in this ayah at this word (a new session going on from where the last one stopped). */
  startAt(ayah: Ayah, word: number) {
    const first = this.words.findIndex((x) => this.ayat[x.idx].id === ayah.id);
    if (first < 0) return;
    let k = first;
    while (k < first + word && this.words[k + 1]?.idx === this.words[first].idx) k++;
    this.ptr = this.reached = k;
  }

  /** The ayah the reciter is in and how many of its words are behind him. */
  position(): { ayah: Ayah; word: number } | undefined {
    const ayah = this.current();
    if (!ayah) return undefined;
    let word = 0;
    while (this.ptr - word - 1 >= 0 && this.ayat[this.words[this.ptr - word - 1].idx] === ayah) word++;
    return { ayah, word };
  }

  /** Index of the next word to recite. */
  at(): number {
    return this.ptr;
  }

  /** Feed incremental transcription chunks. Returns true when the position moved. */
  feed(chunk: string): boolean {
    this.pending += chunk;
    // Only consume complete words (a chunk may end mid-word).
    const lastSpace = this.pending.lastIndexOf(' ');
    if (lastSpace < 0) return false;
    const done = this.pending.slice(0, lastSpace);
    this.pending = this.pending.slice(lastSpace + 1);
    const before = this.ptr;
    this.placeStretch(normalizeTranscript(done).split(' ').filter((w) => w.length >= 2));
    if (this.ptr !== before) return true;
    for (const w of normalizeTranscript(done).split(' ')) {
      if (!w || w.length < 2) continue;
      this.seen++;
      let best = -1, bestScore = 0.72;
      // search a little backwards (repetition after «أعد») and forwards (skips, mis-hearings)
      const from = Math.max(0, this.ptr - 8), to = Math.min(this.words.length, this.ptr + 14);
      for (let k = from; k < to; k++) {
        const sc = simWord(w, this.words[k]) - Math.abs(k - this.ptr) * 0.004;
        if (sc > bestScore) { bestScore = sc; best = k; }
      }
      if (best >= 0) {
        // exact only in this riwaya's own form: a Hafs form reaches the word but may be a real slip
        if (sim(w, this.words[best].w) - Math.abs(best - this.ptr) * 0.004 >= 0.88) this.exact++;
        this.ptr = best + 1;
        this.matched++;
      }
    }
    this.reached = Math.max(this.reached, this.ptr);
    return this.ptr !== before;
  }

  /** The ayah the reciter is in (or about to start). */
  current(): Ayah | undefined {
    if (!this.words.length) return undefined;
    const k = Math.min(this.ptr, this.words.length - 1);
    return this.ayat[this.words[k].idx];
  }

  /** True when the reciter stopped inside an ayah (not at its end): in salat that pause may be a lapse. */
  midAyah(): boolean {
    if (!this.ptr || this.ptr >= this.words.length) return false;
    return this.words[this.ptr].idx === this.words[this.ptr - 1].idx;
  }

  /** Is this word in the text around the reciter's place? In salat the teacher may only say those (a fath). */
  isNear(word: string): boolean {
    if (word.length < 2) return false;
    return this.words
      .slice(Math.max(0, this.ptr - 40), this.ptr + 25) // behind: the fath for a skipped ayah
      .some((x) => x.w.startsWith(word) || word.startsWith(x.w) || simWord(word, x) >= 0.75);
  }

  /** The words of the fath as printed in the mushaf: from the reciter's place to the next waqf mark or the end of
   *  the ayah (at most `max` words), so the teacher says exactly what is needed. */
  nextPhrase(max = 6): string {
    const out: string[] = [];
    for (let k = this.ptr; k < this.words.length && out.length < max; k++) {
      const { t, w, idx } = this.words[k];
      out.push((t ?? w).replace(/[\u06D6-\u06DB]/g, ''));
      if (/[\u06D6-\u06DB]/.test(t ?? '') || this.words[k + 1]?.idx !== idx) break;
    }
    return out.join(' ');
  }

  /** Words left in the current ayah (the transcript often drops the last word of a stretch). */
  leftInAyah(): number {
    let n = 0;
    while (this.ptr + n < this.words.length && this.words[this.ptr + n].idx === this.words[this.ptr].idx) n++;
    return n;
  }

  /** The next words to recite (without tashkeel), from the reciter's place: the hint for a fath. */
  nextWords(n = 3): string {
    return this.words.slice(this.ptr, this.ptr + n).map((x) => x.w).join(' ');
  }

  /** Last ayah fully passed. */
  lastDone(): Ayah | undefined {
    if (!this.ptr) return undefined;
    const idx = this.words[this.ptr - 1].idx;
    const endOfAyah = this.ptr >= this.words.length || this.words[this.ptr].idx !== idx;
    return endOfAyah ? this.ayat[idx] : idx > 0 ? this.ayat[idx - 1] : undefined;
  }

  progress(): number {
    return this.words.length ? this.ptr / this.words.length : 0;
  }
}
