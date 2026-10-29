import React, { useRef, useState } from 'react';
import { checkGeminiKey } from './services/geminiKey';
import './KeySheet.css';

/** The reciter's own Gemini key: pasted once, checked with Google, kept on this device (null = removed). */
export const KeySheet: React.FC<{ current: string | null; onSave: (key: string | null) => void; onClose: () => void }> = ({ current, onSave, onClose }) => {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const key = draft.replace(/\s+/g, '').replace(/^["'«]+|["'»]+$/g, '');
    if (!key || busy) return;
    setBusy(true);
    setError('');
    const refused = await checkGeminiKey(key);
    setBusy(false);
    if (refused) setError(refused);
    else onSave(key);
  }

  async function paste() {
    try {
      setDraft((await navigator.clipboard.readText()).trim());
    } catch {
      input.current?.focus(); // no clipboard access: the reciter pastes by hand
    }
  }

  return (
    <div className="sheet" role="dialog" aria-label="مفتاح Gemini">
      <div className="sheet-head">
        <span>مفتاح Gemini</span>
        <button className="link" onClick={onClose}>إغلاق</button>
      </div>
      <div className="sheet-body key-sheet">
        <p className="key-intro">
          يسمعك شيخك في المُسَمِّع بنموذج Gemini من Google، بمفتاحك أنت. المفتاح مجاني، ويبقى على هذا الهاتف، ولا يُرسَل إلا إلى Google.
        </p>
        <a className="link key-guide" href="/guide" target="_blank" rel="noopener">كيف أحصل على المفتاح؟ (دقيقتان)</a>

        {current && (
          <p className="key-saved">
            المفتاح المحفوظ ينتهي بـ <bdi dir="ltr">…{current.slice(-4)}</bdi>
          </p>
        )}

        <form className="key-form" onSubmit={save}>
          <label htmlFor="gemini-key">{current ? 'أو الصق مفتاحاً آخر' : 'الصق المفتاح هنا'}</label>
          <div className="key-field">
            <input
              id="gemini-key"
              ref={input}
              dir="ltr"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="button" className="key-paste" onClick={paste}>لصق</button>
          </div>
          <button type="submit" className="key-save" disabled={busy || !draft.trim()}>
            {busy ? 'أتحقّق من المفتاح…' : 'حفظ'}
          </button>
          {error && <p className="key-error" role="alert">{error}</p>}
        </form>

        {current && (
          <button className="link key-remove" onClick={() => onSave(null)}>حذف المفتاح من هذا الهاتف</button>
        )}

        <div className="key-caveat">
          <p>في الخطة المجانية قد يطّلع مراجعون من Google على ما يصلها (صوت تلاوتك ونصّها) وتستعمله في تحسين منتجاتها.</p>
          <p>ويشترط Google أن يكون صاحب المفتاح قد بلغ 18 سنة.</p>
        </div>
      </div>
    </div>
  );
};
