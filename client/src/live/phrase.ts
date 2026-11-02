// Where in the mushaf are the words the reciter named («أسمعني من قوله تعالى: ولقد زينا السماء الدنيا»)? Pure.
// Words are counted as the recordings' word timings count them: the printed tokens of the ayah that have letters.
import { normalizeTranscript } from '../utils/arabic';
import { sim, type Ayah, type HafsDiffs } from './reference';

interface Entry {
  idx: number; // index in quran
  k: number; // printed word in the ayah (0-based)
  w: number; // the word, normalized (id in vocab)
  h: number; // its Hafs form, where this riwaya reads it differently (the transcription leans to Hafs); -1: none
}

interface Index {
  list: Entry[];
  vocab: string[]; // ~15k distinct words for the mushaf's ~77k: similarities are computed once per query word
  first: number[]; // quran index → its first entry
}

export interface PhraseHit {
  ayah: Ayah;
  word: number; // first printed word of the phrase (0-based)
  last: { ayah: Ayah; word: number }; // last printed word of the phrase
  score: number; // 1 = every word as printed (or as Hafs reads it)
}

const LETTERS = /[ء-يٱ-ۓ]/;
const indexes = new WeakMap<Ayah[], Index>();

function indexOf(quran: Ayah[], diffs: HafsDiffs): Index {
  let ix = indexes.get(quran);
  if (ix) return ix;
  const ids = new Map<string, number>();
  const vocab: string[] = [];
  const id = (w: string) => {
    let v = ids.get(w);
    if (v === undefined) ids.set(w, (v = vocab.push(w) - 1));
    return v;
  };
  const list: Entry[] = [], first: number[] = [];
  quran.forEach((x, idx) => {
    first.push(list.length);
    const hafs = new Map<string, string>();
    for (const [r, h] of diffs[`${x.s}:${x.a}`] ?? []) {
      const [nr, nh] = [normalizeTranscript(r), normalizeTranscript(h)];
      if (nr !== nh && !nr.includes(' ') && !nh.includes(' ')) hafs.set(nr, nh);
    }
    x.t.split(/\s+/)
      .filter((t) => LETTERS.test(t))
      .forEach((t, k) => {
        for (const w of normalizeTranscript(t).split(' ')) {
          const h = hafs.get(w);
          if (w) list.push({ idx, k, w: id(w), h: h ? id(h) : -1 });
        }
      });
  });
  first.push(list.length);
  ix = { list, vocab, first };
  indexes.set(quran, ix);
  return ix;
}

/** Similarity of query word a to a text word (its Hafs form counts too), memoized per query. */
type Like = (a: number, e: Entry) => number;
function likeFor(q: string[], vocab: string[]): Like {
  const memo = q.map(() => new Float32Array(vocab.length).fill(-1));
  const one = (a: number, w: number) => {
    let v = memo[a][w];
    if (v < 0) {
      const t = vocab[w];
      const bound = 1 - Math.abs(t.length - q[a].length) / Math.max(t.length, q[a].length);
      memo[a][w] = v = bound < 0.5 ? 0 : sim(q[a], t); // far apart in length: no match anyway
    }
    return v;
  };
  return (a, e) => (e.h >= 0 ? Math.max(one(a, e.w), one(a, e.h)) : one(a, e.w));
}

const GAP = 0.7; // a word left out on either side costs nearly a wrong word

/** The query's words aligned to the text from entry i: cost and the last text entry used. */
function alignAt(q: string[], like: Like, list: Entry[], i: number): { cost: number; end: number } {
  const n = Math.min(list.length - i, q.length + 2);
  // d[a][b]: cost of q[0..a) against list[i..i+b); the first text word must be used (the phrase starts there)
  const d = Array.from({ length: q.length + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  d[0][0] = 0;
  for (let a = 1; a <= q.length; a++)
    for (let b = 0; b <= n; b++) {
      let v = d[a - 1][b] + GAP; // a word named that is not in the text
      if (b) v = Math.min(v, d[a - 1][b - 1] + 1 - like(a - 1, list[i + b - 1]), d[a][b - 1] + GAP); // or a text word not named
      d[a][b] = v;
    }
  let best = { cost: Infinity, end: i };
  for (let b = 1; b <= n; b++) if (d[q.length][b] < best.cost) best = { cost: d[q.length][b], end: i + b - 1 };
  return best;
}

/** «قوله تعالى»، «من» and the like before the words themselves. */
const LEAD_IN = /^(?:(?:من|الي|حتي)\s+)?(?:(?:قوله|قول|قال)\s+)?(?:(?:الله|ربنا)\s+)?(?:(?:تعالي|سبحانه|عز وجل|جل وعلا)\s+)?/;

/**
 * Every place the phrase is read at, best first, in that ayah / surah (none: the whole mushaf). Several places with
 * (nearly) the best score (bestHits): the phrase is ambiguous there.
 */
export function findPhrase(quran: Ayah[], diffs: HafsDiffs, phrase: string, where: { surah?: number; ayah?: number } = {}, minScore = 0.7): PhraseHit[] {
  const norm = normalizeTranscript(phrase).replace(/[ىی]/g, 'ي');
  const q = (norm.replace(LEAD_IN, '') || norm).split(' ').filter(Boolean);
  if (!q.length) return [];
  const { list, vocab, first } = indexOf(quran, diffs);
  const like = likeFor(q, vocab);
  const inScope = (x: Ayah) => (!where.surah || x.s === where.surah) && (!where.ayah || x.a === where.ayah);
  // the entries of the scope (the mushaf is in order)
  let lo = 0, hi = list.length;
  if (where.surah) {
    const a = quran.findIndex(inScope);
    if (a < 0) return [];
    let b = a;
    while (b + 1 < quran.length && inScope(quran[b + 1])) b++;
    [lo, hi] = [first[a], first[b + 1]];
  }
  const hits: PhraseHit[] = [];
  for (let i = lo; i < hi; i++) {
    const e = list[i];
    if (i > 0 && list[i - 1].idx === e.idx && list[i - 1].k === e.k) continue; // a word's second half
    // starts worth aligning: the first word named (or, misheard, the second) is here
    if (like(0, e) < 0.6 && !(q.length >= 3 && like(1, e) >= 0.75)) continue;
    const x = quran[e.idx];
    if (!inScope(x)) continue;
    const { cost, end } = alignAt(q, like, list, i);
    const score = 1 - cost / q.length;
    if (score < minScore) continue;
    hits.push({ ayah: x, word: e.k, last: { ayah: quran[list[end].idx], word: list[end].k }, score });
  }
  // one hit per place: overlapping starts (the phrase found again one word later) keep the best
  hits.sort((a, b) => b.score - a.score || a.ayah.id - b.ayah.id || a.word - b.word);
  const kept: PhraseHit[] = [];
  const near = new Map<number, number[]>(); // ayah id → words kept
  for (const h of hits) {
    const ws = near.get(h.ayah.id) ?? [];
    if (ws.some((w) => Math.abs(w - h.word) < q.length)) continue;
    ws.push(h.word);
    near.set(h.ayah.id, ws);
    kept.push(h);
  }
  return kept;
}

/** The hits as good as the best (within 0.05): one = the place is clear. */
export function bestHits(hits: PhraseHit[]): PhraseHit[] {
  return hits.filter((h) => h.score >= hits[0].score - 0.05);
}
