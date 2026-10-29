// PositionTracker after a transcript gap (words the transcript dropped), plus the skip/move cases placeStretch decides.
// Build: client/node_modules/.bin/esbuild test/tracker_gap.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/gap.mjs
// Run:   node /tmp/hw/gap.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);

function run(label: string, s: number, a: number, chunks: string[][], expect: (t: PositionTracker) => boolean) {
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, s, a));
  for (const c of chunks) t.feed(c.join(' ') + ' ');
  const p = t.position();
  const ok = expect(t);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: at ${p?.ayah.s}:${p?.ayah.a} word ${p?.word}, skipped=${JSON.stringify(t.skipped && [t.skipped.from.a, t.skipped.to.a, t.skipped.moved])}`);
  return ok;
}

let fails = 0;
// Baqara 281 (the longest ayah in the Warsh count, 128 words): recite 10 words, gap of 30 words, then 8 more words in 2 stretches
const b281 = words(2, 281);
fails += +!run('gap 30 words inside 2:281', 2, 281, [b281.slice(0, 10), b281.slice(40, 48), b281.slice(48, 56)],
  (t) => t.position()!.ayah.a === 281 && t.position()!.word === 56 && !t.skipped);
// gap of 20 words
fails += +!run('gap 20 words inside 2:281', 2, 281, [b281.slice(0, 10), b281.slice(30, 38)],
  (t) => t.position()!.word === 38 && !t.skipped);
// gap across an ayah end into the next ayah: Baqara 255 start → lose the end of 255 → 256 middle
const a255 = words(2, 255), a256 = words(2, 256);
fails += +!run('gap 255 → middle of 256', 2, 255, [a255.slice(0, 12), a256.slice(6, 14)],
  (t) => t.position()!.ayah.a === 256 && t.position()!.word === 14 && !t.skipped);
// small gap (handled by feed's window already)
fails += +!run('gap 5 words inside 2:281', 2, 281, [b281.slice(0, 10), b281.slice(15, 22)],
  (t) => t.position()!.word === 22);
// a real skip of 2+ ayat is still reported
const k = (a: number) => words(18, a);
fails += +!run('skip Kahf 1 mid → 4 mid (still a skip)', 18, 1, [k(1).slice(0, 7), k(4).slice(2, 9)],
  (t) => !!t.skipped && t.skipped.to.a === 4 && !t.skipped.moved);
// continuing normally is untouched
fails += +!run('plain continuation 2:281', 2, 281, [b281.slice(0, 10), b281.slice(10, 20), b281.slice(20, 30)],
  (t) => t.position()!.word === 30 && !t.skipped);
// going back a little (repetition after «أعد») is untouched
fails += +!run('repeat back in 2:281', 2, 281, [b281.slice(0, 20), b281.slice(14, 24)],
  (t) => t.position()!.word === 24 && !t.skipped);
// a deliberate move: a finished ayah, then the start of another one further on (followed silently)
const m = (a: number) => words(2, a);
fails += +!run('move: end of 2:255 → start of 2:258', 2, 255, [m(255).slice(0, 10), m(255).slice(10), m(258).slice(0, 8)],
  (t) => !!t.skipped && t.skipped.to.a === 258 && t.skipped.moved);
console.log(fails ? `${fails} failing` : 'all ok');
process.exit(fails ? 1 : 0);
