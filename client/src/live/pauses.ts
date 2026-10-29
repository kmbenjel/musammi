// Client-side turn segmentation for recitation.
// Gemini's automatic VAD does not treat melodic tartil as speech (it drops most of it), so the
// app keeps a manual activity open and closes it at the reciter's own pauses (waqf / breath),
// which makes the model judge each stretch right away. Pure (no DOM): 16 kHz Int16 frames in.

export interface PauseOptions {
  pauseMs: number; // silence that ends a stretch (waqf)
  maxStretchMs: number; // long continuous recitation: cut at the next short dip after this
  dipMs: number;
}

// Reciting: cut fast so «أعد» never comes late. Talking: people pause mid-sentence, so wait longer.
export const DEFAULT_PAUSES: PauseOptions = { pauseMs: 500, maxStretchMs: 3000, dipMs: 180 };
export const TALK_PAUSES: PauseOptions = { pauseMs: 1300, maxStretchMs: 20000, dipMs: 500 };

export class PauseSegmenter {
  private floor = 0.004; // adaptive noise floor (RMS, 0..1)
  silentMs = 0; // silence since the last voiced frame
  private voicedMs = 0; // voiced time inside the current stretch
  private stretchMs = 0;
  level = 0; // last frame RMS, for the UI meter
  speaking = false;
  talking = false; // set by the session: the current speech is conversation, not recitation

  constructor(private opts: PauseOptions = DEFAULT_PAUSES, private talkOpts: PauseOptions = TALK_PAUSES) {}

  /** Feed one chunk; returns true when the current stretch should be closed (activityEnd → activityStart).
   *  `deaf`: the teacher's long answer is playing, so what the mic hears is its echo (not voice, not the floor). */
  feed(pcm: Int16Array, sampleRate = 16000, deaf = false): boolean {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    const ms = (pcm.length / sampleRate) * 1000;
    this.level = rms;

    // Noise floor: follows quiet frames quickly, loud frames very slowly.
    if (!deaf) this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.998 + rms * 0.002;
    const voiced = !deaf && rms > Math.max(0.012, this.floor * 2.5);
    this.speaking = voiced;

    this.stretchMs += ms;
    if (voiced) {
      this.voicedMs += ms;
      this.silentMs = 0;
      return false;
    }
    this.silentMs += ms;
    if (this.voicedMs < 300) return false; // nothing worth judging yet
    const o = this.talking ? this.talkOpts : this.opts;
    const limit = this.stretchMs > o.maxStretchMs ? o.dipMs : o.pauseMs;
    if (this.silentMs >= limit) {
      this.voicedMs = 0;
      this.stretchMs = 0;
      return true;
    }
    return false;
  }

  /** The reciter barged in over the teacher: the voice heard while deaf counts for the stretch. */
  credit(ms: number) {
    this.voicedMs += ms;
    this.silentMs = 0;
  }
}
