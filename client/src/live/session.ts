// The whole live session: mic → Gemini Live → speaker, like the Gemini Live app, tuned for recitation.
//
// Turn-taking (verified against gemini-3.8-live in test/live_check.ts):
// - Automatic VAD drops melodic recitation, so turns are driven manually at the reciter's pauses.
// - After activityEnd the next activityStart must wait until the model has answered
//   (generationComplete), or ~1.5 s of no output (it chose silence); a start sent earlier is either
//   dropped or cancels the answer. Audio recorded meanwhile is held and flushed after the start.
// - After a tool call (open_mushaf, exam_question) the spoken answer («تفضّل») comes in a later
//   generation, so the stretch stays closed until a generation with audio completes (or 8 s).
// - A stretch ends at a short pause while reciting and at a longer one while talking, so talking is not
//   cut mid-sentence. The transcript only arrives when a stretch closes, so the mode comes from the last
//   stretch (did it follow the mushaf?), and open_mushaf switches to reciting right away.
// - A dropped connection resumes with the last handle (or a new context if the server refuses it). Nothing says
//   whether the model's context survived, so the new turn carries a note of where we are (salat, exam, place).
// - Google closes a connection at ~600 s without a goAway (sessions 2026-10-28 11:08, 12:53), so after 7.5 min the
//   session hands over at a quiet moment: the model has answered, the mic is held as between stretches, the old
//   connection is closed and a new one resumes with the handle. Verified live 2026-10-29: the handle names the
//   whole session (3.8-live sends one, at setup, and never another) and resuming it restores the latest context;
//   a second connection is refused while the first is open («session is already connected to an existing client»).

import { PauseSegmenter } from './pauses';
import { formatReference, MushafLocator, PositionTracker, rangeFrom, readsLike, type Ayah, type HafsDiffs, type SurahInfo } from './reference';
import { normalizeTranscript } from '../utils/arabic';
import { libraryNote, riwayaBrief } from './prompt';
import { ayahSpan } from './audio';
import { riwayaOf, type RiwayaKey } from './riwayat';

/** The mushaf of one riwaya, as the session needs it. */
export interface MushafData {
  key: RiwayaKey;
  quran: Ayah[];
  surahs: SurahInfo[];
  diffs: HafsDiffs;
  toHafs: Record<string, number>;
}

export type SessionState = 'connecting' | 'listening' | 'reconnecting' | 'closed';

export interface ShownCard {
  title: string;
  text: string; // Warsh text
}

export interface SessionEvents {
  onState: (s: SessionState, detail?: string) => void;
  onYou: (text: string, done: boolean) => void; // live transcript of the current stretch
  onTeacher: (text: string) => void; // what the teacher said (one turn)
  onSpeaking: (on: boolean) => void;
  onLevel: (level: number) => void;
  onPosition: (label: string) => void;
  onCard: (card: ShownCard) => void;
  onReciting: (where: { s: number; a: number }) => void;
  onPrayer: (on: boolean) => void;
  onMushafAudio: (label: string | null) => void; // the recorded mushaf is playing (tap stops it)
  onEvent: (what: string) => void; // kept with the saved session, to see later why a session stopped
}

export interface SessionDeps {
  getToken: (resumeHandle: string | null, riwaya: RiwayaKey) => Promise<{ token: string; model: string }>;
  mushaf: MushafData;
  switchRiwaya: (key: RiwayaKey) => Promise<MushafData>; // loads it and updates the screen
  fromHafs: (surah: number, ayah: number) => Promise<{ s: number; a: number } | null>; // Kufi number → this riwaya
  pastSessions: () => string;
  tafsir: (hafsId: number, book?: string) => Promise<Record<string, unknown>>;
  library: (book: string, query: string) => Promise<Record<string, unknown>>;
  nextExamQuestion: (opts: { surah?: number; juz?: number }) => Promise<{ n: number; title: string; cue: string; question: string; expected: string; ayat: { s: number; a: number }[] }>;
  resume?: Place & { ago: number }; // the last session stopped here a few minutes ago (ago: minutes)
}

/** Where the reciter is: the ayah, and how many of its words he has recited. */
export interface Place {
  riwaya: RiwayaKey;
  s: number;
  a: number;
  w: number;
}

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.';
const ARABIC = /[ء-ي]/;
const QUOTA = /quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded/i;
const QUOTA_MSG = 'انتهت الحصة المجانية من Gemini لهذا اليوم. تتجدّد غداً إن شاء الله.';
const IDLE_MS = 3 * 60 * 1000; // no recitation and no reply from the teacher for this long → end (saves the quota)
const PRAYER_IDLE_MS = 20 * 60 * 1000; // sujud, tashahhud and du'a are long silences
const LAPSE_MS = 3500; // in salat: silence inside an ayah this long → the fath
const LAPSE_OUT_MS = 5000; // outside salat the reciter may be thinking: a little longer
const FATH_ASKED = /(^| )(ا?فتح|تفتح|ما بعدها|ما بعده)( |$)/; // «افتح» / «افتح عليّ» / «ما بعدها؟»
const IDLE_MSG = 'انتهت الجلسة تلقائياً بعد 3 دقائق دون تلاوة أو حوار، توفيراً للحصة.';
// Takbir starts the salat and taslim ends it: the reciter does not have to announce the prayer.
const TAKBIR = /الله ?اكبر/;
const TASLIM = /السلام عليكم/;
const plain = (t: string) =>
  t.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
const QUICK_TOOLS = new Set(['open_mushaf', 'show_ayah', 'set_riwaya', 'prayer_mode', 'play_recitation']);
// Reconnecting: nothing may hang the session or loop for ever.
const CONNECT_MS = 15000; // one attempt (token, socket, setup) gets this long
const RECONNECT_MS = 60000; // after a drop, keep trying this long (a phone switching networks)
const DROPS_WINDOW_MS = 2 * 60 * 1000;
const MAX_DROPS = 4; // more drops than this within the window: the service is failing, end instead of looping
// Handover before Google's ~600 s cut. localStorage hifz_handover_s shortens it for tests.
const HANDOVER_MS = (() => {
  try {
    const s = Number(globalThis.localStorage?.getItem('hifz_handover_s'));
    if (s > 0) return s * 1000;
  } catch {}
  return 450 * 1000;
})();
// Quiet = the model finished a generation since the last cut. Closing the connection 1.5 s after a cut with no
// answer yet loses the judgment of that stretch (live 2026-10-29: a skipped passage got no «أعد»). Many stretches
// end with no generation at all, so later any reopen will do, and later still a handover mid-turn.
const HANDOVER_ANY_MS = HANDOVER_MS + 60000;
const HANDOVER_FORCE_MS = HANDOVER_MS + 90000;
const HANDOVER_TRY_MS = 5000; // one handover attempt (the mic is held meanwhile; it usually takes ~1 s)
const HANDOVER_BUDGET_MS = 8000; // then the ordinary reconnect takes over
const STILL_CONNECTED = /already connected/i; // the old connection is not yet released on Google's side
const RESUME_GONE = /handle|resum|expired|not.?found|invalid/i; // a setup refused for its resumption handle
// Mic frames (100 ms) held while the turn is closed: the whole reconnect (budget + one attempt), so that no
// recitation is lost — a gap would look like skipped ayat to the tracker (a false «أعد»).
const HELD_FRAMES = (RECONNECT_MS + CONNECT_MS) / 100;
const VOICE_GAIN = 0.8;
const SOFT_GAIN = 0.45; // «أعِد»، «أحسنت»: a quiet word over the recitation

