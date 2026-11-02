// The owner's sessions keep their audio: what the mic really heard is the only way to settle a wrong «أعد» later, and
// the material for replays. Only the private link records (App passes `record` to the session only then); a reciter
// with their own key has no such path.
//
// The browser's own Opus encoder does the work, off the mic path: nothing here touches the turns, and a failure only
// loses audio. About 11 MB an hour, next to the ~150 MB an hour already streaming to Gemini. The slices are pieces of
// one file: joined in order they play, and the first event `audio-start <ms>` says where it starts in the session.
const SLICE_MS = 15_000; // short enough to fit a keepalive request, the kind that outlives the page
const BITRATE = 24_000;
const KEEPALIVE_MAX = 60_000; // a keepalive request body must stay under 64 KB
const QUEUE_MAX = 40; // slices held while the network is away (10 min); older ones are dropped
const RETRY_MS = 5_000;
const RETRIES = 60; // in a row, without one slice getting through: give up

export function recordMic(stream: MediaStream, at: number, accessKey: string, onEvent: (what: string) => void): () => void {
  const type = typeof MediaRecorder === 'undefined' ? undefined : ['audio/webm;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) {
    onEvent('audio-unsupported');
    return () => {};
  }
  const queue: { seq: number; blob: Blob }[] = [];
  let seq = 0;
  let sending = false;
  let tries = 0;
  let refused = false;

  async function pump() {
    if (sending || refused) return;
    sending = true;
    while (queue.length) {
      const { seq: n, blob } = queue[0];
      try {
        const r = await fetch(`/api/audio?at=${at}&seq=${n}`, {
          method: 'POST',
          headers: { 'X-Access-Key': accessKey, 'Content-Type': type! },
          body: blob,
          keepalive: blob.size < KEEPALIVE_MAX,
        });
        if (r.status >= 400 && r.status < 500) {
          refused = true;
          queue.length = 0;
          onEvent('audio-refused ' + r.status);
          if (rec.state !== 'inactive') rec.stop();
          break;
        }
        if (!r.ok) throw new Error(String(r.status));
        queue.shift();
        tries = 0;
      } catch {
        if (++tries <= RETRIES) setTimeout(pump, RETRY_MS);
        else {
          onEvent(`audio-lost ${queue.length} slices`);
          queue.length = 0;
        }
        break;
      }
    }
    sending = false;
  }

  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: BITRATE });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      queue.push({ seq: seq++, blob: e.data });
      if (queue.length > QUEUE_MAX) {
        queue.shift();
        onEvent('audio-lost 1 slice');
      }
      pump();
    };
    rec.onstart = () => onEvent(`audio-start ${Date.now() - at}`);
    rec.onerror = () => onEvent('audio-error');
    rec.start(SLICE_MS);
  } catch (e) {
    onEvent('audio-error ' + String(e));
    return () => {};
  }
  const flush = () => {
    if (document.visibilityState === 'hidden' && rec.state === 'recording') rec.requestData();
  };
  document.addEventListener('visibilitychange', flush);
  return () => {
    document.removeEventListener('visibilitychange', flush);
    if (rec.state !== 'inactive') rec.stop();
  };
}
