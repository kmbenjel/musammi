import {
  CompactAyah,
  loadQuranData,
  loadMutashabihatData,
  getSurahByNo,
} from './quranData';
import { normalizeTranscript } from '../utils/arabic';

export type QuestionType =
  | 'continue_ayah' // (a) continue from start of ayah for N ayat
  | 'before_ayah' // (b) recite the ayah that comes before
  | 'juz_start' // (c) recite the beginning of a given juz / surah
  | 'mutashabihat' // (d) continue correct mutashabih without drifting
  | 'where_is_this'; // (e) name the surah of a shown ayah

export interface TestQuestion {
  id: string;
  type: QuestionType;
  typeName: string;
  surahNo: number;
  surahNameAr: string;
  ayahNo: number;
  pageNo: number;
  juzNo: number;
  cueText: string; // Shown on screen in Warsh font (first 3-5 words)
  expectedText: string; // The full expected answer for the model to judge
  expectedAyatList: CompactAyah[];
  userScoreStatus?: 'first_time' | 'after_aid' | 'after_fath' | 'failed';
  mistakeCount?: number;
}

/** Does the cue open the ayah? (Some mutashabih phrases sit in the middle of an ayah.) */
function startsAyah(ayah: string, cue: string): boolean {
  const words = (t: string) => normalizeTranscript(t).split(' ').filter(Boolean);
  const [a, c] = [words(ayah), words(cue)];
  return c.length > 0 && c.every((w, i) => a[i] === w);
}

/**
 * Returns a secure random integer in [min, max] inclusive
 */
function getRandomInt(min: number, max: number): number {
  const range = max - min + 1;
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return min + (array[0] % range);
}

/**
 * Generates an authentic, rigorous exam of N questions spread far apart
 */
