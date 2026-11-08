// His own voice played back when he disputes a correction (user 2026-11-06): the last two minutes heard stay on the
// phone in a ring; the audio a reply was about runs from the first stretch after the reply before, 300 ms early, to the
// last cut; «شغّل ما قلت» (talk, ≤ 6 words) or the play_reciter tool plays it through the speaker, the mic is kept
// from Gemini meanwhile, the orb's tap (stopMushaf) stops it. Drives onMic() with 100 ms frames.
// Build: client/node_modules/.bin/esbuild test/my_voice.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/voice.mjs
// Run:   node /tmp/hw/voice.mjs   (from the repo root; exit 1 on a failure)
import { RecitationSession } from '../client/src/live/session';
(globalThis as any).WebSocket = { OPEN: 1 };

function session() {
  const events: string[] = [], sent: any[] = [], labels: (string | null)[] = [], bufs: Float32Array[] = [];
  let ended: (() => void) | null = null;
  const ev: any = new Proxy({}, {
    get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : k === 'onMushafAudio' ? (l: string | null) => labels.push(l) : () => {}),
  });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran: [], surahs: [], diffs: {} } } as any, ev);
  s.ws = { readyState: 1, bufferedAmount: 0, close() {}, send: (x: string) => sent.push(JSON.parse(x)) };
  s.ready = true;
  s.lastActiveAt = Date.now();
  s.reciting = true;
  s.reopen = () => {};
  s.outCtx = {
    currentTime: 0,
    destination: {},
    createBuffer: (_c: number, len: number) => {
      const data = new Float32Array(len);
      bufs.push(data);
      return { getChannelData: () => data };
    },
    createBufferSource: () => {
      const src: any = { connect: () => ({ connect() {} }), start() {}, stop() { src.onended?.(); } };
      ended = () => src.onended?.();
      return src;
    },
    createGain: () => ({ gain: {}, connect: () => ({ connect() {} }) }),
  };
  const frame = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => amp * Math.sin((2 * Math.PI * 300 * i) / 16000));
  const voice = (amp: number, frames: number) => { for (let i = 0; i < frames; i++) s.onMic(frame(amp)); };
  const pause = (frames: number) => { for (let i = 0; i < frames; i++) s.onMic(frame(0)); s.closing = false; }; // the reopen is stubbed
  const reply = (said: string) => {
    s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    s.handle({ serverContent: { outputTranscription: { text: said } } });
    s.handle({ serverContent: { generationComplete: true } });
  };
  const audioSent = () => sent.filter((m) => m.realtimeInput?.audio).length;
  const tool = async (name: string) => {
    sent.length = 0;
    s.handle({ toolCall: { functionCalls: [{ id: '1', name, args: {} }] } });
    for (let i = 0; i < 50 && !sent.some((m) => m.toolResponse); i++) await new Promise((r) => setTimeout(r, 5));
    return sent.find((m) => m.toolResponse)?.toolResponse.functionResponses[0].response;
  };
  return { s, events, sent, labels, bufs, voice, pause, reply, audioSent, tool, end: () => ended?.() };
}
const rms = (a: Float32Array, from = 0, to = a.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i] ** 2;
  return Math.sqrt(sum / (to - from));
};

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

// 1. The judged window: a silent reply, then two stretches, a cut, the «أعد».
{
  const { s, events, labels, bufs, voice, pause, reply, audioSent, end } = session();
  check('nothing heard yet: nothing judged', s.judgedAudio === null, s.judgedAudio);
  voice(0.1, 10); pause(5); reply(''); // an earlier stretch the model said nothing about: accepted, and the window after it
  // 1.0 s of voice and the cut 300 ms into the pause; no lead-in at the tape's start
  check('a silent generation: that stretch is what it judged (1.3 s)', s.judgedAudio && Math.abs((s.judgedAudio.to - s.judgedAudio.from) / 16000 - 1.3) < 0.05, s.judgedAudio && { s: ((s.judgedAudio.to - s.judgedAudio.from) / 16000).toFixed(2) });
  pause(10);
  voice(0.3, 20); pause(5); // stretch A, 2 s
  voice(0.05, 10); pause(5); // stretch B, 1 s
  reply('أعِد.');
  const j = s.judgedAudio;
  // 0.3 s lead-in, A 2.0 s, its cut 0.3 s in, 0.2 s more of pause, B 1.0 s, its cut 0.3 s in: 4.1 s
  check('«أعد»: the judged audio runs from 300 ms before stretch A to the cut after B', j && Math.abs((j.to - j.from) / 16000 - 4.1) < 0.05 && j.to === s.lastCutPos, j && { s: ((j.to - j.from) / 16000).toFixed(2) });
  const before = audioSent();
  const sec = s.playMyVoice('test');
  check('played: a buffer of the judged length, loud first (A) and quiet last (B), the screen told', sec > 4 && bufs.length === 1 && rms(bufs[0], 16000, 16000 * 2) > 0.15 && rms(bufs[0], bufs[0].length - 16000 * 1.2, bufs[0].length - 16000 * 0.4) < 0.05 && labels.at(-1) === 'ما قلتَ', { sec: sec.toFixed(1), a: rms(bufs[0], 16000, 32000).toFixed(3), b: rms(bufs[0], bufs[0].length - 19200, bufs[0].length - 6400).toFixed(3), labels });
  const pos = s.tapePos;
  voice(0.2, 10);
  check('while it plays the mic reaches neither Gemini nor the tape', audioSent() === before && s.tapePos === pos, { sent: audioSent() - before, taped: s.tapePos - pos });
  end();
  check('ended: the screen cleared', labels.at(-1) === null && s.myVoice === null, labels);
  voice(0.2, 3);
  check('after it the mic goes out again', audioSent() === before + 3, { sent: audioSent() - before });
  check('events', events.some((e) => /^my voice 4\.\ds \(test\)/.test(e)), events.filter((e) => e.startsWith('my voice')));
}
// 2. The voice command and the tool.
await (async () => {
  const { s, sent, labels, voice, pause, reply, tool } = session();
  voice(0.3, 20); pause(5);
  reply('أعِد.');
  s.handle({ serverContent: { inputTranscription: { text: 'شغل ما قلت ' } } });
  check('«شغّل ما قلت»: played, the model told', labels.at(-1) === 'ما قلتَ' && sent.some((m) => /طلب القارئ سماع ما قاله/.test(m.realtimeInput?.text ?? '')), { labels, note: sent.filter((m) => m.realtimeInput?.text).length });
  s.stopMushaf();
  check('the orb\'s tap stops it', labels.at(-1) === null, labels);
  s.finishYou();
  s.handle({ serverContent: { inputTranscription: { text: 'ماذا قلت ' } } });
  check('«ماذا قلت» alone (also «what did you say») does not', labels.at(-1) === null, labels);
  s.finishYou();
  const r = await tool('play_reciter');
  check('play_reciter: played, the model told to keep silent', labels.at(-1) === 'ما قلتَ' && /يُشغَّل الآن/.test(r?.result ?? ''), { r: String(r?.result).slice(0, 30) });
  s.stopMyVoice();
  s.praying = true;
  const r2 = await tool('play_reciter');
  check('in salat: not played', /الصلاة/.test(r2?.result ?? '') && labels.at(-1) === null, r2);
})();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
