/**
 * Arabic RTL & Text Utilities for Warsh Quran
 */

// Eastern Arabic-Indic numerals (١٢٣)
export function toArabicIndic(num: number | string | null | undefined): string {
  if (num === null || num === undefined) return '';
  const digits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return String(num).replace(/\d/g, (d) => digits[parseInt(d, 10)]);
}

/**
 * Normalizes Arabic text for transcription matching and alignment
 * Strips tashkeel, waqf, warsh marks, unifies alifs and yaas
 */
export function normalizeArabic(text: string): string {
  if (!text) return '';
  let s = text.trim();
  // Remove ayah numbers (arabic indic digits or ascii) everywhere
  s = s.replace(/[\u0660-\u0669\d]+/g, '');
  // Remove waqf signs and rub el hizb
  s = s.replace(/[\u06D6-\u06DB\u06DE\xa0]/g, ' ');
  // Convert dagger alif to regular alif to match spoken phonetic transcription
  s = s.replace(/\u0670/g, 'ا');
  // Remove all diacritics including warsh marks
  s = s.replace(/[\u0610-\u061A\u064B-\u065F\u06DC\u06DF-\u06E8\u06EA-\u06ED\u200f\u200e\u0640]/g, '');
  // Unify alifs
  s = s.replace(/[إأآٱ]/g, 'ا');
  // Unify yaa / alif maqsoora
  s = s.replace(/[ىيۦے]/g, 'ي');
  // Unify taa marbuta to haa
  s = s.replace(/ة/g, 'ه');
  // Standardize Rahman spelling
  s = s.replace(/الرحمان/g, 'الرحمن');
  // Collapse whitespace
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes speech transcript for soft matching
 */
export function normalizeTranscript(text: string): string {
  return normalizeArabic(text)
    .replace(/[،.؟!:;]/g, '')
    .trim();
}
