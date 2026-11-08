// The app on Cloudflare, so it works with the laptop off (deployed with `npx wrangler deploy`).
//
// - Static app (client/dist, incl. riwayat data and Ibn Juzay's tafsir under /tafsir/) via the ASSETS binding.
// - /api/live/token: the ephemeral Gemini Live token, with the session prompt for the chosen riwaya (the owner's
//   key; everyone else brings their own key and mints the same token in the browser, see client/src/live/token.ts).
// - /api/sessions: sessions kept in KV, saved while they run (one key each); the laptop copies them into sessions/ (scripts/pull_sessions.mjs).
// - /api/audio: the owner's sessions' audio in R2, 15 s slices under the session's time (client/src/live/recorder.ts).
// - /api/tafsir, /api/library: Ibn Juzay from the static files, open to everyone; everything else from the laptop's
//   local Shamela (LIBRARY_ORIGIN, through the tunnel) when the laptop is on, for the owner (and his guests) only.
// - Guests: GUEST_KEYS (secret, comma-separated, each «g-<name>-<random>») open the app on the owner's Gemini key, for
//   people he lets try it. Their sessions are saved with `guest: <name>`; they cannot read sessions or keep audio.
// - The mushaf mode is the app at /mushaf (same origin: the same keys). Its first host, tarteel-warsh.benjelloun.dev
//   (wrangler.mushaf.toml), only sends there.
import { mintListenToken, mintToken } from '../client/src/live/token';

interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
  SESSIONS: KVNamespace;
  AUDIO?: R2Bucket; // without it the app records nothing
  GEMINI_API_KEY: string;
  ACCESS_KEY: string;
  GUEST_KEYS?: string;
  LIVE_MODEL?: string;
  LIBRARY_ORIGIN: string; // the laptop server, e.g. https://hifz.benjelloun.dev (the tunnel)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const QUOTA_MSG = 'انتهت الحصة المجانية من Gemini لهذا اليوم. تتجدّد غداً إن شاء الله.';
const OFFLINE_MSG = 'هذا الكتاب في مكتبة الحاسوب، والحاسوب مطفأ الآن. ابن جُزَيّ متاح دائماً.';
// Without the private link (a reciter with their own Gemini key): the laptop's library is not theirs to reach.
const PRIVATE_MSG = 'هذا الكتاب ليس في هذه النسخة من التطبيق: مكتبة الشاملة على حاسوب صاحبه.';

