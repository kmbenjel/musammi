import React, { useEffect, useRef, useState } from 'react';
import { RecitationSession, type MushafData, type Place, type SessionState, type ShownCard } from './live/session';
import { RIWAYAT, riwayaOf, type RiwayaKey } from './live/riwayat';
import { loadRiwaya, setRiwaya, type SurahMeta } from './services/quranData';
import { generateTestExam, type TestQuestion } from './services/testGenerator';
import { loadGeminiKey, saveGeminiKey, tokenWithOwnKey } from './services/geminiKey';
import { KeySheet } from './KeySheet';

type Line = { id: number; who: 'you' | 'teacher'; text: string; live?: boolean };
// at: when the session started (its id: every save of it goes under it); end: when this copy of it was taken
type Past = { at: number; end?: number; riwaya?: RiwayaKey; where?: { s: number; a: number }[]; lines: { who: 'you' | 'teacher'; text: string }[]; events?: string[] };

const ACCESS_KEY = 'hifz_warsh_access_key';
const HISTORY_KEY = 'hifz_warsh_history';
const SYNCED_KEY = 'hifz_warsh_history_synced';
const RIWAYA_KEY = 'hifz_warsh_riwaya';
const PLACE_KEY = 'hifz_warsh_last_place'; // where the last session stopped
const RESUME_MS = 15 * 60 * 1000; // a session started this soon after goes on from there
const SHOWN_LINES = 60; // on screen; the whole session is kept and saved
const KEPT_LINES = 120; // per session in this phone's history (localStorage is ~5 MB)
const KEEPALIVE_MAX = 60_000; // a keepalive request body must stay under 64 KB
const SAVE_EVERY = 60_000; // a running session is saved this often (when something changed), so a killed app loses little

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};

