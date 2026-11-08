// The mushaf mode's screen: the page (MushafView), and around it the teacher's last word, the eye that shows or hides
// the writing, the voice button, and the index. App.tsx runs the session; this only draws.
import React, { useEffect, useState } from 'react';
import { BookOpen, Eye, EyeOff, Menu } from 'lucide-react';
import type { ShownCard, Verdict, VoiceLink } from '../live/session';
import type { CompactAyah, SurahMeta } from '../services/quranData';
import { MushafView, type MushafMarks } from './MushafView';
import type { MushafLayout } from './layout';

const TEACHER_MS = 7000; // the teacher's remark stays this long over the page

interface Props {
  layout: MushafLayout | null;
  book: { quran: Map<number, CompactAyah>; surahs: SurahMeta[] } | null;
  page: number;
  onPage: (page: number, byUser: boolean) => void;
  hidden: boolean;
  onHidden: (hidden: boolean) => void;
  marks: MushafMarks;
  status: string;
  position: string;
  note: string;
  active: boolean;
  busy: boolean;
  speaking: boolean;
  link: VoiceLink;
  heard: number;
  praying: boolean;
  veil: boolean;
  onVeil: () => void;
  orbRef: React.RefObject<HTMLButtonElement | null>;
  onOrb: () => void;
  orbLabel: string;
  verdict: Verdict | ''; // the tracker's word on the last stretch: the orb's colour, as in the conversation
  onTalk: () => void; // back to the conversation screen
  card: ShownCard | null;
  onCard: () => void;
  teacher: { id: number; text: string } | null;
  needsKey: boolean;
  history: unknown[];
  geminiKey: string | null;
  onKey: () => void;
  sheets: React.ReactNode;
  renderHistory: (onClose: () => void) => React.ReactNode;
}

