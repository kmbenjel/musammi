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
  const lines: string[] = [`REFERENCE TEXT (KFGQPC، رواية ${riwaya}) — كل آية مضبوطة برسم مصحف الرواية (منها وحدها تنطق ما تنطقه)، وبعدها ‹الكلمات مجردة› للمقارنة بالتفريغ فقط، فلا تنطقها؛ وقد تسقط منها الهمزة («يجرون» هي «يَجْـَٔرُونَ»)، فاحكم بالمضبوط:`];
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

export const sim = (a: string, b: string) => {
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

/** The ayat he read last in one run (play_recitation's last_read). */
export interface ReadRun {
  s: number;
  from: number;
  to: number;
}

/** A stretch of ayat from..to joins the run when it starts inside it or right after it (a repetition stays inside). */
export function readRunAfter(run: ReadRun | null, s: number, from: number, to: number): ReadRun {
  return run && run.s === s && from >= run.from && from <= run.to + 1 ? { ...run, to: Math.max(run.to, to) } : { s, from, to };
}

/** Follows the reciter through the reference range using the live input transcription. */
export class PositionTracker {
  // idx → index in ayat; t: the word as printed; h: the word as Hafs reads it, where this riwaya differs (farsh)
  private words: { w: string; idx: number; t?: string; h?: string; pk: number }[] = [];
  private ptr = 0;
  private pending = '';
  ayat: Ayah[] = [];
  /** Set when a stretch was found further on than where the reciter was: the ayat in between were left out. */
  skipped: { from: Ayah; to: Ayah; moved: boolean } | null = null;
  // Where he was before a slip into a similar ayah further on (-1: none), and the ayah he slipped into. Until he
  // goes back, or reads on past that ayah, a fath is the words after the place he slipped from.
  private slipFrom = -1;
  private slipTo = -1;
  /** The last stretch of 3+ words read in order at the place: a fath may be built from it. */
  onTrack = true;
  matched = 0; // words matched since the range was opened
  reached = 0; // furthest word reached since the range was opened
  seen = 0; // words heard, and those that matched the text (nearly) exactly
  exact = 0;
  jumps = 0; // moves forward past text: words left out, or a move to another place
  /** Every word matched, in order (index into the range's words; setRange starts it again): the words the mushaf mode
   *  writes on a hidden page. */
  hits: number[] = [];

  /**
   * A whole stretch (the transcript arrives per stretch): where in the range does it fit best? If clearly
   * further on than the current place, the reciter jumped (often to a similar ayah) and left ayat out.
   */
  private placeStretch(ws: string[]): void {
    if (ws.length < 4) return;
    // start: the first word that fits (the search from k looks up to 6 words ahead for it)
    const fits = (k: number) => {
      let hit = 0, j = k, start = k;
      const at: number[] = [];
      for (const w of ws) {
        for (let t = j; t < Math.min(j + (hit ? 3 : 6), this.words.length); t++) {
          if (simWord(w, this.words[t]) >= 0.8) { if (!hit) start = t; hit++; j = t + 1; at.push(t); break; }
        }
      }
      return { hit, start, end: j, at };
    };
    const here = fits(Math.max(0, this.ptr - 3));
    if (here.hit >= ws.length * 0.5) return; // continues where it was
    const enough = (f: { hit: number; start: number }) => f.start >= 0 && f.hit >= Math.max(4, ws.length * 0.7);
    const none = { hit: 0, start: -1, end: 0, at: [] as number[] };
    if (this.matched < 6) {
      // The starting place is not confirmed yet (a range opened at the surah's start, or a quick restart where the
      // last session stopped, while he reads elsewhere in it): go where the stretch clearly fits, ahead or behind,
      // unless it fits as well somewhere else (a refrain). Not a skip: he had not started here.
      let best = none;
      const all: { hit: number; start: number; end: number; at: number[] }[] = [];
      for (let k = 0; k < this.words.length; k++) {
        const f = fits(k);
        all.push(f);
        if (f.hit > best.hit) best = f;
      }
      if (!enough(best) || all.some((f) => f.hit >= best.hit && Math.abs(f.start - best.start) > 8)) return;
      this.ptr = this.reached = best.end;
      this.matched += best.hit;
      this.hits.push(...best.at);
      return;
    }
    let best = none;
    // from where `here` stopped looking (a start up to ptr+2), nearest first: a phrase found again further on loses
    // to the same phrase just after a few words the transcript dropped (from ptr+8, 24:49 won over 24:46, 2026-11-02)
    for (let k = this.ptr + 3; k < this.words.length; k++) {
      const f = fits(k);
      if (f.hit > best.hit) best = f;
    }
    // Back to where he was before a slip into a similar ayah further on (after «أعد»): the ayah he slipped from,
    // with the one before and after it. Its opening words may fit the similar ayah just as well, so this place
    // goes first.
    if (this.slipFrom >= 0) {
      const ayahOf = (i: number) => this.words[Math.min(i, this.words.length - 1)].idx;
      const at = ayahOf(this.slipFrom);
      let back = none;
      for (let k = 0; k < this.words.length && this.words[k].idx <= at + 1; k++) {
        if (this.words[k].idx < at - 1) continue;
        const f = fits(k);
        if (f.hit > back.hit) back = f;
      }
      if (enough(back) && back.hit >= best.hit) {
        this.ptr = this.reached = back.end; // what he read in the similar ayah was never reached
        this.slipFrom = -1;
        this.hits.push(...back.at);
        return;
      }
    }
    if (!enough(best)) {
      // Further back (a deliberate return, or a repetition that starts more than feed's 8 words behind): follow
      // only a place the words cannot also be read at elsewhere (a refrain, a repeated phrase), here and ahead
      // included: a noisy stretch at his place may read better at the same phrase behind.
      const behind: { hit: number; start: number; end: number; at: number[] }[] = [];
      for (let k = this.ptr - 9; k >= 0; k--) behind.push(fits(k)); // nearest first
      const back = behind.reduce((b, f) => (f.hit > b.hit ? f : b), none);
      if (!enough(back) || back.hit <= best.hit) return;
      if (behind.some((f) => f.hit >= back.hit && Math.abs(f.start - back.start) > 8)) return;
      for (let k = Math.max(0, this.ptr - 8); k < this.ptr + 8 && k < this.words.length; k++) if (fits(k).hit >= back.hit) return;
      this.ptr = back.end;
      this.hits.push(...back.at);
      return;
    }
    const from = this.ayat[this.words[Math.max(0, Math.min(this.ptr, this.words.length) - 1)].idx]; // last ayah reached
    const to = this.ayat[this.words[best.start].idx];
    if (to.id - from.id >= 2) {
      // a finished ayah, then a fresh start at the beginning of another: a deliberate move (to review the
      // mutashabihat, say), not a slip into a similar ayah halfway through
      const finished = this.ptr >= this.words.length || this.words[this.ptr].idx !== this.words[this.ptr - 1]?.idx;
      const fresh = best.start === 0 || this.words[best.start - 1].idx !== this.words[best.start].idx;
      // ...except one ayah left out in the same surah: reciting on, he dropped it («لا، أنا قفزت الآية», recording
      // 10-26 00:12). A short one stays a move: the transcript can lose 2-4 words whole.
      const left = to.id - from.id === 2 && to.s === from.s ? this.ayat.find((x) => x.id === from.id + 1) : undefined;
      const dropped = !!left && normalizeTranscript(left.c || left.t).split(' ').filter(Boolean).length >= 5;
      const moved = finished && fresh && !dropped;
      this.skipped = { from, to, moved };
      if (moved) this.slipFrom = -1;
      else {
        if (this.slipFrom < 0) this.slipFrom = this.ptr; // slipping again: the right place is still the first one
        this.slipTo = this.words[best.start].idx;
      }
    }
    // in the same ayah or the next, words the transcript dropped (or a short skip feed's window cannot reach): follow
    this.ptr = best.end;
    this.hits.push(...best.at);
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
      // pk: the printed word it is in (a printed word can normalize to two words, or to none)
      const pk: number[] = [];
      printed.forEach((t, i) => normalizeTranscript(t).split(' ').filter(Boolean).forEach(() => pk.push(i)));
      const at = (k: number) => (pk.length === ws.length ? pk[k] : Math.min(printed.length - 1, Math.floor((k * printed.length) / ws.length)));
      ws.forEach((w, k) => this.words.push({ w, idx, t: printed.length === ws.length ? printed[k] : undefined, h: hafs.get(k), pk: at(k) }));
    });
    this.ptr = 0;
    if (curId !== undefined) {
      const k = this.words.findIndex((x) => ayat[x.idx].id === curId);
      if (k >= 0) this.ptr = k;
    }
    this.pending = '';
    this.matched = 0;
    this.hits = [];
    this.reached = this.ptr;
    this.slipFrom = -1;
    this.onTrack = true;
  }

  /** Start in this ayah at this word (a new session going on from where the last one stopped). */
  startAt(ayah: Ayah, word: number) {
    const first = this.words.findIndex((x) => this.ayat[x.idx].id === ayah.id);
    if (first < 0) return;
    let k = first;
    while (k < first + word && this.words[k + 1]?.idx === this.words[first].idx) k++;
    this.ptr = this.reached = k;
    this.slipFrom = -1;
    this.onTrack = true;
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
    if (this.ptr !== before) {
      this.jumps++;
      this.reached = Math.max(this.reached, this.ptr);
      this.onTrack = true;
      this.wentOn();
      return true;
    }
    let words = 0, inOrder = 0;
    for (const w of normalizeTranscript(done).split(' ')) {
      if (!w || w.length < 2) continue;
      this.seen++;
      words++;
      let best = -1, bestScore = 0.72;
      // search a little backwards (repetition after «أعد») and forwards (skips, mis-hearings)
      const from = Math.max(0, this.ptr - 8), to = Math.min(this.words.length, this.ptr + 14);
      for (let k = from; k < to; k++) {
        const sc = simWord(w, this.words[k]) - Math.abs(k - this.ptr) * 0.004;
        if (sc > bestScore) { bestScore = sc; best = k; }
      }
      if (best >= 0) {
        // exact only in this riwaya's own form: a Hafs form reaches the word but may be a real slip
        if (sim(w, this.words[best].w.replace(/ءا/g, 'ا')) - Math.abs(best - this.ptr) * 0.004 >= 0.88) this.exact++; // «ءامنوا» is transcribed «امنوا»
        if (best >= this.ptr && best <= this.ptr + 2) inOrder++;
        this.hits.push(best);
        if (best > this.ptr) this.jumps++;
        this.ptr = best + 1;
        this.matched++;
      }
    }
    // a word or two tell nothing; otherwise the place must explain the stretch (words matched here and there
    // around a wrong place moved it, but it does not read there)
    if (words >= 3) this.onTrack = inOrder >= words * 0.5;
    this.reached = Math.max(this.reached, this.ptr);
    this.wentOn();
    return this.ptr !== before;
  }

  /** He read on into the ayah after the one he slipped into: he stays there now. */
  private wentOn() {
    if (this.slipFrom < 0) return;
    const p = this.position();
    if (p && this.ayat.indexOf(p.ayah) > this.slipTo && p.word >= 3) this.slipFrom = -1;
  }

  /** Where a fath starts: his place, or the place he slipped from while he has not gone back there. */
  private fathAt(): number {
    return this.slipFrom >= 0 ? this.slipFrom : this.ptr;
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

  mark() {
    return { seen: this.seen, exact: this.exact, jumps: this.jumps };
  }

  /** Since the mark: 3+ words, each as printed, in order with nothing left out (going back over them is a restart), up
   *  to a stop inside an ayah. The stretch is right, so far: a stop there is a breath. */
  readRight(m: { seen: number; exact: number; jumps: number }): boolean {
    const seen = this.seen - m.seen;
    if (!(seen >= 3 && this.exact - m.exact === seen && this.jumps === m.jumps && this.onTrack && this.midAyah())) return false;
    const last = normalizeTranscript(this.pending).trim(); // feed keeps a word until it is complete: the stretch's last one
    return !last || sim(last, this.words[this.ptr].w.replace(/ءا/g, 'ا')) >= 0.88;
  }

  /** Is this word in the text around the reciter's place? In salat the teacher may only say those (a fath). */
  isNear(word: string): boolean {
    if (word.length < 2) return false;
    const near = (at: number) => this.words
      .slice(Math.max(0, at - 40), at + 25) // behind: the fath for a skipped ayah
      .some((x) => x.w.startsWith(word) || word.startsWith(x.w) || simWord(word, x) >= 0.75);
    return near(this.ptr) || (this.slipFrom >= 0 && near(this.slipFrom));
  }

  /** The words of the fath as printed in the mushaf: from the reciter's place (after a slip into a similar ayah,
   *  from where he slipped) to the next waqf mark or the end of the ayah (at most `max` words), so the teacher says
   *  exactly what is needed. */
  nextPhrase(max = 6): string {
    const k0 = this.fathAt();
    const n = this.fathRun(k0, max);
    return this.words
      .slice(k0, k0 + n)
      .map(({ t, w }) => (t ?? w).replace(/[\u06D6-\u06DB]/g, ''))
      .join(' ');
  }

  /** How many words (from index k0) a fath covers: up to the next waqf mark or the ayah end when that is within
   *  FATH_REACH words (user 2026-11-06: \u00ABto the next waqf mark\u00BB); else `max` words, never ending on a word whose last
   *  letter carries the madd sign: that madd is long because of the next word's hamza, and stopping on it cuts the
   *  madd in the recording and the phrase in the middle (user 2026-11-08 on \u00AB\u0641\u064E\u0644\u064E\u0645\u064E\u0651\u0622\u00BB in 2:16). */
  private fathRun(k0: number, max: number): number {
    const FATH_REACH = 10;
    for (let k = k0, n = 1; k < this.words.length && n <= FATH_REACH; k++, n++) {
      const { t, idx } = this.words[k];
      if (/[\u06D6-\u06DB]/.test(t ?? '') || this.words[k + 1]?.idx !== idx) return n;
    }
    let n = Math.min(max, this.words.length - k0);
    while (n > 1 && /[\u0622\u0653][\u064B-\u0652\u06E1\u0670]*$/.test(this.words[k0 + n - 1].t ?? '')) n--;
    return Math.max(1, n);
  }

  /** Where a fath starts and how many printed words it covers (the words of nextPhrase): the recorded fath (fath.ts)
   *  plays exactly those words of the reciter's recording. */
  fathPlace(max = 6): { ayah: Ayah; word: number; count: number } | undefined {
    const k0 = this.fathAt();
    const w0 = this.words[k0];
    if (!w0) return undefined;
    const last = this.words[k0 + this.fathRun(k0, max) - 1];
    return { ayah: this.ayat[w0.idx], word: w0.pk, count: last.pk - w0.pk + 1 };
  }

  /** The mushaf's own words from index `from` to `to` (exclusive), as printed in this riwaya, with the number after
   *  each ayah that ends inside: what a stretch read right is shown as. */
  printed(from: number, to: number): string {
    const out: string[] = [];
    for (let k = Math.max(0, from); k < Math.min(to, this.words.length); k++) {
      const { t, w, idx } = this.words[k];
      out.push(t ?? w);
      if (this.words[k + 1]?.idx !== idx) out.push(this.ayat[idx].a.toLocaleString('ar-EG'));
    }
    return out.join(' ');
  }

  /** A word the transcript cannot be matched on (one letter: «صٓ», «قٓ», «نٓ», which feed skips). */
  tooShort(k: number): boolean {
    return (this.words[k]?.w.length ?? 2) < 2;
  }

  /** Word index k as the mushaf prints it: the ayah's id and its printed word (0-based). */
  /** The mushaf's word k as printed, and the ayah's number when it is the ayah's last word (as printed() writes them). */
  wordAt(k: number): { text: string; num?: string } | undefined {
    const x = this.words[k];
    if (!x) return undefined;
    return { text: x.t ?? x.w, num: this.words[k + 1]?.idx !== x.idx ? this.ayat[x.idx].a.toLocaleString('ar-EG') : undefined };
  }
  printedAt(k: number): { id: number; k: number } | undefined {
    const w = this.words[k];
    return w && { id: this.ayat[w.idx].id, k: w.pk };
  }

  /** The ayah of the word at index k. */
  ayahAt(k: number): Ayah | undefined {
    const w = this.words[k];
    return w && this.ayat[w.idx];
  }

  /** What the teacher said, when it is the mushaf's words at a place in the range, as printed there, nearest place
   *  first (the transcript of its voice carries wrong vowels and stray letters: «يَשْعُرُونَ»). */
  asPrinted(said: string): string | undefined {
    const ws = normalizeTranscript(said.replace(/[…«»"]/g, ' ')).split(' ').filter(Boolean);
    const redo = ws[0] === 'اعد' && ws.length > 1;
    if (redo) ws.shift();
    if (ws.length < 2 && (ws[0]?.length ?? 0) < 6) return undefined;
    const last = this.words.length - ws.length;
    const places = Array.from({ length: Math.max(0, last + 1) }, (_, k) => k).sort((a, b) => Math.abs(a - this.ptr) - Math.abs(b - this.ptr));
    const k = places.find((p) => ws.every((w, i) => simWord(w, this.words[p + i]) >= 0.8));
    if (k === undefined) return undefined;
    return (redo ? 'أعِد: ' : '') + this.printed(k, k + ws.length);
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