// The private link (…/?k=KEY) is opened once; the key is kept and removed from the address bar.
function takeAccessKey(): string | null {
  const url = new URL(location.href);
  const k = url.searchParams.get('k');
  if (k) {
    store.set(ACCESS_KEY, k);
    url.searchParams.delete('k');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const key = store.get(ACCESS_KEY);
  // so that «Install app» bakes the key into the home-screen app (see /manifest.json on the server)
  if (key) document.querySelector('link[rel=manifest]')?.setAttribute('href', '/manifest.json?k=' + encodeURIComponent(key));
  return key;
}

let surahNames: SurahMeta[] = [];
const nameOf = (s: number) => surahNames.find((x) => x.no === s)?.name_ar ?? String(s);

// Each riwaya's mushaf font (KFGQPC), loaded once when the riwaya is first used.
const fonts = new Map<RiwayaKey, Promise<void>>();
function useMushafFont(key: RiwayaKey) {
  if (!fonts.has(key)) {
    const face = new FontFace(`Mushaf-${key}`, `url(/riwayat/${key}/font.woff2)`, { display: 'swap' });
    fonts.set(key, face.load().then((f) => void document.fonts.add(f)).catch(() => {}));
  }
  document.documentElement.style.setProperty('--quran', `'Mushaf-${key}', 'Amiri', serif`);
  document.documentElement.style.setProperty('--ink', riwayaOf(key).color);
}

/** Past sessions as plain text for the past_sessions tool (newest first, the teacher's remarks with what preceded them). */
function pastSessionsText(items: Past[]): string {
  return items
    .slice(0, 8)
    .map((p) => {
      const date = new Date(p.at).toLocaleString('ar-MA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
      const where = (p.where ?? []).map((w) => `سورة ${nameOf(w.s)} من الآية ${w.a}`).join('، ') || 'غير محدد';
      const remarks: string[] = [];
      p.lines.forEach((l, i) => {
        if (l.who !== 'teacher') return;
        const before = p.lines[i - 1]?.who === 'you' ? `بعد «${p.lines[i - 1].text.slice(-80)}»: ` : '';
        remarks.push(`- ${before}${l.text.slice(0, 160)}`);
      });
      const riwaya = p.riwaya ? ` (رواية ${riwayaOf(p.riwaya).short})` : '';
      return `## ${date}${riwaya} — ${where}\n${remarks.slice(-25).join('\n') || '- لا ملاحظات'}`;
    })
    .join('\n\n');
}

/** A request body gzipped (the Worker sees the gzip header bytes and inflates it); as is where the browser can't. */
async function gzipped(json: string): Promise<{ body: Blob; type: string }> {
  const plain = { body: new Blob([json]), type: 'application/json' };
  if (typeof CompressionStream === 'undefined') return plain;
  try {
    const body = await new Response(plain.body.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    return { body, type: 'application/json+gzip' };
  } catch {
    return plain;
  }
}

function loadHistory(): Past[] {
  try {
    return JSON.parse(store.get(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export const App: React.FC = () => {
  const [accessKey] = useState<string | null>(takeAccessKey);
  const [geminiKey, setGeminiKey] = useState<string | null>(loadGeminiKey); // the reciter's own key (not the owner)
  const [showKey, setShowKey] = useState(false);
  const [state, setState] = useState<SessionState | 'idle'>('idle');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [position, setPosition] = useState('');
  const [praying, setPraying] = useState(false);
  const [card, setCard] = useState<ShownCard | null>(null);
  const [history, setHistory] = useState<Past[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [riwaya, setRiwayaState] = useState<RiwayaKey>(() => riwayaOf(store.get(RIWAYA_KEY)).key);
  const [showRiwayat, setShowRiwayat] = useState(false);
  const [mushaf, setMushaf] = useState<string | null>(null); // the recorded mushaf is playing
  const [veil, setVeil] = useState(true); // in salat the screen goes dark (it must stay on); a tap lifts it

  const session = useRef<RecitationSession | null>(null);
  const orb = useRef<HTMLButtonElement>(null);
  const captions = useRef<HTMLDivElement>(null);
  const lineId = useRef(0);
  const exam = useRef<{ key: string; queue: TestQuestion[]; n: number }>({ key: '', queue: [], n: 0 });
  const where = useRef<{ s: number; a: number }[]>([]);
  const startedAt = useRef(0);
  const events = useRef<string[]>([]);
  const riwayaRef = useRef(riwaya);
  riwayaRef.current = riwaya;
  const linesNow = useRef(lines);
  linesNow.current = lines;
  const savedSig = useRef(''); // what the last save held, so an unchanged session is not sent again
  const autosave = useRef(() => {});
  autosave.current = () => {
    if (startedAt.current) save(running(), linesNow.current);
  };

  useEffect(() => {
    captions.current?.scrollTo({ top: captions.current.scrollHeight, behavior: 'smooth' });
  }, [lines]);

  useEffect(() => () => session.current?.stop(), []);

  // The phone may kill the app (swiped away, screen off, out of memory) without «إنهاء»: save as it goes,
  // every minute and whenever the app is hidden (the last moment a page is sure to run).
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && autosave.current();
    const leaving = () => autosave.current();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
    };
  }, []);

  useEffect(() => {
    useMushafFont(riwaya);
    store.set(RIWAYA_KEY, riwaya);
    setRiwaya(riwaya).then((d) => (surahNames = d.surahs)).catch(() => {});
  }, [riwaya]);

  // Opened as the installed app («Hey Google, open حفظ ورش») or with ?start: start listening without a tap.
  // Chrome allows audio without a gesture for home-screen apps; elsewhere start() asks for the tap.
  useEffect(() => {
    const standalone = matchMedia('(display-mode: standalone)').matches;
    if ((accessKey || geminiKey) && (standalone || new URLSearchParams(location.search).has('start'))) start(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sessions saved on this phone before the laptop kept them: send them once.
  useEffect(() => {
    if (!accessKey || store.get(SYNCED_KEY)) return;
    const items = loadHistory();
    Promise.all(
      items.map((p) =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'X-Access-Key': accessKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...p, synced: true }),
        }).then((r) => r.ok),
      ),
    )
      .then((oks) => oks.every(Boolean) && store.set(SYNCED_KEY, '1'))
      .catch(() => {});
  }, [accessKey]);

  const active = state === 'connecting' || state === 'listening' || state === 'reconnecting';

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => autosave.current(), SAVE_EVERY);
    return () => clearInterval(id);
  }, [active]);

  const authed = () => ({ 'X-Access-Key': accessKey ?? '' });

  async function getToken(handle: string | null, key: RiwayaKey) {
    if (geminiKey) return tokenWithOwnKey(geminiKey, handle, key); // minted here: the key goes only to Google
    const res = await fetch('/api/live/token', {
      method: 'POST',
      headers: { ...authed(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, riwaya: key }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذّر بدء الجلسة');
    return { token: data.token as string, model: data.model as string };
  }

  async function tafsir(hafsId: number, book?: string) {
    const q = new URLSearchParams({ hafs: String(hafsId), book: book ?? 'ibn_juzay' });
    const res = await fetch('/api/tafsir?' + q, { headers: authed(), signal: AbortSignal.timeout(15000) });
    return res.json();
  }

  async function library(book: string, query: string) {
    const res = await fetch('/api/library?' + new URLSearchParams({ book, q: query }), { headers: authed(), signal: AbortSignal.timeout(15000) });
    return res.json();
  }

  async function switchRiwaya(key: RiwayaKey): Promise<MushafData> {
    const d = await setRiwaya(riwayaOf(key).key);
    surahNames = d.surahs;
    setRiwayaState(d.key);
    exam.current = { key: '', queue: [], n: 0 };
    return d;
  }

  // A Kufi (Hafs mushaf) number → the same ayah in the current riwaya's counting.
  async function fromHafs(s: number, a: number) {
    const hafsId = (await loadRiwaya('hafs')).toHafs[`${s}:${a}`];
    const cur = session.current ? await loadRiwaya(riwaya) : null;
    if (!hafsId || !cur) return null;
    let best: string | null = null;
    for (const [k, id] of Object.entries(cur.toHafs)) if (id <= hafsId && (!best || id > cur.toHafs[best])) best = k;
    if (!best) return null;
    const [bs, ba] = best.split(':').map(Number);
    return { s: bs, a: ba };
  }

  async function nextExamQuestion(args: { surah?: unknown; juz?: unknown }) {
    const n = (v: unknown, max: number) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max ? Number(v) : undefined);
    const opts = { surah: n(args.surah, 114), juz: n(args.juz, 30) };
    const key = `${opts.surah ?? ''}|${opts.juz ?? ''}`;
    if (exam.current.key !== key || !exam.current.queue.length) {
      const queue = await generateTestExam({
        questionCount: 10,
        scopeType: opts.surah ? 'surahs' : opts.juz ? 'juz' : 'all',
        selectedSurahs: opts.surah ? [opts.surah] : undefined,
        selectedJuz: opts.juz ? [opts.juz] : undefined,
      });
      exam.current = { key, queue, n: 0 };
    }
    const q = exam.current.queue.shift()!;
    return {
      n: ++exam.current.n,
      title: q.typeName,
      cue: q.cueText,
      question: `${q.typeName} — سورة ${q.surahNameAr}، الآية ${q.ayahNo}`,
      expected: q.expectedText,
      ayat: q.type === 'where_is_this' ? [] : q.expectedAyatList.map((x) => ({ s: x.s, a: x.a })), // a name is asked: nothing to recite
    };
  }

  function upsertYou(text: string, done: boolean) {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last?.who === 'you' && last.live) {
        return [...prev.slice(0, -1), { ...last, text, live: !done }];
      }
      // the stretch's final text arrives after the teacher's reply already closed its line
      if (done && prev.slice(-3).some((l) => l.who === 'you' && l.text === text)) return prev;
      return [...prev, { id: ++lineId.current, who: 'you' as const, text, live: !done }];
    });
  }

  function addTeacher(text: string) {
    setLines((prev) => {
      // close any live line of mine before the teacher speaks
      const closed = prev.map((l) => (l.live ? { ...l, live: false } : l));
      return [...closed, { id: ++lineId.current, who: 'teacher' as const, text }];
    });
  }

  async function start(auto = false) {
    if (!accessKey && !geminiKey) {
      if (!auto) setShowKey(true);
      return;
    }
    setNote('');
    setLines([]);
    setCard(null);
    setPosition('');
    let s: RecitationSession | null = null;
    try {
      const mushaf = await switchRiwaya(riwaya);
      where.current = [];
      events.current = [];
      exam.current = { key: '', queue: [], n: 0 };
      startedAt.current = Date.now();
      s = new RecitationSession(
        { getToken, mushaf, switchRiwaya, fromHafs, pastSessions: () => pastSessionsText(loadHistory().filter((p) => p.at !== startedAt.current)), tafsir, library, nextExamQuestion, resume: lastPlace() },
        {
          onState: (st, detail) => {
            if (session.current !== s) return; // replaced by a newer start(), or already stopped
            if (st === 'closed' && detail) {
              // the session ended itself (idle, quota, connection): save it like «إنهاء»
              setNote(detail);
              stop();
              return;
            }
            setState(st);
          },
          onYou: upsertYou,
          onTeacher: addTeacher,
          onSpeaking: setSpeaking,
          onLevel: (lvl) => orb.current?.style.setProperty('--level', String(Math.min(1, lvl * 12))),
          onPosition: setPosition,
          onCard: setCard,
          onPrayer: (on) => {
            setPraying(on);
            setVeil(true);
          },
          onMushafAudio: setMushaf,
          onEvent: (what) => {
            const t = Math.round((Date.now() - startedAt.current) / 1000);
            events.current.push(`${t}s ${what}`);
            if (events.current.length > 20000) events.current.splice(0, 1000);
          },
          onReciting: (w) => {
            where.current = [...where.current.filter((x) => x.s !== w.s), w];
          },
        },
      );
      session.current?.stop(); // two quick taps: only the newest session lives
      session.current = s;
      await s.start();
    } catch (err) {
      // only this call's session: a newer start() may own session.current, or «إنهاء» already ended this one
      const mine = session.current === s;
      s?.stop();
      if (!mine) return;
      session.current = null;
      setState('idle');
      const msg = err instanceof Error ? err.message : String(err);
      if (auto) setNote('');
      else setNote(/Permission|NotAllowed/i.test(msg) ? 'اسمح للتطبيق باستعمال الميكروفون ثم أعد المحاولة' : msg);
    }
  }

  function lastPlace(): (Place & { ago: number }) | undefined {
    try {
      const p = JSON.parse(store.get(PLACE_KEY) || 'null') as (Place & { at: number }) | null;
      const ago = p ? Date.now() - p.at : Infinity;
      return p && ago >= 0 && ago < RESUME_MS ? { ...p, ago: Math.round(ago / 60000) } : undefined;
    } catch {
      return undefined;
    }
  }

  type Run = { at: number; riwaya: RiwayaKey; where: { s: number; a: number }[]; events: string[] };
  const running = (): Run => ({ at: startedAt.current, riwaya: riwayaRef.current, where: where.current, events: events.current });

  /** Saves the session so far under its start time: each save replaces the one before, on this phone and the server. */
  function save(run: Run, rows: Line[], final = false) {
    const kept = rows.filter((l) => l.text.trim()).map(({ who, text }) => ({ who, text }));
    if (!run.at || !kept.length) return;
    const sig = `${run.at}|${kept.length}|${kept[kept.length - 1].text.length}|${run.events.length}|${run.where.length}|${run.riwaya}`;
    if (sig === savedSig.current && !final) return; // the last save is sent anyway: one before it may yet fail
    savedSig.current = sig;
    const session: Past = { at: run.at, end: Date.now(), riwaya: run.riwaya, where: run.where, lines: kept, events: run.events };
    // the phone keeps a short copy (no events) for past_sessions and the list
    const next = [{ ...session, lines: kept.slice(-KEPT_LINES), events: undefined }, ...loadHistory().filter((p) => p.at !== run.at)].slice(0, 30);
    store.set(HISTORY_KEY, JSON.stringify(next));
    setHistory(next);
    // the whole session to the server (owner only: a reciter with their own key keeps them on this device).
    // Gzipped (the transcript and events shrink several times over), so that even a long session fits a keepalive
    // request, the kind that outlives the page when the app is swiped away; a bigger one goes as a plain request, and
    // if the page dies first the save of a minute ago is what stays.
    if (!accessKey) return;
    const key = accessKey;
    const failed = () => {
      if (savedSig.current === sig) savedSig.current = ''; // try again at the next save
    };
    gzipped(JSON.stringify({ ...session, ua: navigator.userAgent }))
      .then(({ body, type }) =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'X-Access-Key': key, 'Content-Type': type },
          body,
          keepalive: body.size < KEEPALIVE_MAX,
        }),
      )
      .then((r) => r.ok || failed(), failed);
  }

  function stop() {
    if (startedAt.current) {
      const run = running(); // taken now: a new start() replaces these
      setLines((prev) => (save(run, prev, true), prev));
    }
    const place = session.current?.place();
    if (session.current) store.set(PLACE_KEY, place ? JSON.stringify({ ...place, at: Date.now() }) : null); // an exam, or no place: nothing to go on from
    session.current?.stop();
    session.current = null;
    startedAt.current = 0;
    setState('idle');
    setSpeaking(false);
    setPraying(false);
    setMushaf(null);
    setLines((prev) => prev.map((l) => ({ ...l, live: false })));
  }

  const r = riwayaOf(riwaya);
  const status =
    state === 'connecting' ? 'جارٍ الاتصال…'
    : state === 'reconnecting' ? 'لحظة، أستأنف الجلسة…'
    : state === 'listening' ? (mushaf ? `يُتلى: ${mushaf} — المس للإيقاف` : speaking ? 'الشيخ يتكلّم' : praying ? 'معك في صلاتك' : 'أستمع إليك')
    : 'اضغط وتكلّم';

  return (
    <div className="app">
      <header className="top">
        <h1 className="brand">المُسَمِّع</h1>
        <button
          className="riwaya"
          onClick={() => !active && setShowRiwayat(true)}
          aria-label={`الرواية: ${r.name}${active ? '' : '، اضغط للتغيير'}`}
          disabled={active}
        >
          <span className="ink" aria-hidden="true" />
          <span className="riwaya-name">{r.short}</span>
        </button>
      </header>

      <main className={`stage ${lines.length || card ? 'has-content' : ''}`}>
        <button
          ref={orb}
          className={`orb ${active ? 'on' : ''} ${speaking || mushaf ? 'speaking' : ''} ${state === 'connecting' || state === 'reconnecting' ? 'busy' : ''}`}
          onClick={mushaf ? () => session.current?.stopMushaf() : active ? stop : () => start()}
          aria-label={mushaf ? 'إيقاف التلاوة' : active ? 'إنهاء الجلسة' : 'ابدأ'}
        >
          <span className="halo" aria-hidden="true" />
          <span className="dot" aria-hidden="true" />
        </button>
        <p className="status">{status}</p>
        {(position || (praying && active)) && (
          <p className="where">
            {praying && active && <span className="prayer">في الصلاة</span>}
            {position}
          </p>
        )}
        {note && <p className="note">{note}</p>}

        {card && (
          <button className="card" onClick={() => setCard(null)} aria-label="إخفاء">
            <span className="card-title">{card.title}</span>
            <span className="quran">{card.text}</span>
          </button>
        )}

        {lines.length > 0 ? (
          <div className="captions" ref={captions} aria-live="polite">
            {lines.slice(-SHOWN_LINES).map((l) => (
              <p key={l.id} className={`line ${l.who} ${l.live ? 'live' : ''}`}>{l.text}</p>
            ))}
          </div>
        ) : (
          !active && (
            <div className="hints">
              {!accessKey && !geminiKey && (
                <>
                  <p>ليسمعك شيخك يحتاج المُسَمِّع مفتاح Gemini، وهو مجاني من Google.</p>
                  <button className="key-start" onClick={() => setShowKey(true)}>أدخل مفتاحك</button>
                </>
              )}
              <p>قل ما ستقرأ ثم اقرأ، واسأل شيخك عن الخطأ أو المعنى أو القراءات، أو قل «اختبرني».</p>
              <p className="faint">وللصلاة: اضغط ثم كبّر واقرأ؛ يعرف شيخك أنك تصلّي ويفتح عليك إذا نسيت. اترك الشاشة مفتوحة، فهي تُظلم وحدها.</p>
              {history.length > 0 && (
                <button className="link" onClick={() => setShowHistory(true)}>الجلسات السابقة ({history.length})</button>
              )}
              {geminiKey && <button className="link" onClick={() => setShowKey(true)}>مفتاح Gemini</button>}
            </div>
          )
        )}
      </main>

      {active && (
        <footer className="bottom">
          <button className="end" onClick={stop}>إنهاء</button>
        </footer>
      )}

      {praying && active && veil && (
        <button className="veil" onClick={() => setVeil(false)} aria-label="إظهار الشاشة">
          <span>في الصلاة</span>
        </button>
      )}

      {showHistory && <History items={history} onClose={() => setShowHistory(false)} />}
      {showKey && (
        <KeySheet
          current={geminiKey}
          onSave={(k) => {
            saveGeminiKey(k);
            setGeminiKey(k);
            setShowKey(false);
          }}
          onClose={() => setShowKey(false)}
        />
      )}
      {showRiwayat && (
        <RiwayaSheet
          current={riwaya}
          onPick={(k) => {
            setRiwayaState(k);
            setShowRiwayat(false);
          }}
          onClose={() => setShowRiwayat(false)}
        />
      )}
    </div>
  );
};