export async function generateTestExam(options: {
  questionCount?: number;
  scopeType?: 'all' | 'juz' | 'surahs';
  selectedJuz?: number[];
  selectedSurahs?: number[];
  allowedTypes?: QuestionType[];
}): Promise<TestQuestion[]> {
  const count = options.questionCount ?? 10;
  const quran = await loadQuranData();
  const mutashabihat = await loadMutashabihatData();

  // Every question stays inside the scope («اختبرني في سورة الكهف / في جزء عمّ»), however small it is
  const juzScope = options.scopeType === 'juz' && options.selectedJuz?.length ? options.selectedJuz : null;
  const surahScope = options.scopeType === 'surahs' && options.selectedSurahs?.length ? options.selectedSurahs : null;
  const within = (s: number, j: number) => (!juzScope || juzScope.includes(j)) && (!surahScope || surahScope.includes(s));
  const inScope = quran.some((a) => within(a.s, a.j)) ? within : () => true; // no such surah/juz: the whole mushaf
  const pool = quran.filter((a) => inScope(a.s, a.j));

  // mutashabihat asked from the beginning of an ayah, never from its middle
  const mutaOccs = mutashabihat.flatMap((g) =>
    g.occurrences.filter((o) => inScope(o.sura, o.juz) && startsAyah(o.full_text, g.cue)).map((occ) => ({ g, occ })),
  );
  const juzFirsts = quran.filter((a, i) => (i === 0 || quran[i - 1].j !== a.j) && inScope(a.s, a.j));

  const enabledTypes: QuestionType[] = (
    options.allowedTypes && options.allowedTypes.length > 0
      ? options.allowedTypes
      : (['continue_ayah', 'before_ayah', 'juz_start', 'mutashabihat', 'where_is_this'] as QuestionType[])
  ).filter(
    (t) =>
      !(t === 'juz_start' && !juzFirsts.length) &&
      !(t === 'mutashabihat' && !mutaOccs.length) &&
      !(t === 'where_is_this' && surahScope?.length === 1), // the answer would be the scope itself
  );
  const asked = new Set<string>();

  const usedPages = new Set<number>();
  const questions: TestQuestion[] = [];

  // Helper to get first N words
  const getCue = (text: string, wordsCount = 4): string => {
    const parts = text.split(/\s+/).filter(Boolean);
    return parts.slice(0, wordsCount).join(' ');
  };

  for (let round = 0; round < count; round++) {
    const type = enabledTypes[round % enabledTypes.length];
    let candidateQuestion: TestQuestion | null = null;
    let attempts = 0;

    while (!candidateQuestion && attempts < 100) {
      attempts++;
      const randIdx = getRandomInt(0, pool.length - 1);
      const targetAyah = pool[randIdx];

      // Enforce spread: no two from the same page
      if (usedPages.has(targetAyah.p) && pool.length > count * 3) {
        continue;
      }

      const surah = getSurahByNo(targetAyah.s);
      const surahName = surah?.name_ar || `سورة ${targetAyah.s}`;

      if (type === 'continue_ayah') {
        // Continue for 3 ayat
        const nextAyat = quran.filter(
          (a) => a.s === targetAyah.s && a.a >= targetAyah.a && a.a < targetAyah.a + 3
        );
        if (nextAyat.length >= 2) {
          const cue = getCue(targetAyah.t, 4);
          const expected = nextAyat.map((a) => a.t).join(' ');
          candidateQuestion = {
            id: `q-${round}-${targetAyah.id}`,
            type: 'continue_ayah',
            typeName: 'أكمل من بداية الآية',
            surahNo: targetAyah.s,
            surahNameAr: surahName,
            ayahNo: targetAyah.a,
            pageNo: targetAyah.p,
            juzNo: targetAyah.j,
            cueText: cue,
            expectedText: expected,
            expectedAyatList: nextAyat,
          };
        }
      } else if (type === 'before_ayah') {
        // Recite the ayah that comes before
        if (targetAyah.a > 1) {
          const prevAyah = quran.find((a) => a.s === targetAyah.s && a.a === targetAyah.a - 1);
          if (prevAyah && inScope(prevAyah.s, prevAyah.j)) {
            const cue = `اقرأ الآية التي تسبق: ${getCue(targetAyah.t, 5)}...`;
            candidateQuestion = {
              id: `q-${round}-${targetAyah.id}`,
              type: 'before_ayah',
              typeName: 'اقرأ الآية السابقة',
              surahNo: targetAyah.s,
              surahNameAr: surahName,
              ayahNo: targetAyah.a,
              pageNo: targetAyah.p,
              juzNo: targetAyah.j,
              cueText: cue,
              expectedText: prevAyah.t,
              expectedAyatList: [prevAyah],
            };
          }
        }
      } else if (type === 'juz_start') {
        // Recite beginning of a juz
        // the target's juz, or (a surah scope that holds no start of the target's juz) a juz opening inside the scope
        const juzFirstAyah = juzFirsts.find((a) => a.j === targetAyah.j) ?? juzFirsts[getRandomInt(0, juzFirsts.length - 1)];
        if (juzFirstAyah) {
          const nextAyat = quran.filter(
            (a) => a.s === juzFirstAyah.s && a.a >= juzFirstAyah.a && a.a < juzFirstAyah.a + 2
          );
          const sMeta = getSurahByNo(juzFirstAyah.s);
          candidateQuestion = {
            id: `q-${round}-${juzFirstAyah.id}`,
            type: 'juz_start',
            typeName: 'بداية الجزء',
            surahNo: juzFirstAyah.s,
            surahNameAr: sMeta?.name_ar || `سورة ${juzFirstAyah.s}`,
            ayahNo: juzFirstAyah.a,
            pageNo: juzFirstAyah.p,
            juzNo: juzFirstAyah.j,
            cueText: `افتتاح الجزء ${juzFirstAyah.j} (سورة ${sMeta?.name_ar})`,
            expectedText: nextAyat.map((a) => a.t).join(' '),
            expectedAyatList: nextAyat,
          };
        }
      } else if (type === 'mutashabihat') {
        // Mutashābihāt: pick a group
        if (mutaOccs.length > 0) {
          const { g: mGroup, occ } = mutaOccs[getRandomInt(0, mutaOccs.length - 1)];
          const sMeta = getSurahByNo(occ.sura);
          candidateQuestion = {
            id: `q-${round}-${occ.sura}-${occ.aya}`,
            type: 'mutashabihat',
            typeName: 'المتشابهات (واصِل بدون خلط)',
            surahNo: occ.sura,
            surahNameAr: sMeta?.name_ar || `سورة ${occ.sura}`,
            ayahNo: occ.aya,
            pageNo: occ.page,
            juzNo: occ.juz,
            cueText: `«${mGroup.cue}» في سورة ${sMeta?.name_ar}`,
            expectedText: occ.full_text,
            expectedAyatList: [
              {
                id: 0,
                s: occ.sura,
                a: occ.aya,
                p: occ.page,
                j: occ.juz,
                h: null,
                th: null,
                t: occ.full_text,
                c: '',
              },
            ],
          };
        }
      } else if (type === 'where_is_this') {
        // "Where is this?": Name the surah
        candidateQuestion = {
          id: `q-${round}-${targetAyah.id}`,
          type: 'where_is_this',
          typeName: 'أين هذا الموضع؟ (اذكر اسم السورة)',
          surahNo: targetAyah.s,
          surahNameAr: surahName,
          ayahNo: targetAyah.a,
          pageNo: targetAyah.p,
          juzNo: targetAyah.j,
          cueText: targetAyah.t,
          expectedText: `سورة ${surahName}`,
          expectedAyatList: [targetAyah],
        };
      }

      // a small scope: the same question twice only when nothing else is found
      const key = candidateQuestion && candidateQuestion.id.replace(/^q-\d+-/, candidateQuestion.type + ':');
      if (key && asked.has(key) && attempts < 50) candidateQuestion = null;
      else if (key) asked.add(key);
    }

    if (candidateQuestion) {
      usedPages.add(candidateQuestion.pageNo);
      questions.push(candidateQuestion);
    }
  }

  return questions;
}
