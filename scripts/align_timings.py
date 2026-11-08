#!/usr/bin/env python3
"""Ayah timings for a recorded mushaf that has none (Qunbul: Ahmad Dyban on mp3quran), by forced alignment.

The known KFGQPC text of the riwaya (vowelled, romanized with uroman) is aligned to the recording with the MMS
forced-alignment model (torchaudio MMS_FA, CTC). A star token before the first ayah and between ayat absorbs
what is not in the text (isti'adha, basmala, takbir, breaths). Output per surah, in the mp3quran format:
[{"ayah": n, "start_time": ms, "end_time": ms, "score": mean CTC probability}], end = next ayah's start.

Run with the aligner venv (uv venv ~/.venvs/hifz-align; torch/torchaudio CPU, uroman, soundfile):
  ~/.venvs/hifz-align/bin/python scripts/align_timings.py qumbul OUT_DIR [surah ...]
  ~/.venvs/hifz-align/bin/python scripts/align_timings.py warsh OUT_DIR 1 112 --folder URL   (calibration)
  --words: also the time of every printed word ("words": [[word index, start ms, end ms, quiet ms before], …]), to play
    from a phrase (scripts/build_word_timings.py makes the app's files from them).
  --timings READ: mp3quran timing id of this recording (e.g. 16 = Warsh, al-Kouchi); a surah longer than 5 min is then
    aligned in groups of ayat cut at those timings (the CTC backpointers are frames × tokens bytes: al-Baqara whole
    would need ~30 GB). Without it a long surah is aligned in one piece.
Idempotent: a surah whose output exists is skipped.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

import numpy as np
import torch
import torchaudio.functional as F
import uroman as ur
from torchaudio.pipelines import MMS_FA as bundle

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = os.path.expanduser('~/.local/bin/ffmpeg')
FOLDERS = {'qumbul': 'https://cdn.mp3quran.net/audio/ahmad-deeban/r3/'}
SR = bundle.sample_rate
CHUNK, CONTEXT = 30 * SR, 2 * SR  # emissions in 30 s windows, with 2 s of context on each side
GROUP_S, MARGIN_S = 300, 1.5  # with reference timings: align ≤ 5 min of ayat at a time, 1.5 s into the neighbours
TIMING = 'https://www.mp3quran.net/api/v3/ayat_timing'

torch.set_num_threads(int(os.environ.get('ALIGN_THREADS') or os.cpu_count() or 4))
model = bundle.get_model(with_star=True).eval()
# The weights mapped from a file: reclaimable, so they do not press on other jobs (anon 1.35 → 0.23 GB, same output).
WEIGHTS = os.path.expanduser('~/.cache/torch/hub/checkpoints/mms_fa_star.pt')
if not os.path.exists(WEIGHTS):
    torch.save(model.state_dict(), WEIGHTS + '.tmp')
    os.replace(WEIGHTS + '.tmp', WEIGHTS)
model.load_state_dict(torch.load(WEIGHTS, mmap=True, weights_only=True), assign=True)
DICT = bundle.get_dict(star='*')
roman = ur.Uroman()


# Marks that are not pronounced (waqf, sajda, rub', silent-letter and tashil/imala signs); the small waw/yeh of the
# sila are pronounced, so they become letters. uroman would otherwise spell the marks out ("maddah", "waw"…).
SILENT = re.compile('[\u0653\u065E\u06D6-\u06DC\u06DE-\u06E2\u06E4\u06E8-\u06ED\u200F]')
SPOKEN = {'\u06E5': '\u0648', '\u06E6': '\u064A', '\u06E7': '\u064A'}
# The opening letters are recited by their names: «الٓمٓ» = «ألف لام ميم».
LETTER_NAMES = {'ا': 'ألف', 'ل': 'لام', 'م': 'ميم', 'ص': 'صاد', 'ر': 'را', 'ك': 'كاف', 'ه': 'ها', 'ي': 'يا', 'ع': 'عين',
                'ط': 'طا', 'س': 'سين', 'ح': 'حا', 'ق': 'قاف', 'ن': 'نون'}
MUQATTAAT_SURAHS = {2, 3, 7, 10, 11, 12, 13, 14, 15, 19, 20, 26, 27, 28, 29, 30, 31, 32, 36, 38, 40, 41, 42, 43, 44, 45, 46, 50, 68}
BARE = re.compile('[\u064B-\u065F\u0670\u06D6-\u06ED\u0653]')


def romanize(w: str) -> str:
    return ''.join(c for c in roman.romanize_string(w).lower() if c in DICT and c not in '-*')


def words_of(text: str, surah: int = 0, ayah: int = 0) -> list[tuple[int, str]]:
    """Printed ayah → (index of the printed word, romanized word in the model's alphabet: letters + vowels)."""
    t = re.sub(r'[\u0660-\u0669\u06F0-\u06F9\d]+', ' ', text)  # the ayah number
    t = SILENT.sub('', ''.join(SPOKEN.get(c, c) for c in t))
    out = []
    leading = surah in MUQATTAAT_SURAHS and (ayah == 1 or (surah, ayah) == (42, 2))
    for k, w in enumerate(t.split()):
        bare = BARE.sub('', w).replace('ٱ', 'ا').replace('أ', 'ا')
        # The first word of these surahs is always opening letters (the Warsh mushaf vowels them: «أَلَٓمِّٓر»);
        # after it they carry no short vowels («حمٓ عٓسٓقٓ»), unlike «مَآ» in «طه مَآ أَنزَلْنَا».
        if leading and bare and all(c in LETTER_NAMES for c in bare) and (k == 0 or not re.search('[\u064B-\u0650]', w)):
            out += [(k, r) for r in (romanize(LETTER_NAMES[c]) for c in bare) if r]
            continue
        leading = False
        r = romanize(w)
        if r:
            out.append((k, r))
    return out


def load_audio(url: str) -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix='.mp3') as f:
        with urllib.request.urlopen(url, timeout=120) as r:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        f.flush()
        pcm = subprocess.run([FFMPEG, '-loglevel', 'error', '-i', f.name, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                             check=True, capture_output=True).stdout
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768


@torch.inference_mode()
def emissions(wav: np.ndarray) -> torch.Tensor:
    """Log-probabilities per 20 ms frame for the whole recording, computed in overlapping windows."""
    x = torch.from_numpy(wav)
    parts = []
    for start in range(0, len(x), CHUNK):
        a, b = max(0, start - CONTEXT), min(len(x), start + CHUNK + CONTEXT)
        em, _ = model(x[a:b].unsqueeze(0))
        em = torch.log_softmax(em[0], dim=-1)
        rate = em.shape[0] / (b - a)  # frames per sample
        keep_from = round((start - a) * rate)
        keep_to = keep_from + round((min(start + CHUNK, len(x)) - start) * rate)
        parts.append(em[keep_from:keep_to])
    return torch.cat(parts)


def loudness(wav: np.ndarray) -> np.ndarray:
    """dB per 10 ms."""
    hop = SR // 100
    n = len(wav) // hop
    return 20 * np.log10(np.sqrt((wav[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-6)


def pause_between(db: np.ndarray, lo_ms: float, hi_ms: float, near_ms: float, thr: float, min_ms: int = 120) -> tuple[float, int]:
    """Middle of the longest quiet run (≥ min_ms) in [lo, hi], and its length; (near, 0) when the ayat are joined."""
    lo, hi = max(0, int(lo_ms // 10)), min(len(db), int(hi_ms // 10) + 1)
    best, run_start = (0, 0, 0), None  # (length, start, end) in frames
    for i in range(lo, hi + 1):
        quiet = i < hi and db[i] < thr
        if quiet and run_start is None:
            run_start = i
        elif not quiet and run_start is not None:
            ln = i - run_start
            if ln > best[0] or (ln == best[0] and abs((run_start + i) * 5 - near_ms) < abs((best[1] + best[2]) * 5 - near_ms)):
                best = (ln, run_start, i)
            run_start = None
    if best[0] * 10 < min_ms:
        return near_ms, 0
    return (best[1] + best[2]) * 5, best[0] * 10


def reference_timings(read: int, surah: int) -> dict[int, tuple[int, int]]:
    """mp3quran's ayah → (start ms, end ms) for this recording.
    The body may start with PHP warnings (read 31 surah 33): the JSON is parsed from its first '['."""
    with urllib.request.urlopen(f'{TIMING}?surah={surah}&read={read}', timeout=60) as r:
        body = r.read()
    k = body.find(b'[')
    if k < 0:
        raise ValueError(f'no JSON in the timing reply for surah {surah} read {read}: {body[:80]!r}')
    return {x['ayah']: (x['start_time'], x['end_time']) for x in json.loads(body[k:]) if x['ayah'] >= 1}


def groups_of(ayat: list[dict], ref: dict[int, tuple[int, int]] | None, total_ms: float) -> list[tuple[int, int, float, float]]:
    """(first ayah index, last + 1, from ms, to ms) of each piece aligned on its own."""
    if not ref or total_ms <= GROUP_S * 1000:
        return [(0, len(ayat), 0, total_ms)]
    missing = [a['a'] for a in ayat if a['a'] not in ref]
    if missing:  # mp3quran lacks an ayah (read 31 and 112, surah 9: no 129): it shares its neighbour's range, so the
        ref = dict(ref)  # surah is still cut into pieces instead of one piece the model cannot hold (a 36 min surah segfaults)
        print(f'reference timings miss ayat {missing}: joined to a neighbour', flush=True)
        for a in missing:
            near = ref.get(a - 1) or ref.get(a + 1) or next((ref[b] for b in sorted(ref) if b > a), None)
            if near is None:
                return [(0, len(ayat), 0, total_ms)]
            ref[a] = near
    out, i0 = [], 0
    for i in range(1, len(ayat) + 1):
        if i == len(ayat) or ref[ayat[i]['a']][1] - ref[ayat[i0]['a']][0] > GROUP_S * 1000:  # ayah i would overflow
            lo = 0 if i0 == 0 else ref[ayat[i0]['a']][0] - MARGIN_S * 1000
            hi = total_ms if i == len(ayat) else ref[ayat[i - 1]['a']][1] + MARGIN_S * 1000
            out.append((i0, i, max(0, lo), min(total_ms, hi)))
            i0 = i
    return out


def align_surah(ayat: list[dict], wav: np.ndarray, words: bool = False, ref: dict | None = None) -> list[dict]:
    em = emissions(wav)
    frame_s = len(wav) / SR / em.shape[0]
    star = DICT['*']
    spans, owner = [], []  # one span per token; (ayah index, word index) of each token, star = (-1,-1)
    for i0, i1, lo_ms, hi_ms in groups_of(ayat, ref, len(wav) / SR * 1000):
        f0, f1 = int(lo_ms / 1000 / frame_s), min(em.shape[0], int(hi_ms / 1000 / frame_s) + 1)
        tokens, own = [star], [(-1, -1)]
        for i in range(i0, i1):
            a = ayat[i]
            for j, w in words_of(a['t'], a['s'], a['a']):
                for c in w:
                    tokens.append(DICT[c])
                    own.append((i, j))
            tokens.append(star)
            own.append((-1, -1))
        labels, scores = F.forced_align(em[f0:f1].unsqueeze(0), torch.tensor([tokens], dtype=torch.int32), blank=0)
        sp = F.merge_tokens(labels[0], scores[0].exp())
        assert len(sp) == len(tokens), (len(sp), len(tokens))
        for x in sp:
            x.start += f0
            x.end += f0
        spans += sp
        owner += own
    first = {}
    last = {}
    conf: dict[int, list[float]] = {}
    word_span: dict[tuple[int, int], list[int]] = {}  # (ayah index, printed word) → [first frame, last frame]
    for sp, (i, j) in zip(spans, owner):
        if i < 0:
            continue
        word_span.setdefault((i, j), [sp.start, sp.end])[1] = sp.end
        first.setdefault(i, sp.start)
        last[i] = sp.end
        conf.setdefault(i, []).append(float(sp.score))
    # The aligner puts a boundary anywhere in the pause between two ayat (or a little into the speech): move it to
    # the middle of the real pause, measured on the audio, as the mp3quran timings do.
    db = loudness(wav)
    thr = float(np.percentile(db, 10)) + 8
    ms = lambda f: f * frame_s * 1000
    bounds, pauses = [], []
    spans_of = lambda i: [word_span[k] for k in sorted(k for k in word_span if k[0] == i)]  # the ayah's words in order
    for i in range(len(ayat)):
        prev_end = ms(last[i - 1]) if i else ms(first[i]) - 2500  # before ayah 1: the basmala / isti'adha
        b, p = pause_between(db, min(prev_end, ms(first[i])) - 300, ms(first[i]) + 400, ms(first[i]), thr)
        # The boundary stays between the words it separates, since the first word is snapped to it: after the previous
        # ayah's last word starts (aligned late, after a long pause before it: Minshawi 2:259, Doori 53:27) and before
        # this ayah's second word (a soft first word like «ما» read as the pause: Shuraim 101:2, 35:21, 96:12).
        if i:
            b = max(b, ms(spans_of(i - 1)[-1][0]) + 20)
        sp = spans_of(i)
        if len(sp) > 1:
            b = min(b, ms(sp[1][0]) - 20)
        bounds.append(b)
        pauses.append(p)
    out = []
    for i, a in enumerate(ayat):
        end = bounds[i + 1] if i + 1 < len(ayat) else min(len(wav) / SR * 1000, ms(last[i]) + 400)
        out.append({'ayah': a['a'], 'start_time': round(bounds[i]), 'end_time': round(end), 'pause_ms': pauses[i],
                    'score': round(float(np.mean(conf[i])), 3)})
        if words:  # [printed word index, start ms, end ms, quiet ms before it]; the first word starts where the ayah does
            ws = sorted((j, round(ms(f)), round(ms(e))) for (k, j), (f, e) in word_span.items() if k == i)
            # quiet before a word = longest quiet run (≥ 50 ms) around the gap from the previous word: a breath or
            # waqf when long (≥ ~250 ms), where a longer playback starts (the beginning of the jumla).
            quiet = [pauses[i]] + [pause_between(db, ws[n - 1][2] - 100, st + 100, st, thr, 50)[1]
                                   for n, (_j, st, _e) in enumerate(ws) if n]
            out[-1]['words'] = [[j, round(bounds[i]) if n == 0 else st, en, quiet[n]] for n, (j, st, en) in enumerate(ws)]
    return out


def main():
    riwaya, out_dir = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    folder = FOLDERS.get(riwaya)
    if '--folder' in args:
        k = args.index('--folder')
        folder = args[k + 1]
        args = args[:k] + args[k + 2:]
    words = '--words' in args
    args = [x for x in args if x != '--words']
    read = None
    if '--timings' in args:
        k = args.index('--timings')
        read = int(args[k + 1])
        args = args[:k] + args[k + 2:]
    surahs = [int(x) for x in args] or list(range(1, 115))
    quran = json.load(open(os.path.join(ROOT, 'client/public/riwayat', riwaya, 'quran.json')))
    os.makedirs(out_dir, exist_ok=True)
    for s in surahs:
        path = os.path.join(out_dir, f'{s:03d}.json')
        if os.path.exists(path):
            continue
        ayat = [a for a in quran if a['s'] == s]
        wav = load_audio(f'{folder}{s:03d}.mp3')
        res = align_surah(ayat, wav, words, reference_timings(read, s) if read else None)
        json.dump(res, open(path + '.tmp', 'w'), ensure_ascii=False)
        os.replace(path + '.tmp', path)
        low = [r['ayah'] for r in res if r['score'] < 0.5]
        print(f'{s:3d}: {len(res)} ayat, {len(wav) / SR / 60:.1f} min, low-confidence ayat: {low}', flush=True)


if __name__ == '__main__':
    main()
