// The fath's words (PositionTracker.fathPlace / nextPhrase): to the next waqf mark when it is within 10 words, else 6
// words never ending on a madd before a hamza (2026-11-08 00:45: «مثلهم كمثل الذي استوقد نارا فلمّآ», cut in the madd).
// Build: client/node_modules/.bin/esbuild test/fath_run.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/fath.mjs
// Run:   node /tmp/hw/fath.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { pausedCount } from '../client/src/live/audio';

const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};
const at = (s: number, a: number) => {
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, s, a));
  return t;
};

let t = at(2, 16);
check('2:16 from its start: up to «حوله»ۖ (9 words)', t.fathPlace()?.count === 9, { p: t.nextPhrase(), n: t.fathPlace()?.count });
check('nextPhrase says the same words', t.nextPhrase().split(' ').length === 9 && t.nextPhrase().endsWith('حَوْلَهُۥ'), t.nextPhrase());
// every ayah start: at most 10 words; past 6 only when a mark or the ayah end stops it; a capped one never ends on a madd
let bad = 0, capped = 0;
for (const x of quran) {
  const q = at(x.s, x.a), ws = q.nextPhrase().split(' '), n = q.fathPlace()?.count ?? 0;
  const marked = /[\u06D6-\u06DB]/.test(x.t.split(' ').filter((w: string) => !/^[\u06D6-\u06DB۞۩٠-٩]+$/.test(w))[n - 1] ?? '') || n === x.c.split(' ').length;
  if (!/[\u064B-\u0652]/.test(ws.join(''))) continue; // no printed words for this ayah (they do not line up): plain text, ends at the ayah end
  if (!marked) capped++;
  if (ws.length !== n || n > 10 || (!marked && (n > 6 || /[\u0622\u0653][\u064B-\u0652]*$/.test(ws[n - 1])))) bad++, bad < 4 && console.log('  ', x.s, x.a, n, q.nextPhrase());
}
check(`all ${quran.length} ayat: within the rules (${capped} capped at 6)`, bad === 0, { bad });
// the reciter's own pause shortens it (user 2026-11-08): al-Kouchi pauses before «نارا» in 2:16 (j = [0, 4])
const kouchi = JSON.parse(readFileSync('client/public/riwayat/warsh/words/laayoun-kouchi/002.json', 'utf8'));
check('2:16 from its start, al-Kouchi: 4 words, to his pause', pausedCount(kouchi, 16, 0, 9) === 4, pausedCount(kouchi, 16, 0, 9));
check('2:16 from «فلما»: no pause before the mark, the 4 words to «حوله»', pausedCount(kouchi, 16, 5, 4) === 4, pausedCount(kouchi, 16, 5, 4));
check('a pause right at the end changes nothing', pausedCount(kouchi, 16, 0, 4) === 4, pausedCount(kouchi, 16, 0, 4));
process.exit(fails ? 1 : 0);
