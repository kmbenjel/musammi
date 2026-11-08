// The mushaf, page by page, as the Madina mushaf sets it (layout.ts), in the app's Warsh font. Swiped like a printed
// mushaf (the next page is to the left). Hidden, only the words recited right are written (the rest keep their place);
// pressing and holding the page shows it while held.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompactAyah, SurahMeta } from '../services/quranData';
import { PAGES, printedWords, wordKey, type MushafLayout, type PageLine } from './layout';
import './mushaf.css';

const BASMALA = 'بِسْمِ اِ۬للَّهِ اِ۬لرَّحْمَٰنِ اِ۬لرَّحِيمِ';
const NEAR = 1; // pages rendered on each side of the one shown
const PEEK_MS = 350;

export interface MushafMarks {
  on: Set<string>; // recited right (wordKey)
  fresh: Set<string>; // just written: in the ink colour for a moment
  missed: Set<string>; // where a «أعد» fell this session (stays marked, faintly)
  miss: string | null; // where the last «أعد» fell
  play: string | null; // the word the recording is at
}

interface Props {
  layout: MushafLayout;
  quran: Map<number, CompactAyah>;
  surahs: SurahMeta[];
  page: number;
  /** byUser: swiped there (not moved by the recitation or a recording) */
  onPage: (page: number, byUser: boolean) => void;
  hidden: boolean;
  marks: MushafMarks;
}

export const MushafView: React.FC<Props> = ({ layout, quran, surahs, page, onPage, hidden, marks }) => {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [peek, setPeek] = useState(false);
  const shown = useRef(page); // the page the scroll position shows
  const moving = useRef(false); // a scroll the app asked for: not the reciter's
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the page changed from outside (recitation, a recording, the index), or the width did: scroll there. A swipe
  // already shows the page it reports, and scrolling it again mid-swipe would jerk it.
  const placedAt = useRef(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !size.w || (shown.current === page && placedAt.current === size.w)) return;
    placedAt.current = size.w;
    moving.current = true;
    shown.current = page;
    el.scrollTo({ left: -(page - 1) * size.w, behavior: 'instant' as ScrollBehavior });
    requestAnimationFrame(() => (moving.current = false));
  }, [page, size.w]);

  function scrolled() {
    const el = box.current;
    if (!el || !size.w || moving.current) return;
    const p = Math.min(PAGES, Math.max(1, Math.round(Math.abs(el.scrollLeft) / size.w) + 1));
    if (p !== shown.current) {
      shown.current = p;
      onPage(p, true);
    }
  }

  const holdStart = (e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
    clearTimeout(peekTimer.current);
    if (hidden) peekTimer.current = setTimeout(() => setPeek(true), PEEK_MS);
  };
  const holdMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clearTimeout(peekTimer.current);
  };
  const holdEnd = () => {
    clearTimeout(peekTimer.current);
    start.current = null;
    setPeek(false);
  };

  // the font: a full line fills the page's width, and 15 lines its height
  const font = useMemo(() => {
    if (!size.w) return 0;
    const byWidth = (size.w - 8) / layout.width;
    const byHeight = (size.h - 64) / layout.lines / 2.05;
    return Math.max(10, Math.min(byWidth, byHeight));
  }, [size, layout]);

  return (
    <div
      ref={box}
      className={`mushaf ${hidden && !peek ? 'is-hidden' : ''}`}
      onScroll={scrolled}
      onPointerDown={holdStart}
      onPointerMove={holdMove}
      onPointerUp={holdEnd}
      onPointerCancel={holdEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      {Array.from({ length: PAGES }, (_, i) => (
        <section key={i} className="mpage" aria-label={`الصفحة ${i + 1}`}>
          {Math.abs(i + 1 - page) <= NEAR && font > 0 && (
            <Page n={i + 1} layout={layout} quran={quran} surahs={surahs} font={font} marks={marks} />
          )}
        </section>
      ))}
    </div>
  );
};

const Page: React.FC<{ n: number; layout: MushafLayout; quran: Map<number, CompactAyah>; surahs: SurahMeta[]; font: number; marks: MushafMarks }> = React.memo(
  ({ n, layout, quran, surahs, font, marks }) => {
    const p = layout.pages[n - 1];
    const first = p.l.find((l): l is [number, number, number][] => Array.isArray(l) && l.length > 0)?.[0]?.[0];
    const ayah = first ? quran.get(first) : undefined;
    const surah = surahs.find((s) => s.no === ayah?.s);
    const opening = n <= 2; // al-Fatiha and the start of al-Baqara: centred, as in print
    const size = font * (p.f ?? 1);
    const kashida = useMemo(() => new Map((p.k ?? []).map(([id, k, at, n]) => [wordKey(id, k), [at, n] as const])), [p]);
    return (
      <div className={`mpage-in ${opening ? 'opening' : ''}`} style={{ '--mf': `${size}px`, '--mw': `${font * layout.width}px` } as React.CSSProperties}>
        <header className="mhead">
          <span>{surah ? `سورة ${surah.name_ar}` : ''}</span>
          <span>{ayah ? `الجزء ${ayah.j}` : ''}</span>
        </header>
        <div className="mlines">
          {p.l.map((line, i) => (
            <Line key={i} line={line} short={!!p.c?.includes(i)} kashida={kashida} quran={quran} surahs={surahs} marks={marks} />
          ))}
        </div>
        <footer className="mfoot">{n}</footer>
      </div>
    );
  },
);

