// set_riwaya switches at once, with no confirmation (user 2026-11-04: «تمام… تفضّل» went unheeded on 11-03 16:15),
// and says so when the riwaya is already the selected one; the badge switches mid-session (pickRiwaya) and holds the
// mic and the teacher while its sheet is open; library_search answers carry the reading note and Badour's terms.
// Drives RecitationSession.handle() with tool calls the way the Live socket delivers them.
// Build: client/node_modules/.bin/esbuild test/riwaya_switch.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/riwaya.mjs
// Run:   node /tmp/hw/riwaya.mjs   (from the repo root; exit 1 on a failure)
import { RecitationSession, type MushafData } from '../client/src/live/session.ts';
import { liveConfig } from '../client/src/live/prompt.ts';
import type { RiwayaKey } from '../client/src/live/riwayat.ts';

(globalThis as any).WebSocket = { OPEN: 1 };
const sent: any[] = [];
const events: string[] = [];
const switched: RiwayaKey[] = [];
const mushaf = (key: RiwayaKey): MushafData => ({ key, quran: [], surahs: [], diffs: {} as any, toHafs: {} });
const badour = { ok: true, results: [{ book: 'البدور الزاهرة', part: '1', page: 108, text: '" أنها إذا قرأ المكي والبصريان وخلف عن نفسه وشعبة بخلف عنه بكسر الهمزة…' }] };

const s = new RecitationSession(
  {
    getToken: async () => ({ token: '', model: '' }),
    mushaf: mushaf('warsh'),
    switchRiwaya: async (k) => (switched.push(k), mushaf(k)),
    fromHafs: async () => null,
    pastSessions: () => '',
    tafsir: async () => ({}),
    library: async (book) => (book === 'itqan' ? { ok: true, results: [{ page: 5, text: '…' }] } : book === 'none' ? { ok: false, error: 'offline' } : badour),
    nextExamQuestion: async () => ({ n: 1, title: '', cue: '', question: '', expected: '', ayat: [] }),
  },
  new Proxy({} as any, { get: (_, k) => (k === 'onEvent' ? (e: string) => events.push(e) : () => {}) }),
);
const S = s as any;
S.ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
S.ready = true;

let n = 0;
async function call(name: string, args: Record<string, unknown>) {
  sent.length = 0;
  S.handle({ toolCall: { functionCalls: [{ id: String(++n), name, args }] } });
  for (let i = 0; i < 50 && !sent.some((m) => m.toolResponse); i++) await new Promise((r) => setTimeout(r, 5));
  const r = sent.find((m) => m.toolResponse)?.toolResponse.functionResponses[0].response;
  if (!r) throw new Error('no toolResponse for ' + name);
  return r;
}
let failed = 0;
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
};

// 1. a clear request switches at once, with no question
let r = await call('set_riwaya', { riwaya: 'qumbul' });
check('call switches without confirmation', switched.join() === 'qumbul' && S.deps.mushaf.key === 'qumbul', r.result);
check('…answer carries the new riwaya and its rules', /صارت الرواية المختارة: قنبل عن ابن كثير/.test(r.result) && /الرواية: قنبل/.test(r.result));
check('…tracker and place reset', S.current === null && S.exam === null && S.locator === null);

// 2. asking for the riwaya already selected: nothing to switch, no question
r = await call('set_riwaya', { riwaya: 'qumbul' });
check('same riwaya: no switch', switched.length === 1 && !/أنتقل/.test(r.result), r.result);

// 3. the badge mid-session: hold stops the mic and the teacher's voice; the pick switches and tells the teacher
let played = 0;
S.outCtx = { currentTime: 0, createBuffer: () => { played++; throw new Error('played'); } };
S.hold(true);
sent.length = 0;
S.onMic(new Float32Array(1600));
check('held: the mic sends nothing', !sent.length);
try { S.play('AAAA'); } catch { /* createBuffer reached */ }
check('held: the teacher is not played', played === 0);
await S.pickRiwaya('hafs');
S.hold(false);
check('badge pick switches', switched.join() === 'qumbul,hafs' && S.deps.mushaf.key === 'hafs' && S.current === null);
const note = sent.find((m) => m.realtimeInput?.text)?.realtimeInput.text ?? '';
check('…the teacher is told, with the rules', /اختار القارئ من الشاشة رواية حفص عن عاصم/.test(note) && /الرواية: حفص/.test(note), note.slice(0, 80));
check('…hold events logged', events.includes('hold') && events.includes('hold off') && events.includes('riwaya hafs (badge)'));
S.outCtx = null;

// 5. library_search: reading note + Badour terms; nashr note only; itqan and failures untouched; the query is logged
r = await call('library_search', { book: 'badour', query: 'يشعركم الانعام' });
check('badour: text kept', r.results?.[0]?.page === 108);
check('badour: how_to_answer + terms', /من هذا النص وحده/.test(r.how_to_answer) && /البصريان أبو عمرو ويعقوب/.test(r.terms));
check('badour: query and pages in the events', events.includes('library badour «يشعركم الانعام» → 108'), events.filter((e) => e.startsWith('library')).join(' | '));
r = await call('library_search', { book: 'nashr', query: 'يشعركم' });
check('nashr: note, no Badour terms', !!r.how_to_answer && !r.terms);
r = await call('library_search', { book: 'itqan', query: 'المكي والمدني' });
check('itqan: no qiraat note', !r.how_to_answer && !r.terms);
r = await call('library_search', { book: 'none', query: 'x' });
check('failed search: error passed through, no note', r.error === 'offline' && !r.how_to_answer, events.at(-1));

// 6. the declared tool and the prompt agree with the handler
const decl = (liveConfig('warsh').tools[0].functionDeclarations as any[]).find((f) => f.name === 'set_riwaya');
check('set_riwaya takes only riwaya', Object.keys(decl.parameters.properties).join() === 'riwaya' && decl.parameters.required.join() === 'riwaya');
const si = liveConfig('warsh').systemInstruction as string;
check('prompt: switch at once, ask only on doubt', /فاستدعِ set_riwaya فوراً دون أن تسألني/.test(si) && /«تمام» أو «تفضّل»/.test(si) && !/confirmed/.test(si));
check('prompt: «عن التطبيق» lists all 8 riwayat and every reciter', /## عن التطبيق/.test(si) && ['قنبل عن ابن كثير', 'العيون الكوشي', 'أحمد ديبان', 'عكاشة كميني'].every((w) => si.includes(w)));
check('prompt: no «راجع» introduced as a correction word', !/«راجِ?ع»/.test(si.replace('(«راجِع»، «انتبه»، «تمهّل»…)', '')));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
