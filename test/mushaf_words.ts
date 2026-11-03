// The mushaf mode: the words a hidden page writes. Every printed word of every ayah is reached when the ayah is
// recited as printed; through the session, a stretch writes its words, «أعد» takes them back and marks the place,
// «افتح» gives no fath, and turning to a page opens it for the tracker and the teacher.
// Build: client/node_modules/.bin/esbuild test/mushaf_words.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/mwords.mjs
// Run:   node /tmp/hw/mwords.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession, type WordAt } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { printedWords } from '../client/src/mushaf/layout';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const layout = JSON.parse(readFileSync('client/public/riwayat/warsh/mushaf.json', 'utf8'));
let fails = 0;
const check = (label: string, ok: boolean, info: unknown = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${typeof info === 'string' ? info : JSON.stringify(info)}`);
  fails += +!ok;
};

// 1. each ayah recited exactly writes all its printed words, and only its own
let missing = 0;
const bad: string[] = [];
for (const x of quran) {
  const t = new PositionTracker();
  t.setRange([x]);
  t.feed(n(x.c).split(' ').join(' ') + ' . ');
  // one-letter words (صٓ، قٓ، نٓ) are not matched: the session writes them when the stretch passes (below)
  const got = new Set(t.hits.map((k) => t.printedAt(k)!).filter((w) => w.id === x.id).map((w) => w.k));
  printedWords(x).forEach((p, k) => n(p).length < 2 && got.add(k));
  const want = printedWords(x).length;
  if (got.size < want) {
    missing += want - got.size;
    if (bad.length < 5) bad.push(`${x.s}:${x.a} ${got.size}/${want}`);
  }
}
check('every printed word reached when each ayah is recited', missing === 0, `${missing} missing ${bad.join(', ')}`);

// 2. the layout holds every printed word once, in order
const seen = new Map<number, number[]>();
for (const p of layout.pages) for (const l of p.l) if (Array.isArray(l)) for (const [id, k0, k1] of l) for (let k = k0; k <= k1; k++) (seen.get(id) ?? seen.set(id, []).get(id)!).push(k);
const wrong = quran.filter((x) => (seen.get(x.id) ?? []).join() !== printedWords(x).map((_, k) => k).join());
check('the layout places each printed word once, in order', wrong.length === 0, wrong.slice(0, 5).map((x) => `${x.s}:${x.a}`));

// 3. through the session
function session() {
  const log: { words: WordAt[]; undo: boolean }[] = [], misses: (WordAt | null)[] = [], places: WordAt[] = [], sent: string[] = [];
  const events: string[] = [];
  const ev: any = new Proxy(
    { onWords: (w: WordAt[], undo: boolean) => log.push({ words: w, undo }), onMiss: (w: WordAt | null) => misses.push(w), onPlace: (w: WordAt) => places.push(w), onEvent: (e: string) => events.push(e) },
    { get: (t: any, k) => t[k] ?? (() => {}) },
  );
  const m = { key: 'warsh', quran, surahs: JSON.parse(readFileSync('client/public/riwayat/warsh/surahs.json', 'utf8')), diffs: {}, toHafs: {} };
  const s: any = new RecitationSession({ mushaf: m, mode: 'mushaf' } as any, ev);
  s.ws = { readyState: 1, send: (x: string) => sent.push(x) };
  s.ready = true;
  s.startTurnAudio = () => {};
  s.play = () => {};
  return { s, log, misses, places, sent, events };
}
const ayah = (s: number, a: number) => quran.find((x) => x.s === s && x.a === a);
const heard = (x: any, from: number, to: number) => n(x.c).split(' ').slice(from, to).join(' ');

{
  const { s, log, misses, places } = session();
  const x = ayah(67, 1);
  s.openAt(x.id, 562);
  s.handle({ serverContent: { inputTranscription: { text: heard(x, 0, 6) + ' ' } } });
  const written = log.filter((l) => !l.undo).flatMap((l) => l.words);
  check('a stretch writes its words', written.length >= 5 && written.every((w) => w.id === x.id), written);
  check('the page follows the next word', places.length > 0 && places[places.length - 1].id === x.id, places.slice(-1));
  s.closing = true;
  s.handle({ serverContent: { outputTranscription: { text: 'أعِد' } } });
  s.handle({ serverContent: { generationComplete: true } });
  const undone = log.filter((l) => l.undo).flatMap((l) => l.words);
  check('«أعد» takes them back', undone.length === written.length, undone.length);
  check('…and marks where it fell', misses.length === 1 && misses[0]?.id === x.id && misses[0]?.k === 0, misses);
}
{
  const { s, log } = session();
  const x = ayah(67, 2);
  s.openAt(x.id, 562);
  // the transcript dropped the 3rd word: accepted with no «أعد», it is written too
  const ws = n(x.c).split(' ');
  s.handle({ serverContent: { inputTranscription: { text: [...ws.slice(0, 2), ...ws.slice(3, 7)].join(' ') + ' . ' } } });
  s.closing = true;
  s.handle({ serverContent: { generationComplete: true } });
  const written = new Set(log.filter((l) => !l.undo).flatMap((l) => l.words).map((w) => w.k));
  check('a word the transcript dropped is written once the stretch passes', written.has(2), [...written]);
}
{
  const { s, log } = session();
  const x = ayah(67, 3);
  s.openAt(x.id, 562);
  // two stretches, the word between them heard wrong at the cut: written once the second passes
  const ws = n(x.c).split(' ');
  s.handle({ serverContent: { inputTranscription: { text: ws.slice(0, 4).join(' ') + ' . ' } } });
  s.closing = true;
  s.handle({ serverContent: { generationComplete: true } });
  s.handle({ serverContent: { inputTranscription: { text: ['وما', ...ws.slice(5, 9)].join(' ') + ' . ' } } });
  s.closing = true;
  s.handle({ serverContent: { generationComplete: true } });
  const written = new Set(log.filter((l) => !l.undo).flatMap((l) => l.words).map((w) => w.k));
  check('a word lost between two stretches that passed is written', written.has(4), [...written]);
}
{
  const { s, log } = session();
  const x = ayah(38, 1);
  s.openAt(x.id, 453);
  s.handle({ serverContent: { inputTranscription: { text: 'ص ' + heard(x, 1, 6) + ' . ' } } });
  s.closing = true;
  s.handle({ serverContent: { generationComplete: true } });
  const written = new Set(log.filter((l) => !l.undo).flatMap((l) => l.words).filter((w) => w.id === x.id).map((w) => w.k));
  check('«صٓ» is written once the stretch after it passes', written.has(0), [...written]);
}
{
  const { s, events, sent } = session();
  const x = ayah(67, 3);
  s.openAt(x.id, 562);
  s.handle({ serverContent: { inputTranscription: { text: heard(x, 0, 4) + ' ' } } });
  s.you = '';
  s.handle({ serverContent: { inputTranscription: { text: 'افتح ' } } });
  check('«افتح» asks no fath', !events.some((e) => e.startsWith('fath')), events.filter((e) => e.startsWith('fath')));
  check('turning to a page sends its text to the teacher', sent.some((x) => x.includes('الصفحة 562')), sent.length);
}
console.log(fails ? `${fails} failing` : 'all ok');
process.exit(fails ? 1 : 0);