type Kashida = Map<string, readonly [at: number, n: number]>;

const Line: React.FC<{ line: PageLine; short: boolean; kashida: Kashida; quran: Map<number, CompactAyah>; surahs: SurahMeta[]; marks: MushafMarks }> = ({ line, short, kashida, quran, surahs, marks }) => {
  if (!line) return <div className="ml empty" />;
  if (!Array.isArray(line)) {
    if ('h' in line)
      return (
        <div className="ml sh">
          <span className="sh-frame">سُورَةُ {surahs.find((s) => s.no === line.h)?.name_ar ?? ''}</span>
        </div>
      );
    return <div className="ml bsm">{BASMALA}</div>;
  }
  const items: React.ReactNode[] = [];
  for (const [id, k0, k1] of line) {
    const x = quran.get(id);
    if (!x) continue;
    const words = printedWords(x);
    for (let k = k0; k <= k1; k++) {
      const key = wordKey(id, k);
      const cls = `w${marks.on.has(key) ? ' on' : ''}${marks.fresh.has(key) ? ' fresh' : ''}${marks.missed.has(key) ? ' missed' : ''}${marks.miss === key ? ' miss' : ''}${marks.play === key ? ' play' : ''}`;
      const st = kashida.get(key);
      const text = st ? words[k].slice(0, st[0]) + '\u0640'.repeat(st[1]) + words[k].slice(st[0]) : words[k];
      const word = <span className={cls}>{text}</span>;
      items.push(
        k === words.length - 1 ? (
          <span key={key} className="wend">
            {word}
            <span className="num" role="img" aria-label={String(x.a)}>
              {'۝'}
              <AyahNumber n={x.a} />
            </span>
          </span>
        ) : (
          React.cloneElement(word, { key })
        ),
      );
    }
  }
  return <div className={`ml${short ? ' short' : ''}`}>{items}</div>;
};


// The number inside the ayah ornament, in the mushaf font's own digits, drawn in an SVG laid over the ring's hole
// (mushaf.css .num .d): its baseline is exact, so the digits' ink is centred whatever the screen's fonts (user
// 2026-11-08: «يظهر الرقم نازلاً، ولا يعجبني خطّ الرقم»). Advances and ink (yMin, yMax) of KFGQPC Warsh, 2048 upm.
const DIGITS = {
  latin: { chars: '0123456789', adv: [800, 547, 906, 793, 953, 876, 880, 884, 818, 880], ink: [[5, 1126], [-1, 1122], [0, 1127], [2, 1130], [0, 1122], [0, 1121], [1, 1122], [0, 1121], [2, 1128], [4, 1125]] },
  arabic: { chars: '٠١٢٣٤٥٦٧٨٩', adv: [277, 311, 370, 505, 417, 380, 459, 491, 519, 434], ink: [[210, 402], [1, 553], [0, 543], [0, 543], [-2, 549], [87, 463], [0, 546], [-1, 547], [-3, 545], [-4, 544]] },
} as const;
export type DigitStyle = keyof typeof DIGITS;
export const DIGIT_STYLE: DigitStyle = 'latin';

export function ayahNumberLayout(n: number, style: DigitStyle = DIGIT_STYLE) {
  const d = DIGITS[style];
  const idx = String(n).split('').map(Number);
  const em = (u: number) => u / 2048;
  const width = em(idx.reduce((w, k) => w + d.adv[k], 0));
  const top = em(Math.max(...idx.map((k) => d.ink[k][1]))), bot = em(Math.min(...idx.map((k) => d.ink[k][0])));
  const size = Math.min(70 / width, 46 / (top - bot)); // of the hole's 100: 70 across, 46 high at most
  return { text: idx.map((k) => d.chars[k]).join(''), size, y: 50 + ((top + bot) / 2) * size };
}

function AyahNumber({ n }: { n: number }) {
  const { text, size, y } = ayahNumberLayout(n);
  return (
    <svg className="d" viewBox="0 0 100 100" aria-hidden="true">
      <text x="50" y={y.toFixed(1)} fontSize={size.toFixed(1)} textAnchor="middle">
        {text}
      </text>
    </svg>
  );
}
