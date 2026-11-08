// A page left open on the phone keeps its old code across deploys: on 2026-11-07 the page of a 00:44 session was
// shown again 14 h later and the next sessions (15:52, and 11-08 00:31–00:45) ran the 00:35 build, so «افتح المصحف»
// found no screen option although the mushaf build was live. The app reloads onto a newer build, only while idle.

/** The bundle this page runs (index-XXXX.js), or '' in dev. */
export const BUILD = (document.querySelector('script[type=module][src*="/assets/index-"]') as HTMLScriptElement | null)?.src.match(/index-[\w-]+\.js/)?.[0] ?? '';

/** The bundle the site serves now, or '' when it cannot tell (offline, dev). */
async function liveBuild(): Promise<string> {
  try {
    const r = await fetch('/', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.text()).match(/index-[\w-]+\.js/)?.[0] ?? '') : '';
  } catch {
    return '';
  }
}

/** Reload onto the served build if it is newer than this page's; `idle` is asked again after the fetch. */
export async function reloadIfStale(idle: () => boolean): Promise<void> {
  if (!BUILD) return;
  const live = await liveBuild();
  if (live && live !== BUILD && idle()) location.reload();
}