// The model sometimes "says" placeholders instead of staying silent: <no speech>, {pause}, <!-- … -->, ___
// Said over the teacher's answer without asking it to stop.
const BACKCHANNEL = new Set(['طيب', 'نعم', 'اي', 'ايوه', 'اه', 'ها', 'جميل', 'صحيح']);

export function cleanSpoken(text: string): string {
  const t = text
    .replace(/<!--[\s\S]*?-->|<[^>]*>|\{[^}]*\}/g, ' ')
    .replace(/[_\-—–​]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ARABIC.test(t) ? t : '';
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === 1600) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`;

/** A socket the session no longer listens to (an abandoned attempt, a replaced connection). */
function detach(ws: WebSocket) {
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  ws.close();
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class RecitationSession {
  private ws: WebSocket | null = null;
  private resumeHandle: string | null = null;
  private stopped = false;
  private ready = false;

  private micCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private playing: AudioBufferSourceNode[] = [];
  private playEnd = 0;
  // The teacher's voice comes back through the phone's echo canceller (up to 0.07 RMS with nobody speaking, against
  // a 0.012 voice threshold): counted as the reciter, it stopped long answers and made the model answer its own echo.
  // The transcription never turned that echo into words, so while a long answer plays only transcribed words of the
  // reciter stop it (sessions 2026-10-28 11:19, 11:23).
  private spoken: { text: string; t0: number } | null = null; // the answer playing: how much of it was heard
  private noteOnReopen = '';
  private wakeLock: { release: () => Promise<void> } | null = null;

  private seg = new PauseSegmenter();
  private tracker = new PositionTracker();
  private lastRecitedAt = 0; // last time the live transcript matched the mushaf text
  private reciting = false; // the last stretch followed the mushaf (or a place was just opened)
  private lastActiveAt = 0; // recitation or a spoken reply; silence and background voices do not count
  private praying = false;
  private locator: MushafLocator | null = null;
  private unplaced: string[] = []; // the last recited words (in salat), to find the place in the whole mushaf
  // An exam question is open: the tracker follows its expected ayat; a recitation from elsewhere is located and told.
  private exam: { ayat: Ayah[]; near: Set<number>; told: Set<number>; asked?: string } | null = null;
  private reconnecting = false;
  private connectSeq = 0; // each connection attempt: one cancelled meanwhile must not touch the session
  private connEpoch = 0; // each lost connection: a tool still running then belongs to the old one
  private connectedAt = 0; // when the current connection's setup completed
  private switching = false; // a handover is under way
  private answered = false; // the model finished a generation since the last cut
  private drops: number[] = []; // when the connection dropped lately
  private refath = false; // a fath was asked and not yet heard when the connection dropped
  private silentAtDrop = 0;
  private droppedAt = 0;
  private afterDrop: string[] = []; // notes for the next connection (a tool that answered while reconnecting)
  private lapseSent = false; // one nudge per stop
  // A fath was asked for: the generation that closes the empty activity comes first and says nothing; reopening
  // then (the reciter is often already repeating) cancels the fath itself, so the turn waits for it.
  private fathPending = false;
  private stretchMark: { reached: number; matched: number; seen: number; exact: number } | null = null; // the tracker when the stretch closed
  private lastTeacherAt = 0;
  private closing = false;
  private held: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private hardTimer: ReturnType<typeof setTimeout> | undefined;
  private voicedRunMs = 0;
  private afterTool = false; // a tool call's answer («تفضّل») comes in a later generation
  // How long the recitation is held for that answer. Opening the mushaf is often silent (the reciter already
  // started), and holding the recitation makes every remark late; a lookup answer needs time to think.
  private toolWaitMs = 8000;
  private toolPending = false; // a tool is running: the turn must stay closed
  private genHadAudio = false;
  private turnGain: GainNode | null = null;
  private onVisible = () => this.visibilityChanged();

  private you = '';
  private teacher = '';
  private voiced = false; // this turn has real Arabic words (not a silent <no speech> clip)
  private pending: string[] = []; // audio held until we know the turn is voiced
  private micMax = 0; // loudest frame in the last 30 s, and frames counted (diagnostics: is the mic alive?)
  private micFrames = 0;
  private heard = 0; // transcript characters of the current stretch (diagnostics)
  private muted = false; // in salat: this turn is not a fath (a stray remark), so it is not played
  private current: { s: number; a: number } | null = null;
  // A quick restart goes on from the ayah the last session stopped in: until he moves on from it, opening a similar
  // ayah elsewhere that he did not announce is a slip into a mutashabih (session 12:55: Yunus 75 for al-Muʾminun 45).
  private anchor: Ayah | null = null;

  constructor(private deps: SessionDeps, private ev: SessionEvents) {}

  /** Call from a user gesture (tap): audio contexts must be created/resumed inside it. */
  async start() {
    this.stopped = false;
    this.lastActiveAt = Date.now();
    this.ev.onState('connecting');
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    this.micCtx = new AudioContext({ sampleRate: 16000 });
    // Without a user gesture (auto-start) the browser may keep audio suspended: give up rather than hang.
    await Promise.race([Promise.all([this.outCtx.resume(), this.micCtx.resume()]), new Promise((r) => setTimeout(r, 1500))]);
    if (this.outCtx.state !== 'running') throw new Error('اضغط الدائرة للبدء');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(this.micCtx, 'tap');
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onMic(e.data);
    this.micCtx.createMediaStreamSource(this.stream).connect(tap);
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.ev.onEvent('mic-ended'));
    document.addEventListener('visibilitychange', this.onVisible);
    await this.keepScreenOn();
    this.resume();
    await this.connect();
  }

  /** Where the reciter is now (kept by the app, so that a quick restart goes on from there); none in an exam. */
  place(): Place | null {
    const at = this.exam ? undefined : this.tracker.position();
    return at ? { riwaya: this.deps.mushaf.key, s: at.ayah.s, a: at.ayah.a, w: at.word } : null;
  }

  /** The last session stopped a few minutes ago: the tracker and the teacher start where it stopped. */
  private resume() {
    const r = this.deps.resume;
    const m = this.deps.mushaf;
    const i = r && r.riwaya === m.key ? m.quran.findIndex((x) => x.s === r.s && x.a === r.a) : -1;
    if (!r || i < 0) return;
    const at = m.quran[i];
    const prev = m.quran[i - 1]?.s === at.s ? m.quran[i - 1] : at; // he may start again a little before
    this.tracker.setRange(rangeFrom(m.quran, prev.s, prev.a), false, m.diffs);
    // the tracker looks 8 words back: restarting the ayah from its beginning must still be followed
    this.tracker.startAt(at, r.w <= 8 ? r.w : r.w - 8);
    this.anchor = at;
    readsLike(m.quran, at, at); // counts the mushaf's words now (~0.1 s), not inside a later open_mushaf
    this.current = { s: at.s, a: at.a };
    const name = m.surahs.find((x) => x.no === at.s)?.name_ar ?? '';
    const short = riwayaOf(m.key).short;
    this.ev.onPosition(`سورة ${name} · من الآية ${at.a}`);
    this.ev.onReciting(this.current);
    this.ev.onEvent(`resumed ${at.s}:${at.a} w${r.w} (${r.ago} min after)`);
    const said = r.w > 0 ? `، في وسطها، والكلمات التالية: «${this.tracker.nextPhrase()}»` : '';
    const ago = r.ago < 1 ? 'بعد أقل من دقيقة' : r.ago === 1 ? 'بعد دقيقة' : r.ago === 2 ? 'بعد دقيقتين' : `بعد ${r.ago} دقائق`;
    const ref = formatReference(this.tracker.ayat.slice(0, 22), m.surahs, m.diffs, short);
    // sent in the first turn (reopen), like the note after a reconnect
    this.noteOnReopen =
      `(ملاحظة آلية من التطبيق: هذه جلسة جديدة ${ago} من السابقة، وقد وقف في السابقة في سورة ${name}، الآية ${at.a} بعدّ ${short}${said}. ` +
      `فهو يكمل من هناك: إن قرأ ما يشبه هذه الآية من موضع آخر (متشابه) فهي زلة، فقل «أعِد» ولا تنقله إلى ذلك الموضع. ` +
      `وإن بدأ بداية جديدة واضحة (أول سورة أخرى، أو قال «سأقرأ…») فاتبعه واستدعِ open_mushaf. لا تقل شيئاً بسبب هذه الملاحظة. هذا نصّه المرجعي فاحكم به:\n${ref})`;
  }

  /** open_mushaf to a place that reads like the ayah he stopped in, before he moved on from it, neither announced
   *  nor the opening of a surah: a slip into a mutashabih, not a new place. */
  private slipFromAnchor(target: Ayah, announced: boolean): boolean {
    const anchor = this.anchor;
    if (!anchor) return false;
    const cur = this.tracker.current();
    if (!cur || Math.abs(cur.id - anchor.id) > 3) {
      this.anchor = null; // he went on: the usual rules again
      return false;
    }
    if (announced || target.a === 1 || Math.abs(target.id - anchor.id) <= 3) return false;
    return readsLike(this.deps.mushaf.quran, anchor, target);
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.idleTimer);
    clearTimeout(this.hardTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000);
    }
    this.ws = null;
    this.stopPlayback();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close();
    this.outCtx?.close();
    this.micCtx = this.outCtx = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stopMushaf();
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.ev.onState('closed');
  }

  // The screen must stay on: with it off, Android stops the mic and the socket. The browser drops the
  // lock whenever the page is hidden, so it is taken again when the page comes back.
  private async keepScreenOn() {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request('screen');
      if (!this.wakeLock) this.ev.onEvent('no-wakelock');
    } catch (e) {
      this.ev.onEvent('wakelock-refused: ' + String(e));
    }
  }

  private visibilityChanged() {
    if (this.stopped) return;
    this.ev.onEvent(document.visibilityState);
    if (document.visibilityState !== 'visible') return;
    this.keepScreenOn();
    this.outCtx?.resume().catch(() => {});
    this.micCtx?.resume().catch(() => {});
    if (this.ws?.readyState !== WebSocket.OPEN && !this.ready) this.reconnect('page shown again');
  }

  private setPraying(on: boolean, note?: string) {
    if (this.praying === on) return;
    this.praying = on;
    this.ev.onPrayer(on);
    this.ev.onEvent(on ? 'prayer-on' : 'prayer-off');
    if (note) this.send({ realtimeInput: { text: note } });
  }

  // ── connection ─────────────────────────────────────────────────────────
  /** One connection attempt: resolves once the setup is complete (or the session was stopped meanwhile). A failure
   *  has `refused` set when the token came (so the network works) but the Live service gave no setup — e.g. it
   *  no longer knows the resumption handle baked into the token. */
  private async connect(handover = false): Promise<void> {
    const seq = ++this.connectSeq;
    let ws: WebSocket | null = null;
    let up = false;
    let gotToken = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A half-dead network must not hang the session: no setup within CONNECT_MS (token, socket or setup) → failed.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('تعذّر الاتصال بخدمة Gemini Live (لا جواب)')), handover ? HANDOVER_TRY_MS : CONNECT_MS);
    });
    try {
      const { token, model } = await Promise.race([this.deps.getToken(this.resumeHandle, this.deps.mushaf.key), timeout]);
      if (this.stopped || seq !== this.connectSeq) return; // ended meanwhile: no new socket
      gotToken = true;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const sock = new WebSocket(WS_BASE + 'BidiGenerateContentConstrained?access_token=' + encodeURIComponent(token));
          ws = sock;
          if (this.ws && this.ws !== sock) detach(this.ws); // an older attempt's socket
          sock.binaryType = 'arraybuffer';
          this.ws = sock;
          let opened = false;
          let errored = false;
          // The whole setup (prompt, tools, manual turns, transcription, resumption) is locked into the token.
          sock.onopen = () => {
            opened = true;
            this.send({ setup: { model } });
          };
          sock.onmessage = (e) => {
            if (this.ws !== sock) return;
            const msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
            if (msg.setupComplete !== undefined && !up) {
              up = true;
              this.ready = true;
              this.connectedAt = Date.now();
              this.switching = false; // so that reopen() below opens the new connection's turn
              this.ev.onState('listening');
              // Open the first stretch (or resume after a reconnect, flushing what was held).
              this.closing = true;
              this.reopen();
              if (this.connEpoch && !handover) this.afterReconnect();
              resolve();
              return;
            }
            this.handle(msg);
          };
          sock.onerror = () => {
            errored = true; // the close that follows says why
          };
          sock.onclose = (e) => {
            if (this.ws !== sock) return;
            this.ready = false;
            if (!up) {
              const why = e.reason || (errored && !opened ? 'تعذّر الاتصال بخدمة Gemini Live' : `انقطع الاتصال (${e.code})`);
              reject(new Error(why));
              return;
            }
            if (!this.stopped) this.reconnect(e.reason || `code ${e.code}`);
          };
        }),
        timeout,
      ]);
    } catch (err) {
      if (ws && !up) detach(ws);
      if (this.stopped || seq !== this.connectSeq) return; // «إنهاء» meanwhile, or a newer attempt took over
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { refused: gotToken });
    } finally {
      clearTimeout(timer);
    }
  }

  private async reconnect(why: string) {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.reconnectLoop(why);
    } finally {
      this.reconnecting = false;
    }
  }

  /** Time to hand over (see the header): the connection is old enough, the model has answered (or it is late
   *  enough not to wait for that), and no tool is running. */
  private handoverDue(): boolean {
    const age = Date.now() - this.connectedAt;
    return this.ready && !this.switching && !this.reconnecting && !this.stopped && this.connectedAt > 0 &&
      age >= HANDOVER_MS && (this.answered || age >= HANDOVER_ANY_MS) && !this.toolPending;
  }

  /** Close the connection before Google cuts it and resume the session on a new one (the mic is held meanwhile). */
  private async handOver(forced: boolean) {
    this.switching = true;
    const t0 = Date.now();
    this.ev.onEvent(`handover after ${Math.round((t0 - this.connectedAt) / 1000)}s${forced ? ' (forced)' : ''}${this.resumeHandle ? '' : ', no handle'}`);
    const old = this.ws;
    this.ws = null;
    this.ready = false;
    if (old) detach(old);
    let why = '';
    for (let i = 1; !this.stopped && Date.now() - t0 < HANDOVER_BUDGET_MS; i++) {
      try {
        await this.connect(true);
        if (this.stopped) return;
        this.ev.onEvent(`handover done in ${((Date.now() - t0) / 1000).toFixed(1)}s${i > 1 ? ` (try ${i})` : ''}`);
        return;
      } catch (err) {
        why = err instanceof Error ? err.message : String(err);
        this.ev.onEvent(`handover try ${i} failed: ${why}`);
        if (!STILL_CONNECTED.test(why)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.switching = false;
    if (!this.stopped) this.reconnect('handover failed: ' + why);
  }

  private async reconnectLoop(why: string) {
    const end = (detail: string) => {
      this.stop();
      this.ev.onState('closed', detail);
    };
    this.ev.onEvent('reconnect: ' + why);
    if (QUOTA.test(why)) return end(QUOTA_MSG);
    const t0 = Date.now();
    // A service that accepts the connection and drops it again at once must not be retried for ever.
    this.drops = [...this.drops.filter((t) => t0 - t < DROPS_WINDOW_MS), t0];
    if (this.drops.length > MAX_DROPS) {
      this.ev.onEvent(`reconnect: ${this.drops.length} drops in ${DROPS_WINDOW_MS / 60000} min, giving up`);
      return end('تعذّر استئناف الجلسة');
    }
    this.ev.onState('reconnecting', why);
    this.connectionLost();
    let wait = this.drops.length > 1 ? 1000 * 2 ** (this.drops.length - 2) : 0; // dropped again soon: wait first
    let refused = 0;
    for (let i = 1; !this.stopped; i++) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (this.stopped) return;
      const handle = this.resumeHandle;
      try {
        await this.connect();
        if (!this.stopped) this.ev.onEvent(`reconnected (${handle ? 'with resume handle' : 'new context'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.ev.onEvent(`reconnect try ${i} failed: ${msg}`);
        if (QUOTA.test(msg) || msg === QUOTA_MSG) return end(QUOTA_MSG);
        // The token came but the resumed setup did not: the handle may be gone (expired, or lost with the server's
        // session). Twice (or said so): go on in a new context; afterReconnect() tells the model where we are.
        if (handle && (err as { refused?: boolean }).refused && (++refused >= 2 || RESUME_GONE.test(msg))) {
          this.resumeHandle = null;
          this.ev.onEvent('resumption refused: new context');
        }
      }
      if (Date.now() - t0 >= RECONNECT_MS) break;
      wait = Math.min(8000, 1000 * 2 ** (i - 1));
    }
    if (!this.stopped) end('تعذّر استئناف الجلسة');
  }

  /** The connection is gone, and with it whatever the model was in the middle of: nothing of that turn may leak
   *  into the next connection (a muted remark would mute its first answer, a tool's wait would keep it closed). */
  private connectionLost() {
    this.connEpoch++; // a tool still running answers the old connection (see onTools)
    clearTimeout(this.idleTimer);
    clearTimeout(this.hardTimer);
    const said = cleanSpoken(this.teacher);
    if (said && this.voiced) this.ev.onTeacher(said); // what was heard of the cut answer
    this.refath = this.fathPending && !this.voiced; // asked, not heard: asked again if the reciter still waits
    this.silentAtDrop = this.seg.silentMs;
    this.droppedAt = Date.now();
    this.teacher = '';
    this.voiced = this.muted = this.genHadAudio = false;
    this.pending = [];
    this.fathPending = this.afterTool = this.toolPending = false;
    this.stretchMark = null;
    this.finishYou();
    this.closing = true; // hold the mic audio until the new connection is up
  }

  /** The new connection's turn is open (activityStart, then the held audio). Its context may be new (no handle,
   *  or one refused) or may lack the last moments, and nothing says which: tell the model where we are. */
  private afterReconnect() {
    if (this.closing) {
      this.ev.onEvent('reconnect: turn not open, no context note'); // a text outside a turn would be answered
      return;
    }
    const note = this.contextNote();
    if (note) this.send({ realtimeInput: { text: note } });
    for (const n of this.afterDrop) this.send({ realtimeInput: { text: n } });
    this.afterDrop = [];
    // the fath asked for before the drop was never heard, and the reciter has been silent since: ask again
    const stillWaiting = this.seg.silentMs >= this.silentAtDrop + (Date.now() - this.droppedAt) - 500;
    if (this.refath && stillWaiting && this.tracker.nextPhrase()) this.askFath('انقطع الاتصال قبل أن تفتح عليه');
    this.refath = false;
  }

  /** What a new context needs to go on from here: salat, the open exam question, or the place and its text. */
  private contextNote(): string {
    const m = this.deps.mushaf;
    const short = riwayaOf(m.key).short;
    const parts: string[] = [];
    if (this.praying) parts.push('هو في الصلاة الآن: طبّق قواعد الصلاة.');
    const at = this.tracker.current();
    if (this.exam?.asked) parts.push(`سؤال الاختبار المفتوح، ينتظر جوابه: ${this.exam.asked}`);
    else if (at) {
      const name = m.surahs.find((x) => x.no === at.s)?.name_ar ?? '';
      const i = this.tracker.ayat.indexOf(at);
      const ref = formatReference(this.tracker.ayat.slice(Math.max(0, i - 1), i + 20), m.surahs, m.diffs, short);
      const next = this.tracker.at() > 0 ? `، والكلمات التالية: «${this.tracker.nextPhrase()}»` : '';
      parts.push(`${this.reciting ? 'يقرأ الآن في' : 'آخر موضع فُتح'}: سورة ${name}، الآية ${at.a} بعدّ ${short}${next}. هذا نصّه المرجعي فاحكم به:\n${ref}`);
    }
    if (!parts.length) return '';
    return `(ملاحظة آلية من التطبيق: انقطع الاتصال ثم عاد. تابع من حيث كنّا، ولا تقل شيئاً بسبب هذه الملاحظة. ${parts.join(' ')})`;
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ── mic & turns ────────────────────────────────────────────────────────
  private onMic(f32: Float32Array) {
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff;
    const data = toBase64(new Uint8Array(pcm.buffer));
    const now = Date.now();
    if (this.ready && now - Math.max(this.lastActiveAt, this.lastRecitedAt) > (this.praying ? PRAYER_IDLE_MS : IDLE_MS)) {
      this.stop();
      this.ev.onState('closed', IDLE_MSG);
      return;
    }
    this.seg.talking = !this.reciting;
    // A long answer is playing: its echo must not open or close a stretch. A short remark («أعد») is not concerned,
    // so recitation over it is judged at once.
    const deaf = this.longAnswer();
    const cut = this.seg.feed(pcm, 16000, deaf);
    this.ev.onLevel(this.seg.level);
    this.micMax = Math.max(this.micMax, this.seg.level);
    if (++this.micFrames % 300 === 0) {
      this.ev.onEvent(`mic max=${this.micMax.toFixed(3)} ${this.ready ? '' : 'not-ready '}${this.closing ? 'held' : 'open'}`);
      this.micMax = 0;
    }

    // Client-side barge-in for long answers only: a one-word «أعد» must play over the recitation.
    this.voicedRunMs = this.seg.speaking ? this.voicedRunMs + 100 : 0;
    if (!deaf && this.voicedRunMs >= 500 && this.outCtx && this.playEnd - this.outCtx.currentTime > 1) this.bargeIn();
    // Nothing but listening may keep the mic waiting: the reciter speaks while a lookup's answer is awaited → listen.
    if (this.closing && this.afterTool && !this.toolPending && !this.playing.length && this.voicedRunMs >= 600) {
      this.ev.onEvent('barge-in');
      this.afterTool = false;
      this.reopen();
    }
    // No quiet moment came since the handover was due: hand over now, mid-turn (what the model was saying is lost;
    // Google would cut the connection a little later anyway).
    if (this.handoverDue() && now - this.connectedAt >= HANDOVER_FORCE_MS) {
      clearTimeout(this.idleTimer);
      clearTimeout(this.hardTimer);
      const said = cleanSpoken(this.teacher);
      if (said && this.voiced) this.ev.onTeacher(said);
      this.teacher = '';
      this.voiced = this.muted = this.genHadAudio = this.fathPending = this.afterTool = false;
      this.pending = [];
      this.finishYou();
      this.closing = true;
      this.handOver(true);
    }
    // The recorded mushaf is playing: its sound must not reach the teacher as recitation.
    if (this.mushafAudio) return;

    if (!this.ready || this.closing) {
      this.held.push(data);
      if (this.held.length > HELD_FRAMES) this.held.shift();
      return;
    }
    this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } });
    if (this.seg.speaking) this.lapseSent = false;
    // In salat the reciter cannot ask for help: a long stop inside an ayah is reported as a turn of its own.
    if (!deaf && (this.praying || this.reciting) && !this.lapseSent && this.seg.silentMs >= (this.praying ? LAPSE_MS : LAPSE_OUT_MS) &&
        this.tracker.midAyah() && this.tracker.leftInAyah() >= 2 && now - this.lastRecitedAt < 15000) {
      this.askFath(this.praying ? 'توقّف المصلي' : 'توقّف القارئ وسط الآية');
      return;
    }
    if (cut) {
      this.stretchMark = { reached: this.tracker.reached, matched: this.tracker.matched, seen: this.tracker.seen, exact: this.tracker.exact };
      this.ev.onEvent(`cut lvl=${this.seg.level.toFixed(3)}`);
      this.send({ realtimeInput: { activityEnd: {} } });
      this.closing = true;
      this.answered = false;
      this.finishYou();
      clearTimeout(this.hardTimer);
      this.hardTimer = setTimeout(() => this.reopen(), 5000);
    }
  }

  /** Every word of the last stretch matched the mushaf and it stopped inside an ayah: a «أعد» there is a false
   *  alarm (the model takes a stretch cut at a pause for an unfinished, wrong one). */
  private stretchWasRight(): boolean {
    const m = this.stretchMark;
    if (!m) return false;
    const seen = this.tracker.seen - m.seen;
    return seen >= 2 && this.tracker.exact - m.exact === seen && this.tracker.midAyah();
  }

  /** In salat: the reciter stopped or repeated where they stopped (asking for what follows) → the fath. */
  private askFath(what: string) {
    this.lapseSent = true; // one fath per stop
    this.fathPending = true;
    const next = this.tracker.nextPhrase();
    this.ev.onEvent(`fath? (${what}) ${next}`);
    this.send({ realtimeInput: { activityEnd: {} } });
    this.answered = false;
    this.send({ realtimeInput: { text: `(ملاحظة آلية من التطبيق: ${what}. قل همساً هذه الكلمات وحدها كما هي مضبوطة، ثم اسكت: «${next}»)` } });
    this.closing = true;
    this.finishYou();
    clearTimeout(this.hardTimer);
    this.hardTimer = setTimeout(() => this.reopen(), 5000);
  }

  private reopen() {
    if (!this.closing || !this.ready || this.toolPending || this.switching) return;
    if (this.handoverDue()) {
      clearTimeout(this.idleTimer);
      clearTimeout(this.hardTimer);
      this.fathPending = false;
      this.handOver(false);
      return;
    }
    if (this.held.length > 20) this.ev.onEvent(`reopen after ${this.held.length / 10}s held`);
    clearTimeout(this.idleTimer);
    clearTimeout(this.hardTimer);
    this.fathPending = false;
    this.closing = false;
    this.send({ realtimeInput: { activityStart: {} } });
    for (const data of this.held) this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } });
    this.held = [];
    if (this.noteOnReopen) this.send({ realtimeInput: { text: this.noteOnReopen } });
    this.noteOnReopen = '';
  }

  private finishYou() {
    if (this.you) this.ev.onYou(this.you, true);
    this.you = '';
  }

  // ── server messages ────────────────────────────────────────────────────
  private handle(msg: any) {
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      const old = this.ws;
      if (old) {
        old.onclose = null;
        old.close();
      }
      this.ready = false;
      this.reconnect('goAway');
      return;
    }
    if (msg.voiceActivity?.type === 'ACTIVITY_END' && this.closing && !this.fathPending) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.reopen(), 1500);
    }
    if (msg.toolCall?.functionCalls) {
      const names: string[] = msg.toolCall.functionCalls.map((c: { name: string }) => c.name);
      this.ev.onEvent('tool ' + names.join(','));
      this.toolWaitMs = names.every((n) => QUICK_TOOLS.has(n)) ? 2500 : 8000;
      // a lookup can take seconds: no timer may reopen the turn (that would cancel the answer)
      this.afterTool = true;
      this.toolPending = true;
      clearTimeout(this.idleTimer);
      clearTimeout(this.hardTimer);
      this.onTools(msg.toolCall.functionCalls);
    }

    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      const t: string = sc.inputTranscription.text;
      if (ARABIC.test(t)) {
        if (this.tracker.feed(t + ' ')) {
          this.lastRecitedAt = Date.now();
          this.reciting = true;
          if (this.praying) this.remember(t);
        } else {
          if (t.trim().split(/\s+/).length >= 2) this.reciting = false;
          if (this.praying) this.findPlace(t);
        }
        if (this.exam) this.examElsewhere(t); // common words may move the tracker a little: judge the stretch
        if (this.tracker.skipped) this.reportSkip(this.tracker.skipped);
        if (this.longAnswer() && this.spokeOver(t)) {
          this.bargeIn();
          this.seg.credit(500); // his words before the stop belong to this stretch
        }
        this.you += t;
        this.heard += t.length;
        // «افتح»: the exact words come from the app, so the teacher never says them from memory
        if (FATH_ASKED.test(plain(this.you).trim()) && plain(this.you).trim().split(/\s+/).length <= 4 && (this.tracker.at() > 0 || this.exam)) {
          this.lapseSent = false;
          this.askFath('طلب القارئ الفتح');
        }
        const said = plain(this.you);
        if (!this.praying && TAKBIR.test(said))
          this.setPraying(true, '(ملاحظة آلية من التطبيق: كبّر تكبيرة الإحرام، فهو الآن في الصلاة. طبّق قواعد الصلاة، ولا تقل شيئاً الآن.)');
        else if (this.praying && TASLIM.test(said))
          this.setPraying(false, '(ملاحظة آلية من التطبيق: سلّم المصلي وانتهت صلاته.)');
        this.ev.onYou(this.you.trim(), false);
      }
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        clearTimeout(this.idleTimer);
        this.genHadAudio = true;
        if (this.voiced) this.play(part.inlineData.data);
        else if (!this.muted) this.pending.push(part.inlineData.data);
      }
    }
    if (sc.outputTranscription?.text) {
      this.teacher += sc.outputTranscription.text;
      // a reply that turns out longer than a remark goes back to the normal level
      if (this.voiced && this.turnGain && this.outCtx && cleanSpoken(this.teacher).split(/\s+/).length > 3)
        this.turnGain.gain.setTargetAtTime(VOICE_GAIN, this.outCtx.currentTime, 0.3);
      const first = normalizeTranscript(cleanSpoken(this.teacher)).split(' ')[0];
      if (!this.voiced && !this.muted && first && this.praying && (first.startsWith('اعد') ? this.stretchWasRight() : !this.tracker.isNear(first))) {
        this.muted = true;
        this.pending = [];
      }
      if (this.voiced && this.spoken) this.spoken.text = this.teacher;
      if (!this.voiced && !this.muted && cleanSpoken(this.teacher)) {
        this.voiced = true;
        this.lastTeacherAt = Date.now();
        this.lastActiveAt = Date.now();
        this.startTurnAudio(cleanSpoken(this.teacher));
        if (this.outCtx) this.spoken = { text: this.teacher, t0: Math.max(this.outCtx.currentTime, this.playEnd) };
        this.pending.forEach((d) => this.play(d));
        this.pending = [];
      }
    }
    if (sc.generationComplete || sc.turnComplete) {
      this.answered = true;
      const said = cleanSpoken(this.teacher);
      this.ev.onEvent(`gen heard=${this.heard} said=${said.length}${this.afterTool ? ' afterTool' : ''}`);
      this.heard = 0;
      if (this.muted) this.ev.onEvent('muted: ' + said);
      else if (said) this.ev.onTeacher(said);
      this.muted = false;
      this.teacher = '';
      this.voiced = false;
      this.pending = [];
      const spoke = this.genHadAudio;
      this.genHadAudio = false;
      if (this.fathPending && !spoke && !said) {
        this.ev.onEvent('fath: waiting');
        return; // askFath's hard timer reopens if it never comes
      }
      this.fathPending = false;
      if (this.afterTool && !spoke) {
        // the tool's answer is still to come
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          this.afterTool = false;
          this.reopen();
        }, this.toolWaitMs);
      } else {
        this.afterTool = false;
        this.reopen();
        // the stretch went back over what was already recited, up to where it stopped, and the teacher
        // stayed silent: that is asking for what follows (istiṭʿām), not a correction after «أعد»
        const mark = this.stretchMark;
        this.stretchMark = null;
        if (this.praying && mark && !said && Date.now() - this.lastTeacherAt > 10000 && this.tracker.matched - mark.matched >= 2 &&
            this.tracker.at() <= mark.reached && this.tracker.midAyah() && this.tracker.leftInAyah() >= 1)
          this.askFath('كرّر المصلي ما وقف عنده');
      }
    }
  }

  /** In salat: the words did not follow the open range, so look for them in the whole mushaf and open it there. */
  private remember(chunk: string) {
    this.unplaced = [...this.unplaced, ...normalizeTranscript(chunk).split(' ').filter((w) => w.length >= 2)].slice(-14);
  }

  private findPlace(chunk: string) {
    const m = this.deps.mushaf;
    this.remember(chunk);
    this.locator ??= new MushafLocator(m.quran);
    const open = new Set(this.tracker.ayat.map((x) => x.id));
    const found = this.locator.locate(this.unplaced, (x) => open.has(x.id));
    const at = found?.ayah;
    if (!found || !at) return;
    const range = rangeFrom(m.quran, at.s, at.a, 3);
    this.exam = null;
    this.anchor = null;
    this.tracker.setRange(range, false, m.diffs);
    this.tracker.feed(this.unplaced.slice(found.from).join(' ') + ' ');
    this.unplaced = [];
    this.lastRecitedAt = Date.now();
    this.reciting = true;
    this.current = { s: at.s, a: at.a };
    const name = m.surahs.find((x) => x.no === at.s)?.name_ar ?? '';
    this.ev.onPosition(`سورة ${name} · من الآية ${at.a}`);
    this.ev.onReciting(this.current);
    this.ev.onEvent(`placed ${at.s}:${at.a}`);
    const ref = formatReference(range, m.surahs, m.diffs, riwayaOf(m.key).short);
    this.send({ realtimeInput: { text: `(ملاحظة آلية من التطبيق: المصلي يقرأ الآن من سورة ${name}، الآية ${at.a}. هذا نصّها المرجعي فاحكم به، ولا تقل شيئاً الآن.)\n${ref}` } });
  }

  /** The tracker follows the expected answer, so a fath (asked, or after a long stop) comes from it and not from
   *  the place recited before the exam. No ayat (the question asks for a surah name): nothing to follow. */
  private openExam(want: { s: number; a: number }[]) {
    const m = this.deps.mushaf;
    const ayat = want.map((w) => m.quran.find((x) => x.s === w.s && x.a === w.a)).filter((x): x is Ayah => !!x);
    this.tracker.setRange(ayat, false, m.diffs);
    // the ayah just before or after is not «elsewhere» (starting a little early, going on after the answer)
    const near = new Set(ayat.flatMap((x) => [x.id - 1, x.id, x.id + 1]));
    this.exam = { ayat, near, told: new Set() };
    this.anchor = null;
    this.unplaced = [];
    this.reciting = false; // no fath before the answer starts
    this.lastRecitedAt = 0;
    this.lapseSent = false;
    if (ayat[0]) this.current = { s: ayat[0].s, a: ayat[0].a };
    this.ev.onEvent(`exam ${ayat.map((x) => `${x.s}:${x.a}`).join(',') || 'name'}`);
  }

  /** The answer does not follow the expected ayat: find where in the mushaf it is from, and tell the teacher. */
  private examElsewhere(chunk: string) {
    const m = this.deps.mushaf;
    const exam = this.exam;
    if (!exam?.ayat.length) return;
    this.remember(chunk);
    this.locator ??= new MushafLocator(m.quran);
    // the whole mushaf, the expected ayat included: a clear place elsewhere (mutashabihat that fit both stay unknown)
    const at = this.locator.locate(this.unplaced)?.ayah;
    if (!at || exam.near.has(at.id) || exam.told.has(at.id)) return;
    exam.told.add(at.id);
    this.unplaced = [];
    this.tracker.setRange(exam.ayat, false, m.diffs); // a fath now is the beginning of the expected answer
    this.reciting = false; // and only when asked: the teacher says «أعد» first
    const name = m.surahs.find((x) => x.no === at.s)?.name_ar ?? '';
    const want = exam.ayat;
    const wantName = m.surahs.find((x) => x.no === want[0]?.s)?.name_ar ?? '';
    this.ev.onEvent(`exam elsewhere ${at.s}:${at.a}`);
    this.send({ realtimeInput: { text: `(ملاحظة آلية من التطبيق: ما يقرؤه الآن ليس الجواب المطلوب: هو من سورة ${name}، الآية ${at.a} بعدّ ${riwayaOf(m.key).short}، والجواب المطلوب من سورة ${wantName}، الآية ${want[0]?.a}. احكم بهذا لا بحفظك: «أعِد»، وإن سألك عمّا قرأه فأخبره بموضعه هذا، ولا تكشف الجواب إلا إذا طلب الفتح.)` } });
  }

  /** The model misses skipped ayat (a jump to a similar ayah); the client's alignment tells it plainly. */
  private reportSkip({ from, to, moved }: { from: Ayah; to: Ayah; moved: boolean }) {
    this.tracker.skipped = null;
    this.ev.onEvent(`${moved ? 'moved' : 'skip'} ${from.s}:${from.a}→${to.s}:${to.a}`);
    if (moved) return; // he went there on purpose: follow him
    const name = this.deps.mushaf.surahs.find((x) => x.no === to.s)?.name_ar ?? '';
    const ask = this.praying
      ? 'قل له «أعِد» همساً الآن، ولا تقرأ له شيئاً.'
      : 'قل له «أعِد» الآن كما تنبّهه على أي خطأ (دون أن تقرأ له شيئاً)، إلا إذا كان قد أخبرك أنه يقصد الانتقال.';
    this.send({ realtimeInput: { text: `(ملاحظة آلية من التطبيق: يبدو أن القارئ انتقل في سورة ${name} من نحو الآية ${from.a} إلى نحو الآية ${to.a} وترك ما بينهما؛ تحقّق بالنص المرجعي. ${ask})` } });
  }

  private async onTools(calls: { id: string; name: string; args?: any }[]) {
    const epoch = this.connEpoch;
    const responses = [];
    for (const c of calls) {
      const args = c.args ?? {};
      let response: Record<string, unknown> = { result: 'ok' };
      try {
        const m = this.deps.mushaf;
        if (c.name === 'open_mushaf') {
          let at = { s: Number(args.surah), a: Number(args.ayah) || 1 };
          if (args.numbering === 'hafs') at = (await this.deps.fromHafs(at.s, at.a)) ?? at;
          const range = rangeFrom(m.quran, at.s, at.a);
          const anchor = this.anchor;
          if (range.length && anchor && this.slipFromAnchor(range[0], args.announced === true || String(args.announced) === 'true')) {
            const name = m.surahs.find((x) => x.no === anchor.s)?.name_ar ?? '';
            const other = m.surahs.find((x) => x.no === range[0].s)?.name_ar ?? '';
            this.ev.onEvent(`slip ${range[0].s}:${range[0].a} (stopped in ${anchor.s}:${anchor.a}): not opened`);
            response = {
              result: `لم يُفتح. أنهى الجلسة السابقة قبل قليل في سورة ${name}، الآية ${anchor.a}، وما قرأه الآن يشبه سورة ${other}، الآية ${range[0].a} (متشابه): فهي زلة. قل «أعِد» فقط، واحكم بنص سورة ${name} الذي معك. وإن قال صراحة إنه يريد سورة ${other} فاستدعِ open_mushaf مرة أخرى مع announced=true.`,
            };
          } else if (range.length) {
            this.anchor = null;
            this.exam = null;
            this.tracker.setRange(range, false, m.diffs);
            this.reciting = true;
            this.current = { s: range[0].s, a: range[0].a };
            const name = m.surahs.find((x) => x.no === range[0].s)?.name_ar ?? '';
            this.ev.onPosition(`سورة ${name} · من الآية ${range[0].a}`);
            this.ev.onReciting(this.current);
            response = { result: formatReference(range, m.surahs, m.diffs, riwayaOf(m.key).short) };
          } else response = { error: `لا توجد هذه الآية في مصحف ${riwayaOf(m.key).short}` };
        } else if (c.name === 'show_ayah') {
          const s = Number(args.surah) || this.current?.s;
          const a = Number(args.ayah) || this.current?.a;
          const ayah = m.quran.find((x) => x.s === s && x.a === a);
          if (ayah) {
            const name = m.surahs.find((x) => x.no === ayah.s)?.name_ar ?? '';
            this.ev.onCard({ title: `سورة ${name} · الآية ${ayah.a}`, text: ayah.t });
          }
        } else if (c.name === 'exam_question') {
          const q = await this.deps.nextExamQuestion({ surah: args.surah, juz: args.juz });
          this.ev.onCard({ title: `السؤال ${q.n} · ${q.title}`, text: q.cue });
          this.openExam(q.ayat);
          if (this.exam) this.exam.asked = `السؤال ${q.n}: ${q.question} (على الشاشة: «${q.cue}»)، والجواب المتوقَّع (EXPECTED، لا تكشفه): «${q.expected}»`;
          response = { number: q.n, question: q.question, cue_shown_on_screen: q.cue, EXPECTED: q.expected };
        } else if (c.name === 'tafsir') {
          const key = `${Number(args.surah) || this.current?.s || 1}:${Number(args.ayah) || this.current?.a || 1}`;
          const hafsId = m.toHafs[key];
          response = hafsId ? await this.deps.tafsir(hafsId, args.book) : { error: 'لا توجد هذه الآية' };
        } else if (c.name === 'library_search') {
          response = await this.deps.library(String(args.book), String(args.query ?? ''));
          const pages = ((response.results ?? []) as { page?: number }[]).map((r) => r.page).join(',');
          if (pages) response = { ...response, ...libraryNote(String(args.book)) };
          this.ev.onEvent(`library ${args.book} «${args.query}» → ${pages || 'none'}`);
        } else if (c.name === 'set_riwaya' && riwayaOf(args.riwaya).key === m.key) {
          response = { result: `رواية ${riwayaOf(m.key).short} هي المختارة الآن.` };
        } else if (c.name === 'set_riwaya' && String(args.confirmed) !== 'true') {
          // a spoken name is easily misheard («قنبل» → «شعبة»): the reciter confirms it first
          response = { result: `لم تتغيّر الرواية. اسأله أولاً بكلمات قليلة: «أنتقل إلى رواية ${riwayaOf(args.riwaya).short}؟»، فإذا أكّد أو أعاد اسمها فاستدعِ set_riwaya بـ confirmed=true.` };
        } else if (c.name === 'set_riwaya') {
          const next = await this.deps.switchRiwaya(args.riwaya);
          this.deps.mushaf = next;
          this.locator = null;
          this.exam = null;
          this.anchor = null;
          this.tracker.setRange([]);
          this.current = null;
          response = { result: `صارت الرواية المختارة: ${riwayaOf(next.key).name}. احكم بها من الآن، واستدعِ open_mushaf للموضع.\n${riwayaBrief(riwayaOf(next.key))}` };
        } else if (c.name === 'prayer_mode') {
          this.setPraying(Boolean(args.on));
        } else if (c.name === 'play_recitation') {
          const s = Number(args.surah) || this.current?.s || 1;
          const from = Number(args.from_ayah) || 1;
          const span = await ayahSpan(m.key, s, from, Number(args.to_ayah) || from, args.reciter);
          if ('error' in span) response = { error: span.error };
          else {
            const name = m.surahs.find((x) => x.no === s)?.name_ar ?? '';
            this.playMushaf(span.url, span.start, span.end, `${span.reciter} · سورة ${name} ${from}${Number(args.to_ayah) > from ? '–' + args.to_ayah : ''}`);
            const missing = span.missing ? `ليس في التطبيق تسجيل لـ«${args.reciter}» برواية ${riwayaOf(m.key).short}، فأخبره بذلك. ` : '';
            response = { result: `${missing}يُتلى الآن بصوت ${span.reciter} برواية ${riwayaOf(m.key).short}. اسكت حتى ينتهي.` };
          }
        } else if (c.name === 'past_sessions') {
          response = { result: this.deps.pastSessions() || 'لا توجد جلسات سابقة على هذا الجهاز.' };
        }
      } catch (err) {
        response = { error: String(err) };
      }
      responses.push({ id: c.id, name: c.name, response });
    }
    if (epoch !== this.connEpoch) {
      // Asked on a connection that dropped meanwhile: the new one never made this call (its ids mean nothing there)
      // and its turn is not waiting for it. The result goes over as a note.
      const names = calls.map((c) => c.name).join('، ');
      this.ev.onEvent('tool answered after the drop: ' + names);
      const note = `(ملاحظة آلية من التطبيق: انقطع الاتصال قبل أن تصلك نتيجة ${names}، وهذه هي: ${JSON.stringify(responses.map((r) => r.response))})`;
      if (this.ready) this.send({ realtimeInput: { text: note } });
      else this.afterDrop.push(note);
      return;
    }
    this.send({ toolResponse: { functionResponses: responses } });
    this.toolPending = false;
    if (this.praying) {
      // in salat the teacher does not answer a lookup: give the turn back now, or the recitation is held
      this.afterTool = false;
      this.reopen();
      return;
    }
    // now wait for the spoken answer (generation with audio), or give the turn back after 8 s
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.afterTool = false;
      this.reopen();
    }, this.toolWaitMs);
  }

  // ── playback ───────────────────────────────────────────────────────────
  /** Called once per voiced turn, before its first chunk plays. Short remarks are played softer. */
  private startTurnAudio(firstWords: string) {
    const ctx = this.outCtx;
    if (!ctx) return;
    this.turnGain = ctx.createGain();
    this.turnGain.gain.value = firstWords.split(/\s+/).length <= 2 && firstWords.length <= 14 ? SOFT_GAIN : VOICE_GAIN;
    this.turnGain.connect(ctx.destination);
  }

  private mushafAudio: HTMLAudioElement | null = null;

  /** The recorded mushaf, through the same output as the teacher's voice (so one volume controls both). */
  private playMushaf(url: string, start: number, end: number, label: string) {
    this.stopMushaf();
    const ctx = this.outCtx;
    if (!ctx) return;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src = url + (end < Infinity ? `#t=${start},${end}` : start ? `#t=${start}` : '');
    ctx.createMediaElementSource(el).connect(ctx.destination);
    this.mushafAudio = el;
    this.ev.onMushafAudio(label);
    this.ev.onEvent('mushaf ' + label);
    const done = () => this.mushafAudio === el && this.stopMushaf();
    el.addEventListener('timeupdate', () => el.currentTime >= end && done());
    el.addEventListener('pause', done);
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    el.play().catch(done);
  }

  stopMushaf() {
    const el = this.mushafAudio;
    if (!el) return;
    this.mushafAudio = null;
    el.pause();
    el.removeAttribute('src');
    this.ev.onMushafAudio(null);
    this.lastActiveAt = Date.now();
  }

  private play(b64: string) {
    const ctx = this.outCtx;
    if (!ctx || this.mushafAudio) return; // the teacher keeps quiet while the mushaf plays
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = ctx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      ch[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.turnGain ?? ctx.destination);
    const at = Math.max(ctx.currentTime, this.playEnd);
    src.start(at);
    this.playEnd = at + buf.duration;
    this.playing.push(src);
    this.ev.onSpeaking(true);
    src.onended = () => {
      this.playing = this.playing.filter((x) => x !== src);
      if (!this.playing.length) this.ev.onSpeaking(false);
    };
  }

  /** A long answer is audible (or just ended: its echo lingers a little). */
  private longAnswer(): boolean {
    const now = this.outCtx?.currentTime ?? 0;
    return !!this.spoken && this.playEnd - this.spoken.t0 > 1.5 && now < this.playEnd + 0.3;
  }

  /** Transcribed words of the reciter over the answer: not the teacher's own words coming back, not «طيب»/«نعم». */
  private spokeOver(chunk: string): boolean {
    const own = new Set(normalizeTranscript(cleanSpoken(this.spoken?.text ?? '')).split(' '));
    return normalizeTranscript(chunk)
      .split(' ')
      .some((w) => w.length >= 2 && !own.has(w) && !BACKCHANNEL.has(w));
  }

  /** The reciter spoke over a long answer: stop it, and tell the teacher how much of it was heard, so that «أكمل»
   *  goes on from there instead of starting the answer again. */
  private bargeIn() {
    const ctx = this.outCtx;
    const s = this.spoken;
    let heard = '';
    if (ctx && s) {
      const words = cleanSpoken(s.text).split(/\s+/).filter(Boolean);
      const part = Math.max(0, Math.min(1, (ctx.currentTime - s.t0) / Math.max(0.1, this.playEnd - s.t0)));
      heard = words.slice(0, Math.round(words.length * part)).join(' ');
    }
    this.stopPlayback();
    this.ev.onEvent(`stopped by voice${heard ? ' after «…' + heard.slice(-30) + '»' : ''}`);
    if (!heard) return;
    const note = `(ملاحظة آلية من التطبيق: قاطعك القارئ، فلم يسمع من جوابك إلا: «${heard}». أجبه عمّا يقوله الآن، وإن طلب أن تكمل فأكمل من بعد ذلك ولا تُعِد ما سمعه.)`;
    if (this.ready && !this.closing) this.send({ realtimeInput: { text: note } });
    else this.noteOnReopen = note;
  }

  private stopPlayback() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playing = [];
    this.playEnd = 0;
    this.spoken = null;
    this.ev.onSpeaking(false);
  }
}
