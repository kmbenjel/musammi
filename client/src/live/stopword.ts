// «حسبك» stops the recorded mushaf (user, 2026-11-01). The teacher's connection cannot hear it: its transcript comes
// only when a turn closes, and the recording must not reach the teacher as recitation. So while a recording plays the
// mic also goes to a connection of its own on the transcription model, in short windows. Measured 2026-11-01 over the
// recitation at echo level: the final transcript of a closed window holds the voice in front and leaves the recitation
// out. But the vocabulary it needs (5 of 10 without) also makes it hear the word in the recitation, about every 2.5 min
// («عليك البلاغ» → «حسبك البلاغ»), so a hit counts only if the mic was louder than the recording: 9 false hits at 1.63× at
// most. With that check, this code on mixed audio: 28 of 30 tries at echo up to half the voice, median 2.6 s, worst 3.7 s
// (the 2 lost at ×1.69 and ×1.20); 0 of 6 with the echo as loud as the voice; no false stop in 8 min of recitation alone.
// What did not work: automatic activity detection (one long utterance); interim text (it follows the recitation and
// hides the word, and says it falsely); closing and reopening at once (the final is lost); a 2 s window (false hits
// more often). The token comes from token.ts.
import type { Ayah } from './reference';

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=';
export const STOP_WORD = 'حسبك';
const BACKLOG_FRAMES = 50; // mic frames (100 ms) kept while it connects: the word may be said at once
const WINDOW_MS = 3000;
const FINAL_WAIT_MS = 800; // the final comes ~0.3 s after a window closes; none comes for a silent one
const OVERLAP_FRAMES = 8; // sent again at the next window: a word cut in two by the end of one is whole in the next
const HEARD_FRAMES = 41; // what a final can hold: the window, the overlap, the wait for it
const BASE_FRAMES = 120; // the recording's level is taken over the 12 s before that...
const MIN_BASE_FRAMES = 15; // ...or nothing tells: at the very start a hit counts (no false one in 36+ first windows)
const LOUDER = 1.7;
const MAX_FAILS = 3; // connections in a row that never came up or dropped at once: the tap still stops the recording
const LIVED_MS = 5000; // a connection that lasted this long was no failure

// «حسبك» alone, vowelled or not, not «حسبكم» nor part of «فحسبك»; the transcript may join words with a dot («حسبك.حسبك.»).
const WORD = new RegExp(`(^|[^ء-ي])${STOP_WORD}(?=[^ء-ي]|$)`);
const bare = (t: string) => t.replace(/[\u064B-\u0652\u0670]/g, '');
export const saysStop = (text: string) => WORD.test(bare(text));

/** How loud a mic frame is, for feed(). */
export function frameLevel(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}

// The word is in the Qur'an (al-Anfal, Warsh 63 and 65), and the vocabulary makes the transcription hear it in its near
// forms too (3:173 «حسبنا الله» stopped its own recording): 11 ayat in 8 surahs.
const NEAR_WORD = /(^| )[وف]?(حسبك|حسبنا|حسبي|حسبه|حسبهم|حسبكم)( |$)/;

/** A recording of these ayat would stop itself, so it does not listen: only the tap stops it. */
export const holdsStopWord = (ayat: Ayah[]) => ayat.some((x) => NEAR_WORD.test(x.c));

export class StopListener {
  private ws: WebSocket | null = null;
  private live = false;
  private closed = false;
  private fails = 0;
  private upAt = 0;
  private open = false; // a window is open
  private backlog: string[] = [];
  private tail: string[] = []; // the last frames sent
  private levels: number[] = []; // of the last frames
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private getToken: () => Promise<{ token: string; model: string }>,
    private heard: () => void,
    private note: (what: string) => void,
  ) {
    this.connect();
  }

  /** One mic frame: PCM 16 kHz in base64, and its level. */
  feed(data: string, level: number) {
    this.levels.push(level);
    if (this.levels.length > HEARD_FRAMES + BASE_FRAMES) this.levels.shift();
    if (this.open) return this.audio(data);
    this.backlog.push(data);
    if (this.backlog.length > BACKLOG_FRAMES) this.backlog.shift();
  }

  close() {
    this.closed = true;
    this.live = this.open = false;
    clearTimeout(this.timer);
    this.backlog = [];
    this.drop();
  }

  private audio(data: string) {
    this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } });
    this.tail.push(data);
    if (this.tail.length > OVERLAP_FRAMES) this.tail.shift();
  }

  private openWindow() {
    this.send({ realtimeInput: { activityStart: {} } });
    const frames = this.backlog;
    this.backlog = [];
    this.open = true;
    frames.forEach((d) => this.audio(d));
    this.timer = setTimeout(() => this.closeWindow(), WINDOW_MS);
  }

  private closeWindow() {
    this.open = false;
    this.backlog = [...this.tail];
    this.send({ realtimeInput: { activityEnd: {} } });
    this.timer = setTimeout(() => this.openWindow(), FINAL_WAIT_MS);
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private drop() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    ws.close();
  }

  /** The loudest of what the final can hold, against the recording's level before it. */
  private overRecording(): number {
    const base = this.levels.slice(0, -HEARD_FRAMES).sort((a, b) => a - b);
    if (base.length < MIN_BASE_FRAMES) return Infinity;
    return Math.max(...this.levels.slice(-HEARD_FRAMES)) / (base[Math.floor(base.length * 0.95)] || 1e-6);
  }

  private async connect() {
    let token: string, model: string;
    try {
      ({ token, model } = await this.getToken());
    } catch (e) {
      return this.lost(String((e as Error)?.message ?? e));
    }
    if (this.closed) return;
    const ws = new WebSocket(WS_URL + encodeURIComponent(token));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.send({ setup: { model } });
    ws.onclose = (e) => {
      this.ws = null;
      this.lost(e.reason || `code ${e.code}`);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
      if (msg.setupComplete !== undefined) {
        this.live = true;
        this.upAt = Date.now();
        this.openWindow();
        return;
      }
      const final = msg.serverContent?.inputTranscription?.text;
      if (final === undefined || this.closed) return;
      if (saysStop(final)) {
        const over = this.overRecording();
        if (over >= LOUDER) return this.heard();
        this.note(`stop word not louder than the recording: «${final}» ×${over.toFixed(2)}`);
      }
      if (this.open) return;
      clearTimeout(this.timer);
      this.openWindow(); // reopened at once, a window's final is lost: only now
    };
  }

  /** A connection ended while the recording plays (Google limits one to 10 minutes): another one, the mic kept meanwhile. */
  private lost(why: string) {
    if (this.closed) return;
    if (this.live && Date.now() - this.upAt >= LIVED_MS) this.fails = 0;
    else if (++this.fails >= MAX_FAILS) {
      this.note('stop word off: ' + why);
      return this.close();
    }
    this.live = this.open = false;
    clearTimeout(this.timer);
    this.connect();
  }
}
