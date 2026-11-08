// His line is written from the mushaf, word by word, as the tracker follows him (user 2026-11-06): the words his stretch
// reached, each followed or not (a doubt), the ayah number after its last word; talk stays as transcribed; a stretch of
// recitation nothing of which was followed is written as heard, all in doubt. The verdict per stretch colours the orb:
// right / doubt / talk, and redo when the «أعد» plays. Drives RecitationSession.handle() like test/feedback_guard.ts.
// Build: client/node_modules/.bin/esbuild test/you_words.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/you.mjs
// Run:   node /tmp/hw/you.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession, type YouWord } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const ayah = (s: number, a: number) => quran.find((x) => x.s === s && x.a === a);
const words = (s: number, a: number) => n(ayah(s, a).c).split(' ').filter(Boolean);

function session(s0: number, a0: number, fed: number) {
  const you: { text: string; done: boolean; m?: string; words?: YouWord[] }[] = [], verdicts: string[] = [], events: string[] = [], played: string[] = [];
  const ev: any = new Proxy({}, {
    get: (_t, k) =>
      k === 'onYou' ? (text: string, done: boolean, m?: string, w?: YouWord[]) => you.push({ text, done, m, words: w })
      : k === 'onVerdict' ? (v: string) => verdicts.push(v)
      : k === 'onEvent' ? (e: string) => events.push(e)
      : () => {},
  });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran, surahs: [], diffs: {} } } as any, ev);
  s.ws = { readyState: 1, send: () => {} };
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
  t.setRange(rangeFrom(quran, s0, a0));
  s.tracker = t;
  t.feed(words(s0, a0).slice(0, fed).join(' ') + ' ');
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
  return { s, t, you, verdicts, events, played, hear, reply };
}

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};
const line = (ws?: YouWord[]) => ws?.map((w) => (w.ok ? w.t : `[${w.t}]`)).join(' ');

// 25:17 «ويوم يحشرهم وما يعبدون من دون الله فيقول ءأنتم أضللتم عبادي هؤلاء أم هم ضلوا السبيل» — 8 words fed, he goes on.
{
  const w = words(25, 17);
  const { you, verdicts, hear } = session(25, 17, 8);
  hear(w.slice(8, 11).join(' ') + ' ', w.slice(11, 14).join(' ') + ' ');
  const last = you.at(-1)!;
  check('a stretch followed word by word: the mushaf\'s words, all bright, verdict right', last.done && last.words?.length === 6 && last.words.every((x) => x.ok) && verdicts.at(-1) === 'right', { line: line(last.words), verdicts });
  check('the live line carries the words too', you[0].words?.length === 3 && !you[0].done && verdicts[0] === 'right', { live: line(you[0].words) });
}
// A word the transcript lost in the middle: the mushaf's word stays in the line, dim; verdict doubt.
{
  const w = words(25, 17);
  const { you, verdicts, hear } = session(25, 17, 8);
  hear([...w.slice(8, 10), ...w.slice(11, 14)].join(' ') + ' ');
  const last = you.at(-1)!;
  check('one word not followed in the middle: written dim between the others, verdict doubt', last.words?.length === 6 && last.words.filter((x) => !x.ok).length === 1 && !last.words[2].ok && verdicts.at(-1) === 'doubt', { line: line(last.words), verdicts });
}
// The ayah's end: its number follows the last word.
{
  const w = words(25, 17);
  const { you, hear } = session(25, 17, 10);
  hear(w.slice(10).join(' ') + ' ');
  const last = you.at(-1)!;
  check('the ayah number after its last word', last.words?.at(-1)?.t === '١٧' && last.words.at(-1)?.ok, { line: line(last.words) });
}
// Talk: no words, the transcript is his line; verdict talk.
{
  const { you, verdicts, hear } = session(25, 17, 8);
  hear('هل أخطأت يا شيخ ');
  const last = you.at(-1)!;
  check('talk: no words, the transcript stays, verdict talk', last.words === undefined && last.text === 'هل أخطأت يا شيخ' && verdicts.at(-1) === 'talk', { last, verdicts });
}
// Garbled recitation after an on-track stretch: written as heard, all in doubt.
{
  const w = words(25, 17);
  const { you, verdicts, hear } = session(25, 17, 8);
  hear(w.slice(8, 12).join(' ') + ' '); // on track
  hear('ويوم نحشرهم قال ');
  const last = you.at(-1)!;
  check('nothing followed after an on-track stretch: the heard words, all dim, verdict doubt', last.words?.length === 3 && last.words.every((x) => !x.ok) && verdicts.at(-1) === 'doubt', { line: line(last.words), verdicts });
}
// The «أعد»: verdict redo.
{
  const w = words(25, 17);
  const { verdicts, played, hear, reply } = session(25, 17, 8);
  hear(w.slice(8, 11).join(' ') + ' ', 'ضلوا ');
  reply('أعِد.');
  check('the «أعد» played: verdict redo', played.join() === 'aad' && verdicts.at(-1) === 'redo', { verdicts, played });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
