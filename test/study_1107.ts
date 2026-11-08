// Fixes of 2026-11-07 for the 11-04 → 11-06 study (archive/scratch-2026-11-07/sessions-1104-1106.md): a skip the
// tracker reports after time enough for the ayah left out (or with heard words that matched nothing) is sent as a doubt
// without asking for «أعد» (25:18 read whole, written as garbage, 11-05 17:51); a why-question after «أعد» sends the
// model the facts (what was written, the mushaf there) instead of leaving it to invent a reason (22:30 576 s).
// Drives RecitationSession.handle() like test/feedback_guard.ts.
// Build: client/node_modules/.bin/esbuild test/study_1107.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/study7.mjs
// Run:   node /tmp/hw/study7.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const surahs = [{ no: 25, name_ar: 'الفرقان' }];
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);

function session(s0: number, a0: number, fed: number) {
  const events: string[] = [], sent: any[] = [], played: string[] = [];
  const ev: any = new Proxy({}, { get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : () => {}) });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran, surahs, diffs: {} } } as any, ev);
  s.ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  s.ready = true;
  s.reciting = true;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.prefetchFath = () => {};
  s.play = () => {};
  s.wordBufs = new Map([['aad', {}]]);
  s.outCtx = { currentTime: 100, createBufferSource: () => ({ connect: () => ({ connect() {} }), start() {} }), createGain: () => ({ gain: {}, connect: () => ({ connect() {} }) }), destination: {} };
  s.sayWord = (x: string) => (played.push(x), true);
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, s0, a0), false, {});
  s.tracker = t;
  t.feed(words(s0, a0).slice(0, fed).join(' ') + ' ');
  s.lastRecitedAt = Date.now();
  s.stretchFrom = t.mark();
  const hear = (...chunks: string[]) => {
    for (const h of chunks) s.handle({ serverContent: { inputTranscription: { text: h } } });
    s.finishYou();
  };
  const reply = (said: string) => {
    s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    s.handle({ serverContent: { outputTranscription: { text: said } } });
    s.handle({ serverContent: { generationComplete: true } });
  };
  const notes = () => sent.filter((m) => m.realtimeInput?.text).map((m) => m.realtimeInput.text as string);
  return { s, t, events, sent, played, hear, reply, notes };
}

let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;
let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

try {
  // 25:17 read to its end; 25:18 (16 words) garbled by the transcription; 25:19 placed: a skip 17→19.
  const w17 = words(25, 17), w19 = words(25, 19);
  // 1. Twenty seconds passed and garbage was heard: a doubt, no «أعد» asked.
  {
    const { s, events, hear, notes } = session(25, 17, 8);
    hear(w17.slice(8).join(' ') + ' '); // to the end of 25:17
    now += 20000;
    hear('تحتهم واباؤهم '); // 25:18's end, as written on 2026-11-05 17:51
    hear(w19.slice(0, 6).join(' ') + ' ');
    const skip = events.find((e) => e.startsWith('skip 25:17'));
    const doubted = events.find((e) => e.startsWith('skip doubted'));
    const note = notes().find((x) => /لا تقل «أعِد» لهذا وحده/.test(x));
    check('a skip after 20 s with garbage heard: reported as a doubt, «أعد» not asked', !!skip && !!doubted && !!note && !notes().some((x) => /قل له «أعِد»/.test(x)), { skip, doubted, note: note?.slice(0, 80) });
    check('the tracker followed him to 25:19 all the same', s.tracker.current()?.a === 19, s.tracker.current()?.a);
  }
  // 2. He jumped within a 2 s pause and nothing else was heard: the real skip note, «أعد» asked.
  {
    const { events, hear, notes } = session(25, 17, 8);
    hear(w17.slice(8).join(' ') + ' ');
    now += 2000;
    hear(w19.slice(0, 6).join(' ') + ' ');
    const note = notes().find((x) => /قل له «أعِد» الآن/.test(x));
    check('a jump within 2 s, nothing else heard: the skip note asks for «أعد»', events.some((e) => e.startsWith('skip 25:17')) && !events.some((e) => e.startsWith('skip doubted')) && !!note, { ev: events.filter((e) => e.startsWith('skip')), note: note?.slice(0, 60) });
  }
  // 3. «لماذا قلت أعد؟» after an «أعد»: the facts go to the model.
  {
    const { events, played, hear, reply, notes } = session(25, 17, 8);
    hear(w17.slice(8, 11).join(' ') + ' ', 'ضلوا ');
    reply('أعِد.');
    check('the «أعد» played', played.join() === 'aad', played);
    hear('لماذا قلت اعد ');
    const note = notes().find((x) => /يسأل القارئ عن سبب آخر «أعِد»/.test(x));
    check('the why-note carries what was written and the mushaf words at the place', !!note && note.includes('ضلوا') && note.includes('سورة الفرقان، الآية 17') && /لا تخترع سبباً/.test(note), { note: note?.slice(0, 160), ev: events.filter((e) => e.startsWith('why')) });
    hear('ما الخطا ');
    check('«ما الخطأ؟» asks too', notes().filter((x) => /يسأل القارئ عن سبب/.test(x)).length === 2, notes().length);
  }
  // 4. No «أعد» yet: a why-question sends nothing.
  {
    const { hear, notes } = session(25, 17, 8);
    hear('لماذا قلت اعد ');
    check('no «أعد» before it: no note', !notes().some((x) => /يسأل القارئ/.test(x)), notes().length);
  }
} finally {
  Date.now = realNow;
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
