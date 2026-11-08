// The words Google spells differently from the KFGQPC text (2026-11-08 data audit): spokenForm gives the spelling a
// transcript has, so the word can count as exact and the breath guard can work on its stretch. And the fath's MPEG
// header reader: the bitrate of each file, MPEG-1, 2 and 2.5 (Husary-Warsh 64 kbps MPEG-2.5, Hudhaifi-Shouba 96 kbps
// MPEG-2: before, no frame was found and the fath stayed silent).
// Build: client/node_modules/.bin/esbuild test/spoken_form.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/spoken.mjs
// Run:   node /tmp/hw/spoken.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { spokenForm, PositionTracker, rangeFrom } from '../client/src/live/reference';
import { normalizeTranscript as n, normalizeArabic } from '../client/src/utils/arabic';
import { frameAt, firstFrame } from '../client/src/live/fath';

let fails = 0;
const check = (label: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${JSON.stringify(info)}`);
  fails += +!ok;
};
const cases: [string, string, string][] = [
  ['2:47 شَئْا', 'شَئْاٗ', 'شيئا'],
  ['2:80 سَيِّئَة', '\u0633\u064e\u064a\u0651\u0650\u064a\u0654\u064e\u0629\u0657', 'سيئه'],
  ['2:30 أَنۢبِـُٔونِے', 'أَنۢبِـُٔونِے', 'انبئوني'],
  ['2:14 يَسْتَهْزِۓُ', 'يَسْتَهْزِۓُ', 'يستهزئ'],
  ['6:78 رَءَا', 'رَءَا', 'راي'],
  ['3:11 ءَالِ', 'ءَالِ', 'ال'],
  ['الصَّلَوٰةَ', 'الصَّلَوٰةَ', 'الصلاه'],
  ['هَٰذَا (as before)', 'هَٰذَا', 'هذا'],
];
for (const [label, printed, said] of cases) {
  const v = spokenForm(printed);
  check(`${label}: as Google writes «${said}»`, v === n(said), { v, want: n(said) });
}
check('a word without these marks: no second form', spokenForm('كَتَبَ') === undefined, spokenForm('كَتَبَ'));
// 7:206 in Hafs: the sajda sign glued to the last word is gone from c
check('«يَسْجُدُونَ۩» normalizes to «يسجدون»', normalizeArabic('يَسْجُدُونَ۩') === 'يسجدون', normalizeArabic('يَسْجُدُونَ۩'));
check('ZWJ dropped (17:7 Doori)', normalizeArabic('ليس‍وا') === 'ليسوا', normalizeArabic('ليس‍وا'));
// every c is still normalizeArabic(t), in all 8 riwayat
for (const k of ['warsh', 'qaloon', 'hafs', 'shouba', 'doori', 'soosi', 'bazzi', 'qumbul']) {
  const q: any[] = JSON.parse(readFileSync(`client/public/riwayat/${k}/quran.json`, 'utf8'));
  const bad = q.filter((x) => normalizeArabic(x.t) !== x.c);
  check(`${k}: c = normalizeArabic(t) in every ayah`, bad.length === 0, bad.slice(0, 2).map((x) => `${x.s}:${x.a}`));
  check(`${k}: no ۩ or ZWJ left in c`, !q.some((x) => /[۩‌‍ٮ]/.test(x.c)), '');
}
// the tracker: 2:47 read with Google's «شيئا» is exact (the breath guard can count it)
{
  const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 2, 47));
  const r: any = t.feed('واتقوا يوما لا تجزي نفس عن نفس شيئا ولا يقبل ');
  check('2:47 with «شيئا»: followed', t.matched >= 9, { matched: t.matched, r: JSON.stringify(r).slice(0, 120) });
}
// MPEG frame headers
const hdr = (b1: number, b2: number) => new Uint8Array([0xff, b1, b2, 0x00]);
check('MPEG-1 128 kbps 44.1 kHz: 417 bytes', JSON.stringify(frameAt(hdr(0xfb, 0x90), 0)) === '{"kbps":128,"len":417}', frameAt(hdr(0xfb, 0x90), 0));
check('MPEG-2.5 64 kbps 11.025 kHz (Husary-Warsh)', JSON.stringify(frameAt(hdr(0xe3, 0x80), 0)) === '{"kbps":64,"len":417}', frameAt(hdr(0xe3, 0x80), 0));
check('MPEG-2 96 kbps 22.05 kHz (Hudhaifi-Shouba)', JSON.stringify(frameAt(hdr(0xf3, 0xa0), 0)) === '{"kbps":96,"len":313}', frameAt(hdr(0xf3, 0xa0), 0));
check('MPEG-1 320 kbps 44.1 kHz', frameAt(hdr(0xfb, 0xe0), 0)?.kbps === 320, frameAt(hdr(0xfb, 0xe0), 0));
check('reserved version: not a frame', frameAt(hdr(0xeb, 0x90), 0) === null, frameAt(hdr(0xeb, 0x90), 0));
{
  const b = new Uint8Array(3 + 313 * 2 + 4);
  b.set([1, 2, 3]);
  b.set([0xff, 0xf3, 0xa0, 0], 3);
  b.set([0xff, 0xf3, 0xa0, 0], 3 + 313);
  check('firstFrame finds an MPEG-2 frame after junk', firstFrame(b) === 3, firstFrame(b));
}
process.exit(fails ? 1 : 0);
