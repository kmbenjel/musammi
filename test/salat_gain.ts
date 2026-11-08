// The mic path of 2026-11-06 (study of 11-03, HANDOFF «Open»): in salat the stream to Gemini is raised to −20 dBFS
// (at most ×8, never clipping; the quiet Fajr of 11-04 06:08 was heard in 5 of 6 replays only at ×8), a socket that
// stays stalled 15 s is reconnected instead of waiting for Google's 1006, and four stretches sent with no word back
// turn the link «unheard». Drives RecitationSession.onMic() with 100 ms frames.
// Build: client/node_modules/.bin/esbuild test/salat_gain.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/gain.mjs
// Run:   node /tmp/hw/gain.mjs   (from the repo root; exit 1 on a failure)
import { RecitationSession } from '../client/src/live/session';
(globalThis as any).WebSocket = { OPEN: 1 };
(globalThis as any).document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

function session() {
  const events: string[] = [], links: string[] = [], sent: Int16Array[] = [], reconnects: string[] = [];
  const ev: any = new Proxy({}, {
    get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : k === 'onLink' ? (l: string) => links.push(l) : () => {}),
  });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran: [], surahs: [], diffs: {} } } as any, ev);
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    close() {},
    send: (x: string) => {
      const m = JSON.parse(x);
      const b64 = m.realtimeInput?.audio?.data;
      if (b64) {
        const bytes = Buffer.from(b64, 'base64');
        sent.push(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2));
      }
    },
  };
  s.ws = ws;
  s.ready = true;
  s.lastActiveAt = Date.now(); // start() sets it; without it the idle clock ends the session on the first frame
  s.reciting = true; // recitation pauses (300 ms), not talk pauses (1.3 s)
  s.outCtx = { currentTime: 0 };
  s.reopen = () => {};
  s.reconnect = (why: string) => reconnects.push(why);
  return { s, ws, events, links, sent, reconnects };
}

const rms = (a: ArrayLike<number>, scale = 1) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] / scale) ** 2;
  return Math.sqrt(sum / a.length);
};
const peak = (a: ArrayLike<number>, scale = 1) => {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i] / scale));
  return p;
};
/** A 100 ms frame: a 200 Hz tone at this amplitude (voice), or silence. */
const frame = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => amp * Math.sin((2 * Math.PI * 200 * i) / 16000));

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

// 1. Outside salat nothing changes.
{
  const { s, sent } = session();
  for (let i = 0; i < 10; i++) s.onMic(frame(0.02));
  const r = rms(sent.at(-1)!, 32767);
  check('outside salat the frame goes out as heard', Math.abs(r - 0.02 / Math.SQRT2) < 0.001, { rms: r.toFixed(4) });
}
// 2. In salat a quiet voice (RMS 0.014, the 11-04 Fajr) is raised towards −20 dBFS, capped at ×8; a loud frame never clips.
{
  const { s, sent, events } = session();
  s.praying = true;
  for (let i = 0; i < 40; i++) s.onMic(frame(0.02));
  const r = rms(sent.at(-1)!, 32767);
  check('salat: a quiet voice goes out about ×7 (0.014 → 0.1)', r > 0.08 && r <= 0.115, { rms: r.toFixed(3) });
  s.onMic(frame(0.5)); // the takbir
  const p = peak(sent.at(-1)!, 32767);
  check('salat: a loud frame is limited, not clipped', p <= 0.951 && p > 0.9, { peak: p.toFixed(3) });
  for (let i = 0; i < 300; i++) s.onMic(frame(0.02));
  check('the mic event names the gain', events.some((e) => /^mic max=.* gain=×\d/.test(e)), events.filter((e) => e.startsWith('mic max')).slice(-1));
  s.praying = false;
  s.closing = false; // a constant tone ends up under the adaptive floor: the turn was cut (the reopen is stubbed)
  const n0 = sent.length;
  s.onMic(frame(0.02));
  const after = rms(sent.at(-1)!, 32767);
  check('after the taslim the gain is gone', sent.length === n0 + 1 && Math.abs(after - 0.02 / Math.SQRT2) < 0.001, { rms: after.toFixed(4), sent: sent.length - n0 });
}
// 3. A loud voice in salat is left alone (gain 1), so a normal recording is not blown up.
{
  const { s, sent } = session();
  s.praying = true;
  for (let i = 0; i < 40; i++) s.onMic(frame(0.3));
  const r = rms(sent.at(-1)!, 32767);
  check('salat: a loud voice is not raised', Math.abs(r - 0.3 / Math.SQRT2) < 0.002, { rms: r.toFixed(3) });
}
// 4. A socket whose queue stays over 90 KB for 15 s is reconnected once; a short stall is only reported.
{
  const { s, ws, events, reconnects } = session();
  ws.bufferedAmount = 200_000;
  for (let i = 0; i < 100; i++) s.onMic(frame(0.1)); // 10 s
  check('a 10 s stall: reported, not reconnected', events.some((e) => e.startsWith('link stalled')) && reconnects.length === 0, { reconnects, link: events.filter((e) => e.startsWith('link')) });
  for (let i = 0; i < 60; i++) s.onMic(frame(0.1)); // 16 s
  check('a 15 s stall: reconnected once, the dead socket dropped', reconnects.length === 1 && /stalled 15s/.test(reconnects[0]) && s.ws === null, { reconnects });
}
// 5. Four stretches cut and sent with no word back: the link is «unheard»; a word back clears it.
{
  const { s, links, events } = session();
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 6; i++) s.onMic(frame(0.1)); // 600 ms of voice
    for (let i = 0; i < 4; i++) s.onMic(frame(0)); // 400 ms pause → cut
    s.closing = false; // the reopen (stubbed) would open the next stretch
  }
  check('four unheard cuts: link unheard, with an event', links.at(-1) === 'unheard' && events.some((e) => e.startsWith('unheard: 4 cuts')), { links, ev: events.filter((e) => e.startsWith('unheard')) });
  s.handle({ serverContent: { inputTranscription: { text: 'الحمد لله ' } } });
  for (let i = 0; i < 3; i++) s.onMic(frame(0.1));
  check('a word back: the link is sending again', links.at(-1) === 'sending', { links });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
