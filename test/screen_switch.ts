// The mushaf mode reached from the app (user 2026-11-07): set_option screen=mushaf|talk by voice, and the buttons
// (setMode). «افتح المصحف» asks the page, not a fath; «افتح» alone still does, and never once on the page; the page is
// Warsh only, so another riwaya is switched first; show_ayah is a card on the conversation and the page on the mushaf.
// Drives RecitationSession.handle() like test/session_review.ts.
// Build: client/node_modules/.bin/esbuild test/screen_switch.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/screen.mjs
// Run:   node /tmp/hw/screen.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const surahs = JSON.parse(readFileSync('client/public/riwayat/warsh/surahs.json', 'utf8'));
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);
let fails = 0;
const check = (label: string, ok: boolean, info: unknown = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${typeof info === 'string' ? info : JSON.stringify(info)}`);
  fails += +!ok;
};

function session(key = 'warsh', mode?: 'mushaf') {
  const events: string[] = [], sent: any[] = [], options: any[] = [], switched: string[] = [], shown: number[] = [], cards: any[] = [];
  const ev: any = new Proxy(
    { onEvent: (e: string) => events.push(e), onShow: (id: number) => shown.push(id), onCard: (c: any) => cards.push(c) },
    { get: (t: any, k) => t[k] ?? (() => {}) },
  );
  const m = { key, quran, surahs, diffs: {}, toHafs: {} };
  const deps: any = {
    mushaf: m,
    mode,
    setOption: (name: string, value: string, save: boolean) => options.push({ name, value, save }),
    switchRiwaya: async (k: string) => (switched.push(k), { ...m, key: k }),
  };
  const s: any = new RecitationSession(deps, ev);
  s.ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  s.ready = true;
  s.reciting = true;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.prefetchFath = () => {};
  s.play = () => {};
  s.playFath = () => {};
  s.connectedAt = Date.now();
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 25, 17), false, {});
  s.tracker = t;
  const hear = (text: string) => {
    s.you = '';
    s.handle({ serverContent: { inputTranscription: { text } } });
  };
  const tool = async (name: string, args: any) => {
    sent.length = 0;
    s.handle({ toolCall: { functionCalls: [{ id: '1', name, args }] } });
    for (let i = 0; i < 100 && !sent.some((m) => m.toolResponse); i++) await new Promise((r) => setTimeout(r, 5));
    return sent.find((m) => m.toolResponse)?.toolResponse.functionResponses[0].response as any;
  };
  const faths = () => events.filter((e) => e.startsWith('fath?')).length;
  return { s, deps, events, sent, options, switched, shown, cards, hear, tool, faths };
}

{
  // by voice, from the conversation
  const { s, deps, events, options, hear, tool, faths, shown, cards } = session();
  hear(words(25, 17).slice(0, 6).join(' ') + ' ');
  hear('افتح المصحف ');
  check('«افتح المصحف» asks no fath', faths() === 0, events.filter((e) => e.startsWith('fath')));
  hear('افتح ');
  check('«افتح» alone still does', faths() === 1, events.filter((e) => e.startsWith('fath')));
  await tool('show_ayah', { surah: 25, ayah: 17 });
  check('show_ayah on the conversation is a card', cards.length === 1 && shown.length === 0, { cards: cards.length, shown });
  let r = await tool('set_option', { name: 'screen', value: 'mushaf' });
  check('set_option screen=mushaf: the page, the note in the answer', deps.mode === 'mushaf' && /صار المصحف على الشاشة/.test(r.result) && /لا تفتح عليه أبداً/.test(r.result), r.result?.slice(0, 60));
  check('…the app told, this session only', options.at(-1)?.name === 'screen' && options.at(-1)?.value === 'mushaf' && options.at(-1)?.save === false, options.at(-1));
  check('…the event', events.some((e) => e === 'screen mushaf (voice)'), events.filter((e) => e.startsWith('screen')));
  check('…a handover due at the next quiet moment (the connection now counts as 450 s old)', Date.now() - s.connectedAt >= 450_000, { age: Date.now() - s.connectedAt });
  hear('افتح ');
  check('on the page «افتح» asks no fath', faths() === 1, events.filter((e) => e.startsWith('fath')));
  await tool('show_ayah', { surah: 25, ayah: 17 });
  check('show_ayah on the page turns to it', shown.length === 1 && cards.length === 1, { cards: cards.length, shown });
  r = await tool('set_option', { name: 'screen', value: 'الكلام' });
  check('set_option screen=talk: back', deps.mode === undefined && /عادت شاشة الكلام/.test(r.result) && /سبحان الله/.test(r.result), r.result?.slice(0, 60));
  check('…the event', events.some((e) => e === 'screen talk (voice)'), events.filter((e) => e.startsWith('screen')));
  r = await tool('set_option', { name: 'screen', value: 'xyz' });
  check('a value that is neither is refused', /mushaf أو talk/.test(r.error ?? ''), r);
}
{
  // another riwaya: the page is Warsh only
  const { deps, switched, tool } = session('hafs');
  const r = await tool('set_option', { name: 'screen', value: 'mushaf' });
  check('from Hafs the riwaya is switched to Warsh first', switched.join() === 'warsh' && deps.mushaf.key === 'warsh' && /ورش/.test(r.result), r.result?.slice(0, 80));
}
{
  // the buttons
  const { s, deps, events, sent } = session();
  s.setMode('mushaf', 'button');
  check('the mushaf button: the teacher is told', deps.mode === 'mushaf' && sent.some((m) => /وضع المصحف/.test(m.realtimeInput?.text ?? '')), sent.length);
  check('…the event', events.filter((e) => e.startsWith('screen')).join() === 'screen mushaf (button)', events.filter((e) => e.startsWith('screen')));
  s.setMode('mushaf', 'button');
  check('the same again changes nothing', events.filter((e) => e.startsWith('screen')).length === 1, events.filter((e) => e.startsWith('screen')));
  s.setMode(undefined, 'button');
  check('and back', deps.mode === undefined && sent.some((m) => /عادت شاشة الكلام/.test(m.realtimeInput?.text ?? '')), events.filter((e) => e.startsWith('screen')));
}
{
  // a session started on the page goes to the conversation
  const { s, deps, events } = session('warsh', 'mushaf');
  s.setMode(undefined, 'button');
  check('started on the page, back to the conversation', deps.mode === undefined && events.includes('screen talk (button)'), events.filter((e) => e.startsWith('screen')));
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
