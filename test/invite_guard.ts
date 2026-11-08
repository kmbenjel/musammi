// No invitation to start twice (user 2026-11-07: «سورة الغاشية» got «بسم الله، تفضّل، أنا معك» three times, 23:38): a reply
// that is only an invitation («تفضل»، «أنا معك»، «أسمعك»، «بسم الله»، «خذ وقتك»…) within 60 s of one that played is muted
// («invite again»); an invitation with content, or after 60 s, plays. Drives handle() like test/feedback_guard.ts.
// Build: client/node_modules/.bin/esbuild test/invite_guard.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/invite.mjs
// Run:   node /tmp/hw/invite.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { RecitationSession } from '../client/src/live/session';
import { PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
(globalThis as any).WebSocket = { OPEN: 1 };
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const w = n(quran.find((x) => x.s === 88 && x.a === 1).c).split(' ').filter(Boolean);

interface Turn {
  heard?: string[];
  said: string;
  gap?: number;
}
function run(turns: Turn[]) {
  const events: string[] = [], teacher: string[] = [];
  const ev: any = new Proxy({}, { get: (_t, k) => (k === 'onEvent' ? (e: string) => events.push(e) : k === 'onTeacher' ? (t: string) => teacher.push(t) : () => {}) });
  const s: any = new RecitationSession({ mushaf: { key: 'warsh', quran, surahs: [], diffs: {} } } as any, ev);
  s.ws = { readyState: 1, send: () => {} };
  s.ready = true;
  s.startTurnAudio = () => {};
  s.reopen = () => {};
  s.extendReference = () => {};
  s.prefetchFath = () => {};
  s.play = () => {};
  s.outCtx = { currentTime: 100, createBufferSource: () => ({ connect: () => ({ connect() {} }), start() {} }), createGain: () => ({ gain: {}, connect: () => ({ connect() {} }) }), destination: {} };
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 88, 1));
  s.tracker = t;
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    for (const turn of turns) {
      now += turn.gap ?? 5000;
      for (const h of turn.heard ?? []) s.handle({ serverContent: { inputTranscription: { text: h } } });
      if (turn.heard?.length) s.finishYou();
      s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
      s.handle({ serverContent: { outputTranscription: { text: turn.said } } });
      s.handle({ serverContent: { generationComplete: true } });
    }
  } finally {
    Date.now = realNow;
  }
  return { teacher, muted: events.filter((e) => e.startsWith('muted')).map((e) => e.match(/\((.*?)\)/)?.[1] ?? 'muted') };
}

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};

let r = run([
  { heard: ['سورة الغاشية '], said: 'بسم الله، تفضّل، أنا معك.' },
  { heard: ['يلا بتاع '], said: 'تفضل، أنا معك.' },
  { heard: ['اريدك ان تحفظني '], said: 'تفضل، أنا معك، أسمعك.' },
]);
check('three invitations in a row: the first plays, the next two are muted (invite again)', r.teacher.length === 1 && r.muted.join() === 'invite again,invite again', r);
r = run([
  { heard: ['سورة الغاشية '], said: 'بسم الله، تفضّل، أنا معك.' },
  { heard: ['اريدك ان تحفظني '], said: 'تفضل يا بني، ابدأ بقراءة الآية الأولى من سورة الغاشية، وأنا معك.' },
]);
check('an invitation with content plays', r.teacher.length === 2 && r.muted.length === 0, r);
r = run([
  { heard: ['سورة الغاشية '], said: 'تفضل، أنا معك.' },
  { heard: [w.slice(0, 4).join(' ') + ' '], said: 'أعِد.' },
]);
check('a correction right after an invitation plays', r.teacher.length === 2 && r.muted.length === 0, r);
r = run([
  { heard: ['سورة الغاشية '], said: 'تفضل، أنا معك.' },
  { heard: ['يلا '], said: 'خذ وقتك، أنا معك.', gap: 70000 },
]);
check('after 70 s an invitation plays again', r.teacher.length === 2 && r.muted.length === 0, r);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
