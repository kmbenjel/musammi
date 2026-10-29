// The app on Cloudflare, so it works with the laptop off (deployed with `npx wrangler deploy`).
//
// - Static app (client/dist, incl. riwayat data and Ibn Juzay's tafsir under /tafsir/) via the ASSETS binding.
// - /api/live/token: the ephemeral Gemini Live token, with the session prompt for the chosen riwaya (the owner's
//   key; everyone else brings their own key and mints the same token in the browser, see client/src/live/token.ts).
// - /api/sessions: finished sessions kept in KV; the laptop copies them into sessions/ (scripts/pull_sessions.mjs).
// - /api/tafsir, /api/library: Ibn Juzay from the static files, open to everyone; everything else from the laptop's
//   local Shamela (LIBRARY_ORIGIN, through the tunnel) when the laptop is on, for the owner only.
import { mintToken } from '../client/src/live/token';

interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
  SESSIONS: KVNamespace;
  GEMINI_API_KEY: string;
  ACCESS_KEY: string;
  LIVE_MODEL?: string;
  LIBRARY_ORIGIN: string; // the laptop server, e.g. https://hifz.benjelloun.dev (the tunnel)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const QUOTA_MSG = 'انتهت الحصة المجانية من Gemini لهذا اليوم. تتجدّد غداً إن شاء الله.';
const OFFLINE_MSG = 'هذا الكتاب في مكتبة الحاسوب، والحاسوب مطفأ الآن. ابن جُزَيّ متاح دائماً.';
// Without the private link (a reciter with their own Gemini key): the laptop's library is not theirs to reach.
const PRIVATE_MSG = 'هذا الكتاب ليس في هذه النسخة من التطبيق: مكتبة الشاملة على حاسوب صاحبه.';

function keyOk(req: Request, env: Env): boolean {
  const given = req.headers.get('X-Access-Key') || '';
  if (!env.ACCESS_KEY || given.length !== env.ACCESS_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.ACCESS_KEY.charCodeAt(i);
  return diff === 0;
}

async function token(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { handle?: string; riwaya?: string };
  try {
    const t = await mintToken(env.GEMINI_API_KEY, { riwaya: body.riwaya, handle: body.handle, model: env.LIVE_MODEL });
    return json({ ok: true, token: t.token, model: t.model });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const quota = /quota|RESOURCE_EXHAUSTED|rate limit|429/i.test(msg);
    return json({ ok: false, error: quota ? QUOTA_MSG : 'تعذّر إصدار تصريح الاتصال المباشر' }, quota ? 429 : 500);
  }
}

/** Forward to the laptop's server (local Shamela); a short timeout so a sleeping laptop fails fast. */
async function viaLaptop(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    const r = await fetch(env.LIBRARY_ORIGIN + url.pathname + url.search, {
      headers: { 'X-Access-Key': env.ACCESS_KEY },
      signal: AbortSignal.timeout(12000),
    });
    if (r.status >= 502) throw new Error('laptop off'); // Cloudflare's own error for an idle tunnel
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch {
    return json({ ok: false, error: OFFLINE_MSG }, 503);
  }
}

async function tafsir(req: Request, env: Env, url: URL, authed: boolean): Promise<Response> {
  const book = url.searchParams.get('book') || 'ibn_juzay';
  const hafs = Number(url.searchParams.get('hafs'));
  if (book !== 'ibn_juzay') return authed ? viaLaptop(req, env, url) : json({ ok: false, error: PRIVATE_MSG }, 403);
  if (!hafs) return json({ ok: false, error: 'لا توجد هذه الآية' }, 404);
  const index = await (await env.ASSETS.fetch(new URL('/tafsir/hafs_surah.json', url))).json<number[]>();
  const surah = index[hafs];
  const r = await env.ASSETS.fetch(new URL(`/tafsir/ibn_juzay/${surah}.json`, url));
  if (!r.ok || !r.headers.get('content-type')?.includes('json')) {
    // not exported (yet): the owner's laptop has it; a copy built from the public repo may not
    return authed ? viaLaptop(req, env, url) : json({ ok: false, error: 'تفسير ابن جُزَيّ غير مثبَّت في هذه النسخة من التطبيق.' }, 404);
  }
  const d = await r.json<{ book: string; author: string; ayat: Record<string, { text: string; part: string; page: number }> }>();
  const a = d.ayat[hafs];
  if (!a) return json({ ok: false, error: 'لا يوجد كلام لابن جُزَيّ على هذه الآية' }, 404);
  return json({ ok: true, book: d.book, author: d.author, part: a.part, page: a.page, text: a.text });
}

async function sessions(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { at?: number; lines?: unknown[]; events?: unknown[] } | null;
    if (!body) return json({ ok: false }, 400);
    const at = Number(body.at) || Date.now();
    // the whole session is sent; a KV value is at most 25 MB, so a (very) long one loses its oldest events, then lines
    let value = JSON.stringify(body);
    while (new TextEncoder().encode(value).length > 20_000_000 && (body.events?.length || body.lines?.length)) {
      if (body.events?.length) body.events.splice(0, Math.ceil(body.events.length / 4));
      else body.lines!.splice(0, Math.ceil(body.lines!.length / 4));
      value = JSON.stringify(body);
    }
    await env.SESSIONS.put(`s:${new Date(at).toISOString()}`, value);
    return json({ ok: true });
  }
  // GET: the laptop pulls what it does not have yet (?after=<last key>)
  const after = url.searchParams.get('after') || '';
  const list = await env.SESSIONS.list({ prefix: 's:', limit: 200 });
  const keys = list.keys.map((k) => k.name).filter((k) => k > after);
  const items = await Promise.all(keys.map(async (k) => ({ key: k, value: await env.SESSIONS.get(k, 'json') })));
  return json({ ok: true, items });
}

async function manifest(env: Env, url: URL): Promise<Response> {
  const m = await (await env.ASSETS.fetch(new URL('/manifest.json', url))).json<Record<string, unknown>>();
  const k = url.searchParams.get('k') || '';
  if (env.ACCESS_KEY && k === env.ACCESS_KEY) m.start_url = '/?k=' + encodeURIComponent(k);
  return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/manifest+json' } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/manifest.json' && url.searchParams.has('k')) return manifest(env, url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const authed = keyOk(req, env);
    if (url.pathname === '/api/tafsir') return tafsir(req, env, url, authed); // Ibn Juzay is static: open to all
    if (url.pathname === '/api/library' && !authed) return json({ ok: false, error: PRIVATE_MSG }, 403);
    if (!authed) return json({ ok: false, error: 'افتح التطبيق من رابطك الخاص مرة واحدة' }, 401);
    if (url.pathname === '/api/live/token' && req.method === 'POST') return token(req, env);
    if (url.pathname === '/api/library') return viaLaptop(req, env, url);
    if (url.pathname === '/api/sessions') return sessions(req, env, url);
    return json({ ok: false, error: 'Endpoint not found' }, 404);
  },
};
