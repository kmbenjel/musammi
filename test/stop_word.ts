// «حسبك» while a recording plays: what counts as the word, which recordings do not listen, and that the mic goes to the
// listener only, never to the teacher. The transcription itself is the real model's: only a live probe checks that.
// Build: client/node_modules/.bin/esbuild test/stop_word.ts --bundle --platform=node --format=esm --external:@google/genai --outfile=/tmp/hw/stop.mjs
// Run:   node /tmp/hw/stop.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { recitationSpan } from '../client/src/live/audio';
import { holdsStopWord, saysStop, StopListener } from '../client/src/live/stopword';

let fails = 0;
const check = (label: string, ok: boolean, info: unknown = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

for (const t of ['حسبك', 'حسبك.', 'حسبُكَ', 'ايكم احسن عملا حسبك. الذي خلق', 'حسبك.حسبك.', 'يا شيخ حسبك'])
  check(`the word: ${t}`, saysStop(t));
for (const t of ['حسبنا الله', 'حسبي الله', 'فحسبه جهنم', 'حسبكم', 'وحسبك', 'حسب', 'ايكم احسن عملا'])
  check(`not the word: ${t}`, !saysStop(t));

const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const hafs: any[] = JSON.parse(readFileSync('client/public/riwayat/hafs/quran.json', 'utf8'));
const whole = (q: any[]) => q.filter((x) => holdsStopWord([x])).map((x) => `${x.s}:${x.a}`).join(' ');
check('11 ayat of the Warsh mushaf do not listen', whole(quran) === '2:204 3:173 5:106 8:63 8:65 9:59 9:68 9:130 39:36 58:8 65:3', whole(quran));
check('nor their like in the Hafs mushaf', whole(hafs).split(' ').length === 11 && whole(hafs).includes('8:62 8:64'), whole(hafs));

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  sent: any[] = [];
  onopen: any; onmessage: any; onerror: any; onclose: any;
  binaryType = '';
  constructor(public url: string) { FakeSocket.last = this; }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  say(m: unknown) { this.onmessage({ data: JSON.stringify(m) }); }
}
(globalThis as any).WebSocket = FakeSocket;
const tick = () => new Promise((r) => setTimeout(r, 0));

