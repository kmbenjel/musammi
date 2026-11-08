// Fixes of 2026-11-06 for the 2026-11-03 study (HANDOFF «Open»): «افتح» inside a longer sentence of talk asks the fath;
// an unannounced open_mushaf to a far place within 20 s of a played «أعد» is refused (the slip itself, 11-02 19:52);
// a reply to his voice that Google wrote nothing of is played, with «(كلامٌ لم يُكتب)» as his line, while a bare «أعد»
// on nothing stays muted. Drives RecitationSession.handle() like test/feedback_guard.ts.
// Build: client/node_modules/.bin/esbuild test/study_1103.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/study.mjs
// Run:   node /tmp/hw/study.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const surahs = [{ no: 16, name_ar: 'النحل' }, { no: 24, name_ar: 'النور' }, { no: 25, name_ar: 'الفرقان' }];
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);

function session(s0: number, a0: number, fed = 8) {
  const events: string[] = [], teacher: string[] = [], played: string[] = [], you: string[] = [], asked: string[] = [], sent: any[] = [];
  const ev: any = new Proxy({}, {
    get: (_t, k) =>
      k === 'onEvent' ? (e: string) => events.push(e)
      : k === 'onTeacher' ? (t: string) => teacher.push(t)
      : k === 'onYou' ? (t: string, done: boolean) => done && you.push(t)
      : () => {},
  });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran, surahs, diffs: {} }, fromHafs: async () => null } as any, ev);
  s.ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  s.ready = true;
  s.reciting = true;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.prefetchFath = () => {};
  s.askFath = (what: string) => asked.push(what);
  s.play = () => !s.wordPlayed && played.push('audio');
  s.wordBufs = new Map([['aad', {}], ['subhan', {}]]);
  s.outCtx = { currentTime: 100, createBufferSource: () => ({ connect: () => ({ connect() {} }), start() {} }), createGain: () => ({ gain: {}, connect: () => ({ connect() {} }) }), destination: {} };
  s.sayWord = (x: string) => (s.wordBufs?.has(x) ? (played.push('word:' + x), true) : false);
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, s0, a0));
  s.tracker = t;
  if (fed) t.feed(words(s0, a0).slice(0, fed).join(' ') + ' ');
  s.stretchFrom = t.mark();
  const hear = (...chunks: string[]) => {
    for (const h of chunks) s.handle({ serverContent: { inputTranscription: { text: h } } });
    s.finishYou();
  };
  const reply = (said: string) => {
    s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    s.handle({ serverContent: { outputTranscription: { text: said } } });
    s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    s.handle({ serverContent: { generationComplete: true } });
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    sent.length = 0;
    s.handle({ toolCall: { functionCalls: [{ id: '1', name, args }] } });
    for (let i = 0; i < 50 && !sent.some((m) => m.toolResponse); i++) await new Promise((r) => setTimeout(r, 5));
    return sent.find((m) => m.toolResponse)?.toolResponse.functionResponses[0].response;
  };
  return { s, t, events, teacher, played, you, asked, hear, reply, tool };
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
  // 1. «افتح» in a longer sentence of talk.
  {
    const { asked, hear } = session(25, 17);
    hear('لا لا افتح بعد ذلك ');
    check('«لا لا، افتح بعد ذلك» (5 words of talk) asks the fath', asked.length === 1, asked);
    hear('افتح ');
    check('«افتح» alone still asks', asked.length === 2, asked);
    hear('قال لي الشيخ في الدرس أن افتح الباب يا ولد ');
    check('nine words: not a request', asked.length === 2, asked);
  }
  // 2. open_mushaf after «أعد».
  {
    const { s, t, events, played, hear, reply, tool } = session(24, 40);
    hear(words(24, 40).slice(8, 11).join(' ') + ' ', 'الطير مسخرات ');
    reply('أعِد.');
    check('the slip got the recorded «أعد»', played.join() === 'word:aad', played);
    now += 6000;
    let r = await tool('open_mushaf', { surah: 16, ayah: 79 });
    check('6 s later, open_mushaf 16:79 unannounced: refused, the tracker stays at 24:40', /لم يُفتح/.test(r?.result ?? '') && t.current()?.s === 24 && events.some((e) => e.startsWith('slip 16:79 (6s after «أعِد» at 24:40)')), { r: String(r?.result).slice(0, 40), at: t.current()?.a, ev: events.filter((e) => e.startsWith('slip')) });
    r = await tool('open_mushaf', { surah: 16, ayah: 79, announced: true });
    check('announced: opened', !/لم يُفتح/.test(r?.result ?? '') && t.current()?.s === 16, { at: `${t.current()?.s}:${t.current()?.a}` });
    s.tracker = t; t.setRange(rangeFrom(quran, 24, 40)); t.feed(words(24, 40).slice(0, 8).join(' ') + ' ');
    hear(words(24, 40).slice(8, 11).join(' ') + ' ', 'الطير مسخرات ');
    reply('أعِد.');
    now += 25000;
    r = await tool('open_mushaf', { surah: 16, ayah: 79 });
    check('25 s after «أعد»: opened as before', !/لم يُفتح/.test(r?.result ?? '') && t.current()?.s === 16, { at: `${t.current()?.s}:${t.current()?.a}` });
    s.tracker = t; t.setRange(rangeFrom(quran, 24, 40)); t.feed(words(24, 40).slice(0, 8).join(' ') + ' ');
    hear(words(24, 40).slice(8, 11).join(' ') + ' ', 'الطير مسخرات ');
    reply('أعِد.');
    now += 3000;
    r = await tool('open_mushaf', { surah: 24, ayah: 41 });
    check('a near place right after «أعد»: opened', !/لم يُفتح/.test(r?.result ?? '') && t.current()?.a === 41, { at: `${t.current()?.s}:${t.current()?.a}` });
  }
  // 3. His unwritten voice.
  {
    const { s, teacher, you, events, reply } = session(25, 17);
    s.voiceSinceGen = 2500; // 2.5 s of his voice, nothing written
    reply('لا، لم ألحظ خطأً في تلاوتك.');
    check('an answer after 2.5 s of unwritten voice: played, his line is the placeholder', teacher.length === 1 && you.join() === '(كلامٌ لم يُكتب)' && events.some((e) => e.startsWith('unheard voice 2.5s')), { teacher, you });
    s.voiceSinceGen = 2500;
    reply('أعِد.');
    check('a bare «أعد» on unwritten voice: still muted (nothing heard)', teacher.length === 1 && events.some((e) => e.startsWith('muted (nothing heard)')), events.filter((e) => e.startsWith('muted')));
    s.voiceSinceGen = 800;
    reply('خذ وقتك.');
    check('a remark after 0.8 s (a breath): muted', teacher.length === 1, teacher);
  }
} finally {
  Date.now = realNow;
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