export const MushafScreen: React.FC<Props> = (p) => {
  const [said, setSaid] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'index' | 'menu' | 'history' | null>(null);

  useEffect(() => {
    if (!p.teacher) return;
    setSaid(p.teacher.text);
    const t = setTimeout(() => setSaid(null), TEACHER_MS);
    return () => clearTimeout(t);
  }, [p.teacher]);

  const go = (page: number) => {
    p.onPage(page, true);
    setSheet(null);
  };

  return (
    <div className="app mapp">
      <header className="mtop">
        <span className="mbrand">المُسَمِّع · المصحف</span>
        <span className={`mstatus ${p.active ? 'on' : ''}`}>
          {p.praying && <span className="prayer">في الصلاة</span>}
          {p.active ? p.status : p.position || 'ورش عن نافع'}
        </span>
      </header>

      <main className="mstage">
        {p.layout && p.book ? (
          <MushafView layout={p.layout} quran={p.book.quran} surahs={p.book.surahs} page={p.page} onPage={p.onPage} hidden={p.hidden} marks={p.marks} />
        ) : (
          <p className="mloading">{p.note || 'يُفتح المصحف…'}</p>
        )}
        {p.card && (
          <button className="card mcard" onClick={p.onCard} aria-label="إخفاء">
            <span className="card-title">{p.card.title}</span>
            <span className="quran">{p.card.text}</span>
          </button>
        )}
        {said && <p className="msaid" aria-live="polite">{said}</p>}
        {p.note && p.layout && <p className="note mnote">{p.note}</p>}
      </main>

      {p.needsKey && !p.active && (
        <div className="mkey">
          <span>ليسمعك شيخك يحتاج التطبيق مفتاح Gemini، وهو مجاني من Google.</span>
          <button className="key-start" onClick={p.onKey}>أدخل مفتاحك</button>
        </div>
      )}

      <footer className="mbar">
        <button className={`mtool ${p.hidden ? 'lit' : ''}`} onClick={() => p.onHidden(!p.hidden)} aria-label={p.hidden ? 'أظهر الكتابة' : 'أخفِ الكتابة'} aria-pressed={p.hidden}>
          {p.hidden ? <EyeOff size={22} /> : <Eye size={22} />}
          <span>{p.hidden ? 'مخفية' : 'ظاهرة'}</span>
        </button>
        <button
          ref={p.orbRef}
          className={`orb morb ${p.active ? 'on' : ''} ${p.speaking ? 'speaking' : ''} ${p.busy ? 'busy' : ''} ${p.verdict} ${p.link !== 'quiet' ? p.link : ''}`}
          onClick={p.onOrb}
          aria-label={p.orbLabel}
        >
          <span className="halo" aria-hidden="true" />
          {p.heard > 0 && <span key={p.heard} className="ripple" aria-hidden="true" />}
          <span className="dot" aria-hidden="true" />
        </button>
        <button className="mtool" onClick={() => setSheet('index')} aria-label="الفهرس">
          <BookOpen size={22} />
          <span>الفهرس</span>
        </button>
        <button className="mtool mmenu" onClick={() => setSheet('menu')} aria-label="المزيد">
          <Menu size={20} />
        </button>
      </footer>

      {p.praying && p.veil && (
        <button className="veil" onClick={p.onVeil} aria-label="إظهار الشاشة">
          <span>في الصلاة</span>
        </button>
      )}

      {sheet === 'index' && p.book && <IndexSheet surahs={p.book.surahs} page={p.page} onGo={go} onClose={() => setSheet(null)} />}
      {sheet === 'menu' && (
        <div className="sheet" role="dialog" aria-label="المزيد">
          <div className="sheet-head">
            <span>المزيد</span>
            <button className="link" onClick={() => setSheet(null)}>إغلاق</button>
          </div>
          <div className="sheet-body mmenu-body">
            <p>اضغط الدائرة واقرأ من الصفحة التي أمامك: يسكت شيخك ما دمتَ مصيباً، ويقول «أعِد» عند الخطأ. لا فتح هنا: أظهِر الصفحة بالعين، أو اضغط عليها مطوّلاً.</p>
            <p className="faint">قلّب إلى صفحة لتقرأ منها، أو اقرأ من موضع آخر فتنتقل إليه. «أسمعني الآية» يتلوها الكوشي وتُعلَّم كلماته. وللصلاة: كبّر واقرأ.</p>
            <p className="faint">وبصوتك: «أخفِ الكتابة»، و«شغّل ما قلت» إن اعترضتَ على «أعِد»، و«راجع الجلسة»، و«ارجع إلى الكلام» لشاشة المُسَمِّع.</p>
            {p.history.length > 0 && <button className="link" onClick={() => setSheet('history')}>الجلسات السابقة ({p.history.length})</button>}
            <button className="link" onClick={() => { setSheet(null); p.onKey(); }}>{p.geminiKey ? 'مفتاح Gemini' : 'أدخل مفتاح Gemini'}</button>
            <a className="link" href="/guide">دليل البدء</a>
            <button className="link" onClick={() => { setSheet(null); p.onTalk(); }}>شاشة الكلام (المُسَمِّع بروايته الثماني)</button>
          </div>
        </div>
      )}
      {sheet === 'history' && p.renderHistory(() => setSheet(null))}
      {p.sheets}
    </div>
  );
};

const IndexSheet: React.FC<{ surahs: SurahMeta[]; page: number; onGo: (page: number) => void; onClose: () => void }> = ({ surahs, page, onGo, onClose }) => {
  const [n, setN] = useState('');
  return (
    <div className="sheet" role="dialog" aria-label="الفهرس">
      <div className="sheet-head">
        <span>الفهرس</span>
        <form
          className="mgoto"
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(n);
            if (v >= 1 && v <= 604) onGo(v);
          }}
        >
          <input inputMode="numeric" placeholder={`الصفحة ${page}`} value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} aria-label="رقم الصفحة" />
        </form>
        <button className="link" onClick={onClose}>إغلاق</button>
      </div>
      <div className="sheet-body mindex">
        {surahs.map((s) => (
          <button key={s.no} className="mindex-row" onClick={() => onGo(s.start_page)}>
            <span className="mindex-no">{s.no}</span>
            <span className="mindex-name">{s.name_ar}</span>
            <span className="mindex-page">{s.start_page}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