{
  let heard = 0;
  const notes: string[] = [];
  const l = new StopListener(async () => ({ token: 't', model: 'm' }), () => heard++, (w) => notes.push(w));
  for (let i = 0; i < 80; i++) l.feed('f' + i, 0.05); // said before the connection is up
  await tick();
  const ws = FakeSocket.last;
  ws.onopen();
  ws.say({ setupComplete: {} });
  const audio = ws.sent.filter((x) => x.realtimeInput?.audio).map((x) => x.realtimeInput.audio.data);
  check('the activity opens first', !!ws.sent[1]?.realtimeInput?.activityStart, ws.sent[1]);
  check('the last 5 s reach it once up', audio.length === 50 && audio[49] === 'f79', audio.length);
  ws.say({ serverContent: { interimInputTranscription: { text: 'ايكم احسن عملا حسبك.' } } });
  check('interim text is not listened to (it says the word falsely)', heard === 0);
  await new Promise((r) => setTimeout(r, 3050));
  check('the window closes', ws.sent.at(-1)?.realtimeInput?.activityEnd !== undefined, ws.sent.at(-1));
  l.feed('during the gap', 0.05);
  const kept = (l as any).backlog as string[];
  check('its end is kept for the next one, and what comes meanwhile', kept.length === 9 && kept[0] === 'f72' && kept[8] === 'during the gap', kept.length);
  ws.say({ serverContent: { inputTranscription: { text: 'ايكم احسن عملا' } } });
  check('a final without the word opens the next window', !!ws.sent.at(-10)?.realtimeInput?.activityStart && heard === 0, ws.sent.length);
  check('with the kept audio', ws.sent.at(-1)?.realtimeInput?.audio?.data === 'during the gap');
  ws.say({ serverContent: { inputTranscription: { text: 'حسبك' } } });
  check('the word no louder than the recording: not heard (it hears it in the recitation)', heard === 0);
  check('and the session is told', notes.length === 1 && notes[0].includes('×'), notes);
  l.feed('the word', 0.05 * 1.8);
  ws.say({ serverContent: { inputTranscription: { text: 'حسبك.' } } });
  check('a final with the word is heard', heard === 1);
  ws.onclose({ code: 1011, reason: '' });
  await tick();
  check('a connection that ends while it plays is replaced', FakeSocket.last !== ws);
  const before = FakeSocket.last;
  l.close();
  check('closed: its socket is closed', before.readyState === 3);
  await tick();
  check('closed: no other connection', FakeSocket.last === before);
}
{
  let heard = 0;
  const l = new StopListener(async () => ({ token: 't', model: 'm' }), () => heard++, () => {});
  for (let i = 0; i < 20; i++) l.feed('x', 0.05); // the first seconds: the recording has no level yet
  await tick();
  FakeSocket.last.onopen();
  FakeSocket.last.say({ setupComplete: {} });
  FakeSocket.last.say({ serverContent: { inputTranscription: { text: 'حسبك' } } });
  check('at the very start a hit counts', heard === 1);
  l.close();
}
{
  const notes: string[] = [];
  let tries = 0;
  new StopListener(async () => { tries++; throw new Error('quota'); }, () => {}, (w) => notes.push(w));
  for (let i = 0; i < 10; i++) await tick();
  check('no token: gives up after 3 tries, and says so', tries === 3 && notes.length === 1, { tries, notes });
}
{
  const sent: any[] = [], fed: string[] = [];
  const ev: any = new Proxy({}, { get: () => () => {} });
  const s: any = new RecitationSession({} as any, ev);
  s.ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  s.ready = true;
  s.lastActiveAt = Date.now();
  s.mushafAudio = { pause() {}, removeAttribute() {} };
  s.stopListener = { feed: (d: string) => fed.push(d), close() {} };
  s.onMic(new Float32Array(1600));
  check('while it plays the mic goes to the listener', fed.length === 1);
  check('and not to the teacher', !sent.some((x) => x.realtimeInput?.audio), sent);
  s.stoppedByWord();
  check('the word stops the recording', s.mushafAudio === null && s.stopListener === null);
}

{
  const notes: string[] = [];
  let tries = 0;
  new StopListener(async () => { tries++; return { token: 't', model: 'm' }; }, () => {}, (w) => notes.push(w));
  for (let i = 0; i < 6; i++) {
    await tick();
    const ws = FakeSocket.last;
    if (notes.length) break;
    ws.onopen();
    ws.say({ setupComplete: {} });
    ws.onclose({ code: 1011, reason: 'gone' });
  }
  check('up and dropped at once, again and again: gives up too', tries === 3 && notes.length === 1, { tries, notes });
}

const m: any = { key: 'warsh', quran, diffs: {}, surahs: [{ no: 8, name_ar: 'الانفال', ayah_count: 75 }] };
globalThis.fetch = (async () => ({ json: async () => Array.from({ length: 75 }, (_, i) => ({ ayah: i + 1, start_time: i * 1000, end_time: (i + 1) * 1000 })) })) as any;
const run = async (args: any) => { const r: any = await recitationSpan(m, args, 8); return holdsStopWord(r.ayat); };
check('a recording of 8:60–62 listens', !(await run({ surah: 8, from_ayah: 60, to_ayah: 62 })));
check('a recording of 8:63 does not', await run({ surah: 8, from_ayah: 63 }));
check('a recording over 8:65 does not', await run({ surah: 8, from_ayah: 64, to_ayah: 66 }));
const silent = await recitationSpan(m, { surah: 8, from_ayah: 1, reciter: 'عبد الباسط' }, 8);
check('a whole surah without timings counts all its ayat', 'ayat' in silent && holdsStopWord(silent.ayat));

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
