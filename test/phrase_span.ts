// play_recitation from a phrase: finding the words named (inside an ayah, Hafs forms, ambiguous) and the span in
// the recording from the word timings (client/public/riwayat/warsh/words/laayoun-kouchi, al-Kouchi).
// Build: client/node_modules/.bin/esbuild test/phrase_span.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/phrase.mjs
// Run:   node /tmp/hw/phrase.mjs   (from the repo root; exit 1 on a failure)
import { existsSync, readFileSync } from 'node:fs';
import { bestHits, findPhrase } from '../client/src/live/phrase';
import { jumlaOf, recitationSpan, wordsSpan, type AyahWords } from '../client/src/live/audio';
import type { Ayah, HafsDiffs, SurahInfo } from '../client/src/live/reference';

const R = 'client/public/riwayat/warsh/';
const quran: Ayah[] = JSON.parse(readFileSync(R + 'quran.json', 'utf8'));
const diffs: HafsDiffs = JSON.parse(readFileSync(R + 'diff.json', 'utf8'));
const surahs: SurahInfo[] = JSON.parse(readFileSync(R + 'surahs.json', 'utf8'));
const words = (s: number): AyahWords[] => JSON.parse(readFileSync(`${R}words/laayoun-kouchi/${String(s).padStart(3, '0')}.json`, 'utf8'));

// the app's files as the browser gets them; a missing one is index.html (SPA fallback), as al-Kahf's word timings
// are made to be here; mp3quran's ayah timings faked
(globalThis as any).fetch = async (url: string) => {
  if (url.startsWith('https://www.mp3quran.net/api/v3/ayat_timing')) {
    const s = Number(new URL(url).searchParams.get('surah'));
    const ayat = quran.filter((x) => x.s === s);
    return { ok: true, json: async () => ayat.map((x, i) => ({ ayah: x.a, start_time: 1000 * i + 500, end_time: 1000 * i + 1500 })) };
  }
  const path = 'client/public' + url;
  const body = existsSync(path) && !url.endsWith('/018.json') ? readFileSync(path, 'utf8') : '<!doctype html><html></html>';
  return { ok: true, json: async () => JSON.parse(body) };
};

