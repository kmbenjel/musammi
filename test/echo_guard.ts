// The teacher's own words coming back through the mic, through handle(): its reply to them is not played; what the
// reciter says or recites after an answer still is (session 2026-11-01 08:36: 72 s said, 75 s heard as his, 77 s answered).
// Build: client/node_modules/.bin/esbuild test/echo_guard.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/echo.mjs
// Run:   node /tmp/hw/echo.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const w = n(quran.find((x) => x.s === 23 && x.a === 44).c).split(' ').filter(Boolean);

const SAID = 'على الرحب والسعة، بارك الله فيك.';
const REPLY = 'وفيك بارك الله، ونفع بك.';

/** After the teacher said `said`, ending `after` seconds ago, the mic brings `heard` (in these chunks), and the model replies. */
function reply(heard: string[], { said = SAID, after = 1, answer = REPLY, praying = false } = {}) {
  const events: string[] = [], teacher: string[] = [];
  const ev: any = new Proxy({}, { get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : k === 'onTeacher' ? (t: string) => teacher.push(t) : () => {}) });
  const s: any = new RecitationSession({} as any, ev);
  s.ws = { readyState: 1, send: () => {} };
  s.ready = true;
  s.praying = praying;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.outCtx = { currentTime: 100 };
  s.playEnd = 100 - after;
  s.spoken = { text: said, t0: 97 - after };
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 23, 44));
  s.tracker = t;
  t.feed(w.slice(0, 8).join(' ') + ' ');
  for (const text of heard) s.handle({ serverContent: { inputTranscription: { text } } });
  s.handle({ serverContent: { outputTranscription: { text: answer } } });
  s.handle({ serverContent: { generationComplete: true } });
  return { played: teacher.length > 0, muted: events.some((e) => e.startsWith('muted')) };
}

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};
let r = reply(['على الرحب والسعه، بارك الله فيك.']);
check('08:36: its own sentence back, one chunk: not played', !r.played && r.muted, r);
r = reply(['على ', 'الرحب ', 'والسعه، ', 'بارك ', 'الله ', 'فيك.']);
check('the same in one-word chunks: not played', !r.played && r.muted, r);
r = reply(['بارك الله فيك']);
check('three words of it: not played', !r.played && r.muted, r);
r = reply(['على الرحب والسعه، متى نكمل السورة غدا ان شاء الله']);
check('its words, then his own: played', r.played && !r.muted, r);
r = reply(['جزاك الله خيرا يا شيخ'], { said: 'جزاك الله خيراً يا بني، لطفك هذا من طيب أصلك.' });
check('his thanks in nearly its words (10-28): played', r.played && !r.muted, r);
r = reply(['اقرا من قوله تعالى افلم يدبروا'], { said: 'اقرأ من قوله تعالى: "أَفَلَمْ يَدَّبَّرُوا اُ۬لْقَوْلَ".', answer: 'أحسنت، بارك الله فيك، فقد أتممت السورة.' });
check('its words in quotes back (10-30 07:19): not played', !r.played && r.muted, r);
r = reply(['بارك الله']);
check('two words tell nothing: played', r.played && !r.muted, r);
r = reply(['هل قرأت هذه الآية بوجه صحيح يا شيخ']);
check('his question after the answer: played', r.played && !r.muted, r);
r = reply(['على الرحب والسعه، بارك الله فيك.'], { after: 8 });
check('long after the audio ended, it cannot be echo: played', r.played && !r.muted, r);
const fath = w.slice(8, 14).join(' ');
r = reply([fath], { said: fath, answer: 'أعِد.' });
check('he repeats the fath in the mushaf: recitation, played', r.played && !r.muted, r);
r = reply([fath], { said: fath, answer: 'أعِد.', praying: true });
check('the same in salat: played', r.played && !r.muted, r);
process.exit(fails ? 1 : 0);
