// The fath in the reciter's own recorded mushaf, never in the model's voice (user, 2026-11-06): the words he needs,
// cut from the default reciter's recording by its word timings (audio.ts), and played at once.
//
// Why byte ranges and not a copy of the clips: cdn.mp3quran.net serves every surah as a constant 128 kbps MPEG-1
// file (checked 2026-11-06 on al-Kouchi: every frame 128 kbps, 44.1 kHz), with Accept-Ranges and open CORS, so a
// second of audio is 16 000 bytes after the ID3 tag and a Range request fetches exactly the jumla, ~80 KB for 5 s.
// The bytes are decoded with Web Audio (the decoder syncs on the first whole frame; a second of lead covers the
// frame it drops and the bit reservoir) and played from the sample wanted. To start instantly when he stops, the
// ayah he is in and the next one are fetched as he advances (prefetch), so a fath is a slice of a buffer in memory.
import type { Span } from './audio';

const BYTES_PER_S = 16000; // 128 kbps
const LEAD_S = 1.0;
const TAIL_S = 0.3;
const KEEP = 4; // decoded ayat kept (a long ayah is ~3 MB of samples)

interface Piece {
  url: string;
  t0: number; // file time of the buffer's first sample
  buffer: AudioBuffer;
}

/** The first MPEG frame header in the bytes (a header followed by another a frame later), or -1. */
export function firstFrame(b: Uint8Array): number {
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe6) !== 0xe2) continue; // sync, MPEG-1, layer III
    const br = b[i + 2] >> 4, sr = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (br === 0 || br === 15 || sr === 3) continue;
    const len = Math.floor((144 * [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][br] * 1000) / [44100, 48000, 32000][sr]) + pad;
    const j = i + len;
    if (j + 1 >= b.length || (b[j] === 0xff && (b[j + 1] & 0xe6) === 0xe2)) return i;
  }
  return -1;
}

export class FathPlayer {
  private id3 = new Map<string, Promise<number>>();
  private pieces = new Map<string, Promise<Piece | null>>(); // url:from:to → the decoded range
  private order: string[] = [];
  private current: { src: AudioBufferSourceNode; done: () => void } | null = null;

  constructor(private ctx: () => AudioContext | null, private onEvent: (what: string) => void) {}

  get playing(): boolean {
    return !!this.current;
  }

  /** The size of the ID3v2 tag at the file's start (0 when none): where the audio bytes begin. */
  private async headerOf(url: string): Promise<number> {
    if (!this.id3.has(url)) {
      this.id3.set(url, (async () => {
        const r = await fetch(url, { headers: { Range: 'bytes=0-9' } });
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
        return 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
      })().catch((e) => {
        this.id3.delete(url);
        throw e;
      }));
    }
    return this.id3.get(url)!;
  }

  /** Seconds `from`..`to` of the file, decoded (the ranges are whole seconds, so a span and its prefetch share one). */
  private piece(url: string, from: number, to: number): Promise<Piece | null> {
    const key = `${url}:${from}:${to}`;
    let p = this.pieces.get(key);
    if (p) return p;
    p = (async () => {
      const ctx = this.ctx();
      if (!ctx) return null;
      const id3 = await this.headerOf(url);
      const a = id3 + from * BYTES_PER_S, b = id3 + to * BYTES_PER_S - 1;
      const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
      if (r.status !== 206) throw new Error(`range ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const sync = firstFrame(bytes);
      if (sync < 0) throw new Error('no frame');
      const buffer = await ctx.decodeAudioData(bytes.slice(sync).buffer);
      return { url, t0: (a + sync - id3) / BYTES_PER_S, buffer };
    })();
    this.pieces.set(key, p);
    this.order.push(key);
    while (this.order.length > KEEP) this.pieces.delete(this.order.shift()!);
    p.catch((e) => {
      this.pieces.delete(key);
      this.onEvent(`fath fetch failed: ${String(e).slice(0, 80)}`);
    });
    return p;
  }

  private rangeOf(start: number, end: number): [number, number] {
    return [Math.max(0, Math.floor(start - LEAD_S)), Math.ceil(end + TAIL_S)];
  }

  /** Fetch and decode these seconds of the file now, so a fath inside them starts at once. */
  prefetch(url: string, start: number, end: number): void {
    const [a, b] = this.rangeOf(start, end);
    this.piece(url, a, b).catch(() => {});
  }

  /** Is this span already in memory? */
  ready(span: Span): boolean {
    const [a, b] = this.rangeOf(span.start, span.end);
    return this.pieces.has(`${span.url}:${a}:${b}`);
  }

  /** Play the span (a slice of the piece that holds it, fetched now if it is not there); resolves when it ended. */
  async play(span: Span, gain: number): Promise<void> {
    this.stop();
    const ctx = this.ctx();
    if (!ctx) throw new Error('no audio');
    // the piece that holds the span: the prefetched ayah's range, or a range of its own
    const [a, b] = this.rangeOf(span.start, span.end);
    let piece: Piece | null = null;
    for (const [key, p] of this.pieces) {
      const [, from, to] = key.slice(span.url.length).split(':').map(Number);
      if (key.startsWith(span.url + ':') && from <= a && to >= b) piece = (await p) ?? piece;
    }
    piece ??= await this.piece(span.url, a, b);
    if (!piece) throw new Error('no audio');
    const offset = span.start - piece.t0;
    const duration = span.end - span.start;
    if (offset < 0 || offset + duration > piece.buffer.duration + 0.05) throw new Error('span outside the piece');
    await new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = piece!.buffer;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(ctx.destination);
      const done = () => {
        if (this.current?.src !== src) return;
        this.current = null;
        resolve();
      };
      src.onended = done;
      this.current = { src, done };
      src.start(0, offset, duration);
    });
  }

  stop(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    try {
      c.src.stop();
    } catch {
      /* already stopped */
    }
    c.done();
  }
}
