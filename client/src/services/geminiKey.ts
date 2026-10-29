// The reciter's own Gemini key from Google AI Studio (everyone but the owner, who opens the app with his private
// link). It is kept in this browser and sent only to Google, which mints the session's ephemeral token with the
// same setup as the Worker (live/token.ts, loaded on first use with the Google SDK).
import type { RiwayaKey } from '../live/riwayat';

const STORE = 'musammi_gemini_key';
// The same words as the session's (session.ts compares them to end the session instead of retrying).
const QUOTA_MSG = 'انتهت الحصة المجانية من Gemini لهذا اليوم. تتجدّد غداً إن شاء الله.';

export function loadGeminiKey(): string | null {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

export function saveGeminiKey(key: string | null) {
  try {
    if (key) localStorage.setItem(STORE, key);
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: the key lasts this visit only */
  }
}

/** Google's refusal, in the reciter's words. */
function why(e: unknown): string {
  const msg = String((e as Error)?.message || e);
  if (/API_KEY_INVALID|API key not valid|API_KEY_|PERMISSION_DENIED|UNAUTHENTICATED|"code":\s*40[13]/i.test(msg))
    return 'رفضت Google هذا المفتاح. تأكّد أنك نسخته كاملاً، أو أنشئ مفتاحاً جديداً.';
  if (/quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded|"code":\s*429/i.test(msg)) return QUOTA_MSG;
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'تعذّر الوصول إلى Google. تحقّق من اتصالك بالإنترنت.';
  return 'تعذّر إصدار تصريح الاتصال من Google: ' + msg.slice(0, 160);
}

/** The session's token, minted in this browser with the reciter's key. */
export async function tokenWithOwnKey(apiKey: string, handle: string | null, riwaya: RiwayaKey) {
  const { mintToken } = await import('../live/token');
  try {
    return await mintToken(apiKey, { riwaya, handle });
  } catch (e) {
    throw new Error(why(e));
  }
}

/** Checks a pasted key by minting a token with it (free: no Live session is opened). null = the key works. */
export async function checkGeminiKey(apiKey: string): Promise<string | null> {
  try {
    await tokenWithOwnKey(apiKey, null, 'warsh');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