let fails = 0;
const check = (label: string, ok: boolean, info: unknown = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${typeof info === 'string' ? info : JSON.stringify(info)}`);
  fails += +!ok;
};
const at = (h: { ayah: Ayah; word: number }) => `${h.ayah.s}:${h.ayah.a}#${h.word}`;

// ── finding the phrase ──
let h = findPhrase(quran, diffs, 'وجعلناها رجوما للشياطين', { surah: 67, ayah: 5 });
check('inside an ayah (67:5, from its 6th word)', h.length === 1 && at(h[0]) === '67:5#5' && h[0].last.word === 7, h.map(at));
h = findPhrase(quran, diffs, 'وجعلناها رجوما للشياطين');
check('same phrase, whole mushaf', bestHits(h).length === 1 && at(h[0]) === '67:5#5', h.map(at));
h = findPhrase(quran, diffs, 'قوله تعالى ولقد زينا السماء الدنيا بمصابيح', { surah: 67 });
check('«قوله تعالى» dropped', at(h[0]) === '67:5#0' && h[0].score > 0.95, h.map(at));
h = findPhrase(quran, diffs, 'مالك يوم الدين');
check('Hafs form «مالك» (Warsh «ملك»)', at(h[0]) === '1:3#0', h.slice(0, 3).map(at));
h = findPhrase(quran, diffs, 'نغفر لكم خطاياكم', { surah: 2 });
check('Hafs form «نغفر» (Warsh «يغفر», 2:57 in the Madani count)', at(h[0]) === '2:57#15', h.slice(0, 3).map((x) => [at(x), x.score.toFixed(2)]));
h = findPhrase(quran, diffs, 'لا اكراه في الدين');
check('Warsh 2:255 = Hafs 2:256', at(h[0]) === '2:255#0', h.slice(0, 2).map(at));
h = findPhrase(quran, diffs, 'ثم ارجع البصر كرتين ينقلب اليك البصر');
check('transcription without hamzat al-wasl marks', at(h[0]) === '67:4#0', h.map(at));
h = bestHits(findPhrase(quran, diffs, 'فبأي آلاء ربكما تكذبان', { surah: 55 }));
check('ambiguous in a surah (Rahman refrain)', h.length >= 30, h.length);
h = bestHits(findPhrase(quran, diffs, 'ان الله غفور رحيم'));
check('ambiguous in the mushaf', h.length > 5, h.length);
check('nonsense is not found', findPhrase(quran, diffs, 'الحاسوب المحمول الجديد').length === 0);

// ── the span in the recording (pilot: al-Mulk) ──
const mulk = words(67);
const a5 = mulk.find((x) => x.a === 5)!;
let sp = wordsSpan(mulk, { ayah: 5, word: 5 }, { ayah: 5, word: 7 }, 'word')!;
const lead = (x: AyahWords, k: number) => Math.max(30, Math.min(100, x.g[k]!));
check('exact word: just before its onset, not into the word before', Math.abs(sp.start * 1000 - (a5.w[5]! - lead(a5, 5))) < 1 && sp.start * 1000 > a5.w[4]!, sp);
check('…through word 7: ends before word 8', Math.abs(sp.end * 1000 - (a5.w[8]! - lead(a5, 8))) < 1, sp);
sp = wordsSpan(mulk, { ayah: 5, word: 5 }, undefined, 'word')!;
check('no end: to the end of the ayah', sp.end * 1000 === a5.e, sp);
const a3 = mulk.find((x) => x.a === 3)!;
sp = wordsSpan(mulk, { ayah: 3, word: 14 }, { ayah: 4 }, 'jumla')!;
check('jumla: back to the breath before «فَارْجِعِ» (67:3 word 12; he joins «طِبَاقاٗ مَّا» at the waqf mark)', sp.from.word === 12 && a3.j.includes(12) && sp.end * 1000 === mulk.find((x) => x.a === 4)!.e, sp);
sp = wordsSpan(mulk, { ayah: 5, word: 7 }, undefined, 'jumla')!;
check('jumla with no breath before in the ayah: the ayah start', sp.from.word === 0 && sp.start * 1000 === a5.w[0], sp);
sp = wordsSpan(mulk, { ayah: 3, word: 12 }, undefined, 'jumla')!;
check('jumla at a breath word: that word', sp.from.word === 12, sp);
check('end before start → null', wordsSpan(mulk, { ayah: 5, word: 5 }, { ayah: 4 }, 'word') === null);
const gap = structuredClone(mulk);
gap.find((x) => x.a === 5)!.w[5] = null;
sp = wordsSpan(gap, { ayah: 5, word: 5 }, undefined, 'word')!;
check('a word with no time: from the word before it', sp.from.word === 4, sp);
const baqara = words(2);
const b255 = baqara.find((x) => x.a === 255)!;
sp = wordsSpan(baqara, { ayah: 255, word: 11 }, undefined, 'jumla')!;
check('jumla in 2:255 (breath at word 9, «فَمَنْ يَّكْفُرْ»)', sp.from.word === 9 && b255.j.includes(9), sp);
check('jumlaOf: 2:255 word 11 is in the jumla 9…', JSON.stringify(jumlaOf(b255, 11)) === JSON.stringify({ first: 9, next: b255.j.find((x) => x > 9) ?? b255.w.length }), jumlaOf(b255, 11));
sp = wordsSpan(mulk, { ayah: 3, word: 0 }, { ayah: 3, word: 2 }, 'jumla', 'jumla')!;
check('until jumla: 67:3 from its start to the end of its first jumla (before word 12)', Math.abs(sp.end * 1000 - (a3.w[12]! - lead(a3, 12))) < 1, sp);
check('default is jumla-first', wordsSpan(mulk, { ayah: 3, word: 14 }, undefined)!.from.word === 12);
// every ayah of the pilot surahs: jumla starts are sorted, start at 0, and play forward
let bad = 0;
for (const s of [1, 2, 3, 67]) for (const x of words(s)) {
  if (x.j[0] !== 0 || x.j.some((m, i) => i && m <= x.j[i - 1])) bad++;
  for (const k of x.j) { const r = wordsSpan(words(s), { ayah: x.a, word: k }, undefined); if (!r || r.end - r.start < 0.2) bad++; }
}
check('pilot surahs: jumla lists well-formed, every jumla span plays', bad === 0, bad);

// ── the tool call ──
const m = { key: 'warsh' as const, quran, diffs, surahs };
const run = async () => {
  let r = await recitationSpan(m, { surah: 67, from_ayah: 5, from_words: 'وجعلناها رجوما للشياطين' });
  check('tool: phrase in the ayah given', 'span' in r && r.span.start * 1000 === a5.w[5]! - lead(a5, 5) && r.span.url.endsWith('laayoun-kouchi/r1/067.mp3') && !r.note, r);
  r = await recitationSpan(m, { from_words: 'وجعلناها رجوما للشياطين', to_ayah: 6 });
  check('tool: no surah → found in the whole mushaf, to ayah 6', 'span' in r && r.span.end * 1000 === mulk.find((x) => x.a === 6)!.e, 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 67, from_ayah: 3, from_words: 'في خلق الرحمن', start_at: 'jumla' });
  check('tool: start_at jumla says where it starts', 'span' in r && r.note.includes('أول الجملة') && r.span.start * 1000 < a3.w[9]! - 1000, r);
  r = await recitationSpan(m, { surah: 67, from_ayah: 5, from_words: 'ولقد زينا السماء', to_words: 'رجوما للشياطين' });
  check('tool: to_words', 'span' in r && Math.abs(r.span.end * 1000 - (a5.w[8]! - lead(a5, 8))) < 1, r);
  r = await recitationSpan(m, { surah: 55, from_words: 'فبأي آلاء ربكما تكذبان' });
  check('tool: ambiguous → ask which', 'error' in r && r.error.includes('أكثر من موضع'), r);
  r = await recitationSpan(m, { surah: 55, from_ayah: 11, from_words: 'فبأي آلاء ربكما تكذبان' });
  check('tool: ambiguous but the ayah given', 'span' in r && r.span.url.endsWith('055.mp3'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 18, from_ayah: 10, from_words: 'ربنا آتنا من لدنك رحمة' });
  check('tool: no word timings for the surah → the ayah start, said', 'span' in r && r.note.includes('توقيت للكلمات') && r.span.start === 9.5, r);
  r = await recitationSpan(m, { surah: 67, from_ayah: 2, to_ayah: 4 });
  check('tool: plain ayat as before', 'span' in r && r.span.start === 1.5 && r.span.end === 4.5, r);
  r = await recitationSpan(m, { surah: 67, from_ayah: 9, from_words: 'وجعلناها رجوما للشياطين' });
  check('tool: wrong ayah given → found in the surah, said', 'span' in r && r.note.includes('الآية 5'), r);
  // what he said on 2026-10-30, with the range the model chose
  r = await recitationSpan(m, { surah: 23, from_ayah: 72, to_ayah: 119 }, 23, 'شغل الايه التي وقفت عندها');
  check('range: no end named → one ayah, said', 'span' in r && r.note.includes('الآية 72') && r.label.endsWith(' 72'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 65, to_ayah: 119 }, 23, 'واصل واصل، شغلي من قوله تعالى حتى اذا اخذنا مترفيهم بالعذاب');
  check('range: «حتى» of the verse names no end', 'span' in r && r.label.endsWith(' 65'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 2, from_ayah: 123, to_ayah: 144 }, 2, 'شغل من قوله تعالى واذ ابتلى ابراهيم ربه');
  check('range: from a place, no end → one ayah', 'span' in r && r.label.endsWith(' 123'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 1, to_ayah: 118 }, 23, 'شغل سورة المؤمنون');
  check('range: the whole surah stays whole', 'span' in r && !r.note && r.label.endsWith('1–118'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 76, to_ayah: 110 }, 23, 'شغل الى اخر السورة');
  check('range: «إلى آخر…» stays', 'span' in r && !r.note, r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 76, to_ayah: 90 }, 23, 'شغل عشرين آية');
  check('range: a number of ayat stays', 'span' in r && !r.note, r);
  r = await recitationSpan(m, { surah: 67, from_ayah: 2, to_ayah: 4 }, 67, 'شغل هذه');
  check('range: a short one too', 'span' in r && r.label.endsWith(' 2'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 10, from_ayah: 3, to_ayah: 4 }, 10, 'انا اريد ان تشغل في كل مرة ايتين فقط من سورة يونس. اكمل');
  check('range: a standing request holds', 'span' in r && !r.note && r.label.endsWith('3–4'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 65, to_ayah: 70, from_words: 'حتى اذا اخذنا مترفيهم' }, 23, 'شغل من قوله حتى اذا اخذنا مترفيهم');
  check('range: from words, no end → that ayah', 'span' in r && r.span.end > r.span.start && !r.label.includes('–'), 'label' in r ? r.label : r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 5, to_ayah: 8 }, 23, 'شغل من خمسه الى ثمانيه');
  check('range: an end said in words stays', 'span' in r && !r.note, r);
  r = await recitationSpan(m, { surah: 23, from_ayah: 50, to_ayah: 95 }, 23);
  check('range: last_read is not cut', 'span' in r && !r.note, r);
};
run().then(() => {
  console.log(fails ? `${fails} failing` : 'all ok');
  process.exit(fails ? 1 : 0);
});
