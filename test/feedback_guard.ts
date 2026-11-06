// The feedback guards of 2026-11-06, through handle(): a remark on nothing heard, the same remark again with nothing
// new, an unasked fath outside salat, «سبحان الله» as the correction word in salat, and the recorded word replacing
// the model's audio. A real «أعد» after new words still plays.
// Build: client/node_modules/.bin/esbuild test/feedback_guard.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/feedback.mjs
// Run:   node /tmp/hw/feedback.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const w = n(quran.find((x) => x.s === 25 && x.a === 17).c).split(' ').filter(Boolean);

interface Turn {
  heard?: string[]; // the reciter's transcript chunks before the reply
  said: string; // the reply
  note?: boolean; // the app sent the model a note first
  gap?: number; // ms between this turn and the one before
}

/** A session at 25:17 (8 words in), playing a list of turns; what was played and what was muted, in order. */
function run(turns: Turn[], { praying = false, word = true } = {}) {
  const events: string[] = [], teacher: string[] = [], played: string[] = [];
  const ev: any = new Proxy({}, { get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : k === 'onTeacher' ? (t: string) => teacher.push(t) : () => {}) });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran, surahs: [], diffs: {} } } as any, ev);
  s.ws = { readyState: 1, send: () => {} };
  s.ready = true;
  s.praying = praying;
  s.reciting = true;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.prefetchFath = () => {};
  s.play = () => !s.wordPlayed && played.push('audio');
  if (word) s.wordBufs = new Map([['aad', {}], ['subhan', {}]]);
  s.outCtx = { currentTime: 100, createBufferSource: () => ({ connect: () => ({ connect() {} }), start() {} }), createGain: () => ({ gain: {}, connect: () => ({ connect() {} }) }), destination: {} };
  s.sayWord = (x: string) => (s.wordBufs?.has(x) ? (played.push('word:' + x), true) : false);
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 25, 17));
  s.tracker = t;
  t.feed(w.slice(0, 8).join(' ') + ' ');
  s.stretchFrom = t.mark();
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    for (const turn of turns) {
      now += turn.gap ?? 3000;
      for (const h of turn.heard ?? []) s.handle({ serverContent: { inputTranscription: { text: h } } });
      if (turn.heard?.length) s.finishYou(); // the cut
      if (turn.note) s.send({ realtimeInput: { text: 'note' } });
      s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
      s.handle({ serverContent: { outputTranscription: { text: turn.said } } });
      s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
      s.handle({ serverContent: { generationComplete: true } });
    }
  } finally {
    Date.now = realNow;
  }
  return { teacher, muted: events.filter((e) => e.startsWith('muted')).map((e) => e.match(/\((.*?)\)/)?.[1] ?? 'muted'), played };
}

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

let r = run([{ heard: [w.slice(8, 11).join(' ') + ' ', 'ضلوا '], said: 'أعِد.' }]);
check('a slip after new words: «أعد» played as the recorded word, the model audio dropped', r.teacher.length === 1 && r.played.join() === 'word:aad', r);
r = run([{ heard: ['فيقول اانتم '], said: 'أعِد.' }, { said: 'أعِد.' }, { said: 'أعِد.' }]);
check('«أعد» again on nothing heard: muted twice', r.teacher.length === 1 && r.muted.join() === 'nothing heard,nothing heard', r);
r = run([{ heard: ['فيقول اانتم '], said: 'أعِد.' }, { heard: ['فيقول '], said: 'أعِد.' }, { heard: ['فيقول اانتم اضللتم '], said: 'أعِد.' }]);
check('«أعد» after one word: muted (repeat); after three: played', r.teacher.length === 2 && r.muted.join() === 'repeat', r);
r = run([{ heard: ['نعم '], said: 'تفضّل، أنا معك.' }, { said: 'تفضّل، أنا معك.' }, { said: 'خذ وقتك.' }]);
check('greetings on nothing: muted', r.teacher.length === 1 && r.muted.length === 2, r);
r = run([{ heard: ['انا في سوره الفرقان '], said: 'تفضّل، أنا معك.' }, { heard: ['طيب '], said: 'تفضّل، أنا معك.' }]);
check('the same remark again after one word: muted (repeat)', r.teacher.length === 1 && r.muted.join() === 'repeat', r);
r = run([{ heard: ['نعم '], said: 'بسم الله.' }, { said: 'السؤال الأول.', note: true }]);
check('a reply to an app note with nothing heard: played', r.teacher.length === 2 && !r.muted.length, r);
r = run([{ heard: ['نعم '], said: 'بسم الله.', note: true }, { said: 'السؤال الأول.', gap: 2000 }, { said: 'السؤال الأول: اقرأ.', gap: 20000 }]);
check('a note answered a generation later: played; 20 s on, no longer', r.teacher.length === 2 && r.muted.join() === 'nothing heard', r);
r = run([{ heard: [w.slice(8, 11).join(' ') + ' '], said: 'أَضْلَلْتُمْ عِبَادِي هَٰٓؤُلَآءِ' }]);
check('mushaf words at his place, unasked, while reciting: muted (unasked fath)', r.muted.join() === 'unasked fath', r);
r = run([{ heard: ['ما هي بداية الآية التاسعة عشرة '], said: 'أَضْلَلْتُمْ عِبَادِي هَٰٓؤُلَآءِ' }]);
check('the same words answering his question (he stopped reciting): played', r.teacher.length === 1 && !r.muted.length, r);
r = run([{ heard: [w.slice(8, 11).join(' ') + ' '], said: 'أحسنت، بارك الله فيك.' }]);
check('an ordinary remark after recitation: played', r.teacher.length === 1 && !r.muted.length, r);
r = run([{ heard: ['فيقول ااتم اضلل '], said: 'سبحان الله' }], { praying: true });
check('in salat «سبحان الله» on a slip: the recorded word', r.teacher.join() === 'سبحان الله' && r.played.join() === 'word:subhan', r);
r = run([{ heard: ['فيقول ااتم اضلل '], said: 'سبحان الله' }, { said: 'سبحان الله' }], { praying: true });
check('in salat «سبحان الله» again on nothing: muted', r.teacher.length === 1 && r.muted.join() === 'nothing heard', r);
r = run([{ heard: ['فيقول ااتم اضلل '], said: 'تقبّل الله.' }], { praying: true });
check('in salat another remark: muted (not a fath)', r.muted.join() === 'not a fath', r);
r = run([{ heard: [w.slice(8, 11).join(' ') + ' ', 'ضلوا '], said: 'أعِد.' }], { word: false });
check('the word not loaded yet: the model audio plays', r.teacher.length === 1 && r.played.join() === 'audio,audio', r);
r = run([{ heard: ['ماذا اعيد؟ '], said: 'أعِد.' }]);
check('«أعد» answering «ماذا أعيد؟»: muted (talk)', r.muted.join() === 'talk', r);
r = run([{ heard: ['هل اخطات '], said: 'أعِد.' }]);
check('«أعد» answering «هل أخطأت»: muted (talk)', r.muted.join() === 'talk', r);
r = run([{ heard: [w.slice(8, 10).join(' ') + ' لا ' + w.slice(10, 12).join(' ') + ' '], said: 'أعِد.' }]);
check('a stretch at his place with «لا» inside: not talk, «أعد» played', r.teacher.length === 1 && !r.muted.length, r);
console.log(fails ? `${fails} failing` : 'all ok');
process.exit(fails ? 1 : 0);