const RiwayaSheet: React.FC<{ current: RiwayaKey; onPick: (k: RiwayaKey) => void; onClose: () => void }> = ({ current, onPick, onClose }) => {
  useEffect(() => {
    Object.keys(RIWAYAT).forEach((k) => useMushafFont(k as RiwayaKey));
    useMushafFont(current);
  }, [current]);
  return (
    <div className="sheet" role="dialog" aria-label="اختر الرواية">
      <div className="sheet-head">
        <span>الرواية</span>
        <button className="link" onClick={onClose}>إغلاق</button>
      </div>
      <div className="sheet-body riwayat">
        {Object.values(RIWAYAT).map((x) => (
          <button key={x.key} className={`riwaya-row ${x.key === current ? 'current' : ''}`} style={{ '--row-ink': x.color } as React.CSSProperties} onClick={() => onPick(x.key)}>
            <span className="ink" aria-hidden="true" />
            <span className="riwaya-row-text">
              <span className="riwaya-row-name">{x.name}</span>
              <span className="riwaya-row-count">{x.count}</span>
            </span>
            <span className="riwaya-row-sample" style={{ fontFamily: `'Mushaf-${x.key}', serif` }}>{x.sample}</span>
          </button>
        ))}
        <p className="faint">ويمكنك أن تطلبها من شيخك بصوتك في أثناء الجلسة: «سأقرأ برواية قالون».</p>
      </div>
    </div>
  );
};

const History: React.FC<{ items: Past[]; onClose: () => void }> = ({ items, onClose }) => (
  <div className="sheet" role="dialog" aria-label="الجلسات السابقة">
    <div className="sheet-head">
      <span>الجلسات السابقة</span>
      <button className="link" onClick={onClose}>إغلاق</button>
    </div>
    <div className="sheet-body">
      {items.map((p) => (
        <details key={p.at}>
          <summary>
            {new Date(p.at).toLocaleString('ar-MA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' })}
            {p.riwaya && <span className="past-riwaya" style={{ color: riwayaOf(p.riwaya).color }}> · {riwayaOf(p.riwaya).short}</span>}
          </summary>
          {p.lines.map((l, i) => (
            <p key={i} className={`line ${l.who}`}>{l.text}</p>
          ))}
        </details>
      ))}
    </div>
  </div>
);