function same(given: string, key: string): boolean {
  if (!key || given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

/** Who the key is: the owner, a guest (by name), or nobody. */
function whoIs(req: Request, env: Env): { owner: true } | { guest: string } | null {
  const given = req.headers.get('X-Access-Key') || '';
  if (same(given, env.ACCESS_KEY)) return { owner: true };
  const guest = (env.GUEST_KEYS || '').split(',').map((k) => k.trim()).find((k) => k.startsWith('g-') && same(given, k));
  return guest ? { guest: guest.split('-')[1] || 'guest' } : null;
}

async function token(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { handle?: string; riwaya?: string; listen?: boolean; mode?: string };
  const mode = body.mode === 'mushaf' ? ('mushaf' as const) : undefined;
  try {
    const t = body.listen ? await mintListenToken(env.GEMINI_API_KEY) : await mintToken(env.GEMINI_API_KEY, { riwaya: body.riwaya, handle: body.handle, model: env.LIVE_MODEL, mode });
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

// A session is saved several times while it runs (every minute, when the app is hidden, at «إنهاء»), always under
// the same key s:<start time>, so each save overwrites the one before. The key's metadata keeps when it was last
// written (u, server time: what the laptop's pull goes by) and how far the session had got (end, the phone's time),
// so an older save that arrives late does not overwrite a newer one.
type Meta = { u?: number; end?: number };

/** A JSON body, gzipped by the app (so a long session fits a keepalive request) or not: gzip starts 1f 8b, JSON never does. */
async function readJson(req: Request): Promise<unknown> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}

async function sessions(req: Request, env: Env, url: URL, guest?: string): Promise<Response> {
  if (req.method === 'POST') {
    const body = (await readJson(req).catch(() => null)) as { at?: number; end?: number; lines?: unknown[]; events?: unknown[]; guest?: string } | null;
    if (!body) return json({ ok: false }, 400);
    if (guest) body.guest = guest;
    const at = Number(body.at) || Date.now();
    const key = `s:${new Date(at).toISOString()}${guest ? '-' + guest : ''}`; // two guests may start in the same ms
    const end = Number(body.end) || 0;
    const old = await env.SESSIONS.getWithMetadata<Meta>(key, 'stream');
    await old.value?.cancel(); // only its metadata is needed
    if (old.metadata?.end && end < old.metadata.end) return json({ ok: true, stale: true });
    // the whole session is sent; a KV value is at most 25 MB, so a (very) long one loses its oldest events, then lines
    let value = JSON.stringify(body);
    while (new TextEncoder().encode(value).length > 20_000_000 && (body.events?.length || body.lines?.length)) {
      if (body.events?.length) body.events.splice(0, Math.ceil(body.events.length / 4));
      else body.lines!.splice(0, Math.ceil(body.lines!.length / 4));
      value = JSON.stringify(body);
    }
    await env.SESSIONS.put(key, value, { metadata: { u: Date.now(), end } satisfies Meta });
    return json({ ok: true });
  }
  if (guest) return json({ ok: false }, 403);
  // GET: the laptop pulls what was written since its last pull (?since=<ms, server time>; `now` comes back for the
  // next one). A key written before the metadata existed counts as written at its own time. ?after=<key>: the old form.
  const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) || 0 : null;
  const after = url.searchParams.get('after') || '';
  const now = Date.now();
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.SESSIONS.list<Meta>({ prefix: 's:', cursor });
    for (const k of list.keys) {
      const u = k.metadata?.u ?? Date.parse(k.name.slice(2));
      if (since !== null ? u > since : k.name > after) keys.push(k.name);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  keys.sort();
  const items = await Promise.all(keys.map(async (k) => ({ key: k, value: await env.SESSIONS.get(k, 'json') })));
  return json({ ok: true, now, items });
}

const AUDIO_MAX = 2_000_000; // a 15 s slice is about 45 KB

async function audio(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.AUDIO) return json({ ok: false }, 404);
  if (req.method === 'POST') {
    const at = new Date(Number(url.searchParams.get('at')));
    const seq = Number(url.searchParams.get('seq'));
    if (Number.isNaN(at.getTime()) || !Number.isInteger(seq) || seq < 0 || seq > 999_999) return json({ ok: false }, 400);
    const body = await req.arrayBuffer();
    if (body.byteLength > AUDIO_MAX) return json({ ok: false }, 413);
    const type = req.headers.get('Content-Type') || '';
    const name = `${at.toISOString()}/${String(seq).padStart(6, '0')}.${type.includes('mp4') ? 'm4a' : 'webm'}`;
    await env.AUDIO.put(name, body, { httpMetadata: { contentType: type } });
    return json({ ok: true });
  }
  // GET ?key=<name>: one slice. GET ?since=<ms, server time>: the names written since, as /api/sessions does.
  const name = url.searchParams.get('key');
  if (name) {
    const o = await env.AUDIO.get(name);
    return o ? new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'application/octet-stream' } }) : json({ ok: false }, 404);
  }
  const since = Number(url.searchParams.get('since')) || 0;
  const now = Date.now();
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.AUDIO.list({ cursor });
    for (const o of list.objects) if (o.uploaded.getTime() > since) keys.push(o.key);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return json({ ok: true, now, keys });
}

async function manifest(env: Env, url: URL): Promise<Response> {
  const m = await (await env.ASSETS.fetch(new URL('/manifest.json', url))).json<Record<string, unknown>>();
  const k = url.searchParams.get('k') || '';
  const known = (env.ACCESS_KEY && k === env.ACCESS_KEY) || (k.startsWith('g-') && (env.GUEST_KEYS || '').split(',').map((x) => x.trim()).includes(k));
  const at = url.searchParams.get('mode') === 'mushaf' ? '/mushaf' : '/';
  m.start_url = at + (known ? '?k=' + encodeURIComponent(k) : '');
  if (at === '/mushaf') Object.assign(m, { name: 'المُسَمِّع · وضع المصحف', short_name: 'المسمّع', id: '/mushaf', scope: '/' });
  return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/manifest+json' } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // the mushaf mode's first host: the mode now lives at /mushaf, with the app's keys
    if (url.hostname.startsWith('tarteel-warsh.')) return Response.redirect(`https://musammi.benjelloun.dev/mushaf${url.search}`, 302); // not 301: a phone keeps a 301 for good
    if (url.pathname === '/manifest.json' && (url.searchParams.has('k') || url.searchParams.has('mode'))) return manifest(env, url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const who = whoIs(req, env);
    const guest = who && 'guest' in who ? who.guest : undefined;
    if (url.pathname === '/api/tafsir') return tafsir(req, env, url, !!who && !guest); // Ibn Juzay is static: open to all
    if (url.pathname === '/api/library' && !who) return json({ ok: false, error: PRIVATE_MSG }, 403);
    if (!who) return json({ ok: false, error: 'افتح التطبيق من رابطك الخاص مرة واحدة' }, 401);
    if (url.pathname === '/api/live/token' && req.method === 'POST') return token(req, env);
    if (url.pathname === '/api/library') return viaLaptop(req, env, url);
    if (url.pathname === '/api/sessions') return sessions(req, env, url, guest);
    if (url.pathname === '/api/audio') return guest ? json({ ok: false }, 403) : audio(req, env, url);
    return json({ ok: false, error: 'Endpoint not found' }, 404);
  },
};
