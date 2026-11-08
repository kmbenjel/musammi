// «راجع الجلسة» (user 2026-11-07): the session_review tool answers from the app's own record — minutes, the runs of ayat
// read, the place now, every played «أعد» with what was heard and the mushaf's words there — so a handover or a
// reconnect (a fresh context) loses nothing. Drives RecitationSession.handle() like test/feedback_guard.ts.
// Build: client/node_modules/.bin/esbuild test/session_review.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/review.mjs
// Run:   node /tmp/hw/review.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const surahs = [{ no: 25, name_ar: 'الفرقان' }];
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);

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
t.setRange(rangeFrom(quran, 25, 17), false, {});
s.tracker = t;
let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;
s.startedAt = now;
const hear = (...chunks: string[]) => {
  for (const h of chunks) s.handle({ serverContent: { inputTranscription: { text: h } } });
  s.finishYou();
};
const reply = (said: string) => {
  s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  s.handle({ serverContent: { outputTranscription: { text: said } } });
  s.handle({ serverContent: { generationComplete: true } });
};
const tool = async (name: string) => {
  sent.length = 0;
  s.handle({ toolCall: { functionCalls: [{ id: '1', name, args: {} }] } });
  for (let i = 0; i < 50 && !sent.some((m) => m.toolResponse); i++) await new Promise((r) => setTimeout(r, 5));
  return sent.find((m) => m.toolResponse)?.toolResponse.functionResponses[0].response?.result as string;
};
let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

try {
  let r = await tool('session_review');
  check('nothing read yet', /لم تُقرأ آية بعد/.test(r) && /لا تنبيه/.test(r), r.slice(0, 80));
  hear(words(25, 17).join(' ') + ' ');
  hear(words(25, 18).join(' ') + ' ');
  now += 4 * 60000;
  hear(words(25, 19).slice(0, 5).join(' ') + ' ', 'يذقه عذابا كبيرا ');
  reply('أعِد.');
  check('the «أعد» played', played.join() === 'aad', played);
  hear(words(25, 19).join(' ') + ' ');
  r = await tool('session_review');
  check('minutes, the run 17–19, the place, the one «أعد» with what was heard and the mushaf', /الجلسة منذ 4 دقيقة/.test(r) && /سورة الفرقان من الآية 17 إلى 19/.test(r) && /الموضع الآن: سورة الفرقان، الآية (19|20)/.test(r) && /التنبيهات \(1\)/.test(r) && /سورة الفرقان، الآية 19 — سُمع: «.*يذقه عذابا كبيرا»/.test(r) && /المصحف: «/.test(r), r);
  check('the event', events.some((e) => /^session review: 1 runs, 1 «أعد»/.test(e)), events.filter((e) => e.startsWith('session review')));
} finally {
  Date.now = realNow;
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
