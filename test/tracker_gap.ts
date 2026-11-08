// PositionTracker after a transcript gap (words the transcript dropped), plus the skip/move cases placeStretch decides.
// Build: client/node_modules/.bin/esbuild test/tracker_gap.ts --bundle --platform=node --format=esm --outfile=/tmp/hw/gap.mjs
// Run:   node /tmp/hw/gap.mjs   (from the repo root; exit 1 on a failure)
import { readFileSync } from 'node:fs';
import { MushafLocator, PositionTracker, rangeFrom, readRunAfter } from '../client/src/live/reference';
import { normalizeTranscript as n } from '../client/src/utils/arabic';
const quran: any[] = JSON.parse(readFileSync('client/public/riwayat/warsh/quran.json', 'utf8'));
const words = (s: number, a: number) => n(quran.find((x) => x.s === s && x.a === a).c).split(' ').filter(Boolean);

function run(label: string, s: number, a: number, chunks: string[][], expect: (t: PositionTracker) => boolean) {
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, s, a));
  for (const c of chunks) t.feed(c.join(' ') + ' ');
  const p = t.position();
  const ok = expect(t);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: at ${p?.ayah.s}:${p?.ayah.a} word ${p?.word}, skipped=${JSON.stringify(t.skipped && [t.skipped.from.a, t.skipped.to.a, t.skipped.moved])}`);
  return ok;
}

let fails = 0;
// Baqara 281 (the longest ayah in the Warsh count, 128 words): recite 10 words, gap of 30 words, then 8 more words in 2 stretches
const b281 = words(2, 281);
fails += +!run('gap 30 words inside 2:281', 2, 281, [b281.slice(0, 10), b281.slice(40, 48), b281.slice(48, 56)],
  (t) => t.position()!.ayah.a === 281 && t.position()!.word === 56 && !t.skipped);
// gap of 20 words
fails += +!run('gap 20 words inside 2:281', 2, 281, [b281.slice(0, 10), b281.slice(30, 38)],
  (t) => t.position()!.word === 38 && !t.skipped);
// gap across an ayah end into the next ayah: Baqara 255 start → lose the end of 255 → 256 middle
const a255 = words(2, 255), a256 = words(2, 256);
fails += +!run('gap 255 → middle of 256', 2, 255, [a255.slice(0, 12), a256.slice(6, 14)],
  (t) => t.position()!.ayah.a === 256 && t.position()!.word === 14 && !t.skipped);
// small gap (handled by feed's window already)
fails += +!run('gap 5 words inside 2:281', 2, 281, [b281.slice(0, 10), b281.slice(15, 22)],
  (t) => t.position()!.word === 22);
// a real skip of 2+ ayat is still reported
const k = (a: number) => words(18, a);
fails += +!run('skip Kahf 1 mid → 4 mid (still a skip)', 18, 1, [k(1).slice(0, 7), k(4).slice(2, 9)],
  (t) => !!t.skipped && t.skipped.to.a === 4 && !t.skipped.moved);
// continuing normally is untouched
fails += +!run('plain continuation 2:281', 2, 281, [b281.slice(0, 10), b281.slice(10, 20), b281.slice(20, 30)],
  (t) => t.position()!.word === 30 && !t.skipped);
// going back a little (repetition after «أعد») is untouched
fails += +!run('repeat back in 2:281', 2, 281, [b281.slice(0, 20), b281.slice(14, 24)],
  (t) => t.position()!.word === 24 && !t.skipped);
// a deliberate move: a finished ayah, then the start of another one further on (followed silently)
const m = (a: number) => words(2, a);
fails += +!run('move: end of 2:255 → start of 2:258', 2, 255, [m(255).slice(0, 10), m(255).slice(10), m(258).slice(0, 8)],
  (t) => !!t.skipped && t.skipped.to.a === 258 && t.skipped.moved);
// one ayah left out while reciting on is a skip, not a move (recording 10-26 00:12: «لا، أنا قفزت الآية»)
fails += +!run('drop: end of 2:255 → start of 2:257', 2, 255, [m(255).slice(0, 10), m(255).slice(10), m(257).slice(0, 8)],
  (t) => !!t.skipped && t.skipped.to.a === 257 && !t.skipped.moved);
// Session 2026-11-02T20-16-30-207Z: the transcript lost «اولائك بالمومنين واذا دعوا» (24:45 end, 24:46 start); the
// rest of 24:46 «الي الله ورسوله ليحكم بينهم» is also in 24:49 and won there: a false skip and a «أعد»
const n24 = (a: number) => words(24, a);
fails += +!run('lost words before a phrase that 24:49 repeats', 24, 45, [n24(45).slice(0, 13), ['الى', 'الله', 'ورسوله', 'ليحكم', 'بينهم']],
  (t) => t.position()!.ayah.a === 46 && !t.skipped);
// a short ayah lost (80:3, 4 words) is followed silently: within feed's window, no skip is even seen
const r = (a: number) => words(80, a);
fails += +!run('short ayah lost: 80:2 → start of 80:4', 80, 1, [r(1), r(2), r(4)],
  (t) => !t.skipped || t.skipped.moved);

// Session 2026-10-29T06-13-24-561Z (Warsh): Hajj 5, «ذلك بأن الله هو الحق» (22:6) slips into 22:60 (same opening),
// «أعد» ×6, then back to 22:6–7. The tracker stayed in 22:60 and a fath of 22:60 came at the end of 22:7, three times.
const hajj = ['كتب عليه انه من تولاه', 'يضله ويهديه إلى عذاب', ' السعير يا أيها الناس إن كنتم في ريب من البعث', 'خلقناكم', 'ثم',
  'وانو كتر في الارحامنا', 'الى اجل مسمى ثم نخرجكم طفلا ثم لتبلغوا اشدكم ومنكم من يتوفى ومنكم من يرد',
  'ومنكم من يرد الى ارذل العمر لكي لا يعلم', ' من بعد علم شيئا', 'وترى الارض هامدة فاذا انزلنا عليها الماء اهتزت وربت',
  'اهتزت وربت وأنبتت', ' من كل زوج بهيج', 'ذلك بان الله هو الحق', 'ذلك بأن الله هو الحق وأن ما تدعون من دونه الباطل',
  'وان الله هو العلي الكبير', 'وان ما يدعون من دونه الباطل', 'لا اله الا الله', 'كبير', 'وان ما يدعون من دونه هو الباطل', 'وان',
  'ذلك بأن الله هو الحق', ' وأنه يحيي الموتى', 'وأنه على كل شيء', ' قدير وأن الساعة آتية', 'وان الله يبعث من في القبور.'];
const slips: string[] = [];
fails += +!run('Hajj: slip 22:6 → 22:60, «أعد», back to 22:6–7 (session 06-13)', 22, 4, hajj.map((l) => [l]),
  (t) => t.position()!.ayah.a === 8 && t.position()!.word === 0 && !t.midAyah());
// the same with the printed words: the return is followed as soon as it reads like 22:6, though it reads like 22:60 too
const h = (a: number) => words(22, a);
fails += +!run('Hajj: slip mid 22:6 → 22:60, back to the start of 22:6', 22, 5, [h(5), h(6).slice(0, 5), h(60).slice(5, 11), h(6).slice(0, 5)],
  (t) => t.position()!.ayah.a === 6 && t.position()!.word === 5);
// right after the slip (before he goes back), a fath is the words after the place he slipped from
const ayah6Next = (t: PositionTracker) => n(t.nextPhrase()).startsWith('وانه يحي');
fails += +!run('Hajj: fath after the slip is 22:6\'s', 22, 5, [h(5), h(6).slice(0, 5), h(60).slice(5, 11)],
  (t) => t.position()!.ayah.a === 60 && ayah6Next(t) && t.isNear('يحي'));
// … but once he reads on past the similar ayah, he is there
fails += +!run('Hajj: slip, then on into 22:61: fath from there', 22, 5, [h(5), h(6).slice(0, 5), h(60).slice(5), h(61).slice(0, 6)],
  (t) => t.position()!.ayah.a === 61 && n(t.nextPhrase()).startsWith(h(61)[6]));
// going back further than feed's 8 words (a repetition from the start of a long ayah) is followed
fails += +!run('repeat back 15 words in 2:281', 2, 281, [b281.slice(0, 20), b281.slice(20, 30), b281.slice(15, 25)],
  (t) => t.position()!.word === 25 && !t.skipped);
// a deliberate return to an earlier ayah is followed silently
fails += +!run('back: end of 2:256 → start of 2:255', 2, 255, [m(255), m(256), m(255).slice(0, 8)],
  (t) => t.position()!.ayah.a === 255 && t.position()!.word === 8 && !t.skipped);
// words read at two places behind (Hajj 3 = Hajj 8 in their first 8 words): not followed until they tell which
const upTo11 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(h).concat([h(11).slice(0, 12)]);
fails += +!run('back to a repeated phrase: wait', 22, 1, [...upTo11, h(3).slice(0, 8)],
  (t) => t.position()!.ayah.a === 11);
fails += +!run('… then its own words decide (22:3)', 22, 1, [...upTo11, h(3).slice(0, 8), h(3).slice(8)],
    (t) => t.position()!.ayah.a === 4 && t.position()!.word === 0);
// no fath from a place the last stretch does not read at
fails += +!run('off track: words from elsewhere do not leave a fath place', 22, 5, [h(5), h(6).slice(0, 5), ['وان', 'الله', 'عزيز', 'حكيم', 'قالوا', 'سبحانك']],
  (t) => !t.onTrack);
fails += +!run('on track after a plain stretch', 22, 5, [h(5), h(6).slice(0, 7)], (t) => t.onTrack && t.midAyah());
// the place is not confirmed yet (session 2026-10-30 06:38: opened at 23:1, he went on at 23:46; the screen kept «الآية 1»
// for 12 min; 07:15: restarted at 23:81, he read 23:52): the first clear stretch places him, ahead or behind
const mu = (a: number) => words(23, a);
fails += +!run('start: opened at 23:1, reads 23:47', 23, 1, [mu(47).slice(0, 6)],
  (t) => t.position()!.ayah.a === 47 && t.position()!.word === 6 && !t.skipped);
// restarted at 23:80, he reads 23:52 (behind, not in the range): the session's whole-mushaf locator places him
{
  const at = new MushafLocator(quran).locate(mu(52).slice(0, 10), (x) => x.s === 23 && x.a >= 79);
  const ok = at?.ayah.s === 23 && at.ayah.a === 52;
  console.log(`${ok ? 'OK  ' : 'FAIL'} start: restarted at 23:80, reads 23:52: locator → ${at?.ayah.s}:${at?.ayah.a}`);
  fails += +!ok;
}
// … but not on words that fit two places (Hajj 3 / 8 share their first 8 words)
fails += +!run('start: a refrain does not place him', 22, 1, [h(3).slice(0, 8)], (t) => t.position()!.ayah.a === 1);
// a stretch read right is shown as printed: vowelled words, the ayah number where an ayah ends (user, 2026-10-30)
{
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 23, 64));
  t.feed(mu(64).join(' ') + ' ' + mu(65).slice(0, 3).join(' ') + ' ');
  const p = t.printed(0, t.at());
  const ok = p.startsWith('بَلْ قُلُوبُهُمْ') && p.includes(' ٦٤ ') && p.endsWith('أَخَذْنَا');
  console.log(`${ok ? 'OK  ' : 'FAIL'} printed stretch: ${p}`);
  fails += +!ok;
}
{
  const t = new PositionTracker();
  t.setRange(rangeFrom(quran, 23, 1));
  const show = (label: string, said: string, want: string | undefined) => {
    const got = t.asPrinted(said);
    const ok = want === undefined ? got === undefined : !!got?.includes(want);
    console.log(`${ok ? 'OK  ' : 'FAIL'} teacher as printed, ${label}: ${got}`);
    fails += +!ok;
  };
  show('stray Hebrew letter (06:38 line 107)', '…بَل لَّا يَשْعُرُونَ.', 'يَشْعُرُونَۖ');
  show('wrong vowels, after «أعد» (06:38 line 68)', 'أَعِدْ: المُهْلِكِينَ.', 'أعِد: ');
  show('talk stays as said', 'أحسنت، بارك الله فيك', undefined);
  show('«أعد» alone stays', 'أعِد.', undefined);
  let run = readRunAfter(null, 23, 50, 52);
  run = readRunAfter(run, 23, 53, 55);
  run = readRunAfter(run, 23, 51, 52); // a repetition
  const kept = run.from === 50 && run.to === 55;
  const moved = readRunAfter(run, 23, 90, 91);
  const ok = kept && moved.from === 90 && moved.to === 91 && readRunAfter(moved, 24, 1, 2).s === 24;
  console.log(`${ok ? 'OK  ' : 'FAIL'} last run: ${JSON.stringify([run, moved])}`);
  fails += +!ok;
}
// A stretch read right and stopped for a breath: «أعد» is false there. Each case: the place, the stretches before, the last one.
{
  const pause = (label: string, s: number, a: number, before: string[], last: string, right: boolean, end = ' ') => {
    const t = new PositionTracker();
    t.setRange(rangeFrom(quran, s, a));
    for (const c of before) t.feed(c + ' ');
    const m = t.mark();
    t.feed(last + end);
    const ok = t.readRight(m) === right;
    console.log(`${ok ? 'OK  ' : 'FAIL'} breath: ${label}: right=${t.readRight(m)}`);
    fails += +!ok;
  };
  const w29 = words(29, 46);
  pause('stops at «بالذي» (29:46, the user 10-29 and 10-30)', 29, 46, [w29.slice(0, 12).join(' ')], 'وقولوا آمنا بالذي', true);
  pause('breath, then back over the last words (10-29 06:04)', 29, 46, ['ولا تجادلوا اهل الكتاب الا بالتي هي احسن الا'], 'الا بالتي هي احسن الا الذين ظلموا منهم', true);
  const w = words(2, 281);
  pause('stops mid-ayah after plain reading', 2, 281, [w.slice(0, 10).join(' ')], w.slice(10, 18).join(' '), true);
  pause('three words left out inside the stretch', 2, 281, [w.slice(0, 10).join(' ')], [...w.slice(10, 13), ...w.slice(16, 21)].join(' '), false);
  pause('one word left out', 2, 281, [w.slice(0, 10).join(' ')], [...w.slice(10, 13), ...w.slice(14, 19)].join(' '), false);
  pause('a word changed', 2, 281, [w.slice(0, 10).join(' ')], [...w.slice(10, 13), 'سبحان', ...w.slice(14, 19)].join(' '), false);
  pause('two words: too little to tell', 2, 281, [w.slice(0, 10).join(' ')], w.slice(10, 12).join(' '), false);
  pause('stopped at the end of the ayah: not a breath inside it', 67, 2, [], words(67, 2).join(' '), false);
  pause('slip into 24:14 from 24:21 (10-31)', 24, 21, [words(24, 21).slice(0, 22).join(' '), 'ولولا فضل الله عليكم ورحمته'], 'في الدنيا والاخره', false);
  pause('the last word still in feed\'s buffer, right', 2, 281, [w.slice(0, 10).join(' ')], w.slice(10, 15).join(' '), true, '');
  pause('the last word still in feed\'s buffer, wrong', 2, 281, [w.slice(0, 10).join(' ')], [...w.slice(10, 14), 'سبحان'].join(' '), false, '');
  pause('«إن الله خبير» then a stop', 40, 44, ['فستذكرون ما اقول لكم وافوض امري الى الله'], 'ان الله خبير', false, '');
  // 25:59 on 2026-11-08 00:34: «في ستة أيام» written «في 7 أيام», two false «أعد»
  pause('«7 أيام» for «ستة أيام» (25:59, 11-08)', 25, 59, ['الذي خلق السماوات والارض'], 'وما بينهما في 7 أيام ثم', true);
  pause('a figure where the mushaf has no number word', 2, 281, [w.slice(0, 10).join(' ')], [...w.slice(10, 13), '7', ...w.slice(14, 19)].join(' '), false);
  pause('«خبير» for «بصير» (40:44, 10-31)', 40, 44, ['فستذكرون ما اقول لكم'], 'وافوض امري الى الله ان الله خبير بالعباد', false);
}
console.log(fails ? `${fails} failing` : 'all ok');
process.exit(fails ? 1 : 0);
