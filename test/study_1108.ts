// The 2026-11-08 audit's fixes, through handle(): the app places him itself when nothing is open (02:43) and when one
// common word matched near the opened page (02:44: «من» inside 25:12 while he read 19:49).
// Build: client/node_modules/.bin/esbuild test/study_1108.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/s1108.mjs
// Run:   node /tmp/hw/s1108.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const surahs: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/surahs.json', 'utf8'));
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

function session(open?: [number, number]) {
  const events: string[] = [];
  const ev: any = new Proxy({}, { get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : () => {}) });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran, surahs, diffs: {} } } as any, ev);
  s.ws = { readyState: 1, send: () => {} };
  s.ready = true;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.prefetchFath = () => {};
  s.play = () => {};
  const t = new PositionTracker();
  if (open) t.setRange(rangeFrom(quran, open[0], open[1]));
  s.tracker = t;
  const hear = (text: string) => s.handle({ serverContent: { inputTranscription: { text } } });
  return { s, events, hear };
}

{
  // 02:43: no place open (no resume), he recites 19:49
  const { events, hear } = session();
  const w = words(19, 49);
  hear(w.slice(0, 6).join(' ') + ' ');
  hear(w.slice(6, 12).join(' ') + ' ');
  check('nothing open: placed at 19:49', events.some((e) => e === 'placed 19:49'), events.filter((e) => e.startsWith('placed')));
}
{
  // 02:44: the remembered page 361 opened at 25:12; he recites 19:49
  const { events, hear } = session([25, 12]);
  hear('وما يعبدون من دون الله وهبنا له اسحاق ويعقوب ');
  hear('وكلا جعلنا نبيا ');
  check('25:12 open, 19:49 recited: placed at 19:49', events.some((e) => /^placed 19:4[89]$/.test(e)), events.filter((e) => e.startsWith('placed')));
}
{
  // his own reading of the opened ayah still follows there, no placing elsewhere
  const { events, hear } = session([25, 12]);
  const w = words(25, 12);
  hear(w.slice(0, 5).join(' ') + ' ');
  check('the opened ayah read: followed there, not placed elsewhere', !events.some((e) => e.startsWith('placed')), events.filter((e) => e.startsWith('placed')));
}
process.exit(fails ? 1 : 0);
