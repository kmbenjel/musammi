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
  miss: string | null; // the word where a «أعد» fell
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
    return (
      <div className={`mpage-in ${opening ? 'opening' : ''}`} style={{ '--mf': `${size}px`, '--mw': `${font * layout.width}px` } as React.CSSProperties}>
        <header className="mhead">
          <span>{surah ? `سورة ${surah.name_ar}` : ''}</span>
          <span>{ayah ? `الجزء ${ayah.j}` : ''}</span>
        </header>
        <div className="mlines">
          {p.l.map((line, i) => (
            <Line key={i} line={line} short={!!p.c?.includes(i)} quran={quran} surahs={surahs} marks={marks} />
          ))}
        </div>
        <footer className="mfoot">{n}</footer>
      </div>
    );
  },
);

const Line: React.FC<{ line: PageLine; short: boolean; quran: Map<number, CompactAyah>; surahs: SurahMeta[]; marks: MushafMarks }> = ({ line, short, quran, surahs, marks }) => {
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
      const cls = `w${marks.on.has(key) ? ' on' : ''}${marks.miss === key ? ' miss' : ''}${marks.play === key ? ' play' : ''}`;
      const word = <span className={cls}>{words[k]}</span>;
      items.push(
        k === words.length - 1 ? (
          <span key={key} className="wend">
            {word}
            <span className="num">{x.a}</span>
          </span>
        ) : (
          React.cloneElement(word, { key })
        ),
      );
    }
  }
  return <div className={`ml${short ? ' short' : ''}`}>{items}</div>;
};
