// The Warsh mushaf page by page (client/public/riwayat/warsh/mushaf.json, scripts/build_mushaf_layout.py): which
// printed words of which ayah stand on each of a page's 15 lines, as the Madina mushaf (1441) sets them.
import type { CompactAyah } from '../services/quranData';

/** k0..k1: printed words of the ayah (tokens with letters, 0-based, as the tracker and the word timings count). */
export type Seg = [id: number, k0: number, k1: number];
export type PageLine = Seg[] | { h: number } | { b: 1 } | null;

export interface MushafLayout {
  lines: number;
  width: number; // a full line, in em of the mushaf font
  // f: the page's font scale; c: its short lines (centred); k: kashida, n tatweels into word k of ayah id at char `at`
  pages: { l: PageLine[]; f?: number; c?: number[]; k?: [id: number, k: number, at: number, n: number][] }[];
}

export const PAGES = 604;
const LETTERS = /[ء-يٱ-ۓ]/;

/** Ayah id → its words as printed (۞ goes with the word after it), without the number. */
export function printedWords(x: CompactAyah): string[] {
  const out: string[] = [];
  let pre = '';
  for (const t of x.t.replace(/ /g, ' ').split(/\s+/)) {
    if (!t || /^[٠-٩]+$/.test(t)) continue;
    if (LETTERS.test(t)) {
      out.push(pre + t);
      pre = '';
    } else pre += t + ' ';
  }
  return out;
}

export const wordKey = (id: number, k: number) => `${id}:${k}`;

let loading: Promise<MushafLayout> | null = null;
export function loadLayout(): Promise<MushafLayout> {
  loading ??= fetch('/riwayat/warsh/mushaf.json')
    .then((r) => {
      if (!r.ok) throw new Error('تعذّر تحميل صفحات المصحف');
      return r.json() as Promise<MushafLayout>;
    })
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

/** Page (1-based) of each ayah's word: an ayah that crosses a page has its first words on one, its last on the next. */
export function pageIndex(layout: MushafLayout): Map<string, number> {
  const at = new Map<string, number>();
  layout.pages.forEach((p, i) => {
    for (const line of p.l)
      if (Array.isArray(line)) for (const [id, k0, k1] of line) for (let k = k0; k <= k1; k++) at.set(wordKey(id, k), i + 1);
  });
  return at;
}

/** Each page's words in reading order (wordKey). */
export function pageWords(layout: MushafLayout): string[][] {
  return layout.pages.map((p) => p.l.flatMap((line) => (Array.isArray(line) ? line.flatMap(([id, k0, k1]) => Array.from({ length: k1 - k0 + 1 }, (_, i) => wordKey(id, k0 + i))) : [])));
}

/** The first ayah that starts on the page (or the one that runs onto it). */
export function firstAyahOn(layout: MushafLayout, page: number): number | undefined {
  for (const line of layout.pages[page - 1]?.l ?? []) if (Array.isArray(line) && line.length) return line.find((s) => s[1] === 0)?.[0] ?? line[0][0];
  return undefined;
}
