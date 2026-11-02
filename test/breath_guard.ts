// The session's «أعد» guard, through handle(): out of salat a false «أعد» after a breath is not played, a real one is;
// a longer answer and the salat rules stay as they were.
// Build: client/node_modules/.bin/esbuild test/breath_guard.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/breath.mjs
// Run:   node /tmp/hw/breath.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const w = n(quran.find((x) => x.s === 29 && x.a === 46).c).split(' ').filter(Boolean);

function reply(said: string, stretch: string, praying = false) {
  const events: string[] = [], teacher: string[] = [];
  const ev: any = new Proxy({}, { get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : k === 'onTeacher' ? (t: string) => teacher.push(t) : () => {}) });
  const s: any = new RecitationSession({} as any, ev);
  s.ws = { readyState: 1, send: () => {} };
  s.ready = true;
  s.praying = praying;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 29, 46));
  s.tracker = t;
  t.feed(w.slice(0, 12).join(' ') + ' ');
  s.stretchFrom = t.mark();
  s.stretchMark = { reached: t.reached, matched: t.matched, seen: t.seen, exact: t.exact };
  t.feed(stretch + ' ');
  s.handle({ serverContent: { outputTranscription: { text: said } } });
  s.handle({ serverContent: { generationComplete: true } });
  return { played: teacher.length > 0, muted: events.some((e) => e.startsWith('muted')) };
}

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};
let r = reply('أعِد.', 'وقولوا آمنا بالذي');
check('out of salat, right so far, stopped at «بالذي»: not played', !r.played && r.muted, r);
r = reply('أعِد.', 'وقولوا بالذي انزل');
check('out of salat, a word left out: played', r.played && !r.muted, r);
r = reply('أعِد.', 'وقولوا آمنا بالتي');
check('out of salat, a wrong word: played', r.played && !r.muted, r);
r = reply('بارك الله فيك', 'وقولوا آمنا بالذي');
check('out of salat, any other answer: played', r.played && !r.muted, r);
r = reply('أعِد.', 'وقولوا آمنا بالذي', true);
check('in salat, right so far: not played, as before', !r.played && r.muted, r);
r = reply('أعِد.', 'وقولوا آمنا بالتي', true);
check('in salat, a wrong word: played', r.played && !r.muted, r);
console.log(fails ? `${fails} failing` : 'all ok');
process.exit(fails ? 1 : 0);
