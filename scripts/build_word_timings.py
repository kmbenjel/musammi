#!/usr/bin/env python3
"""The app's word timings of a recording, from scripts/align_timings.py --words output.

  python3 scripts/build_word_timings.py IN_DIR [RIWAYA RECITER] [--audio FOLDER_URL]
  e.g. ~/.venvs/hifz-align/bin/python scripts/build_word_timings.py archive/scratch-2026-10-30/words/koshi \\
         warsh laayoun-kouchi --audio https://cdn.mp3quran.net/audio/laayoun-kouchi/r1/

Writes client/public/riwayat/RIWAYA/words/RECITER/NNN.json for every surah in IN_DIR (client/src/live/audio.ts reads
them). One entry per ayah, in order: {"a": ayah, "e": end ms, "w": [start ms of each printed word], "g": [ms of
free time before each word], "j": [the first word of each jumla]}.
- Word k = the k-th printed token of the ayah's text that has Arabic letters (PositionTracker.setRange's `printed`).
  w[0] = the ayah start (middle of the pause before it); a word the aligner has no time for is null in w and g.
- g[k] = start of word k − end of word k−1 as aligned (0 for the first word): how far before the onset a clip may
  start without reaching into the previous word.
- j = the jumlas, the unit playback starts at: word 0 (an ayah start always begins one), then every word before which
  the reciter stops to breathe: a quiet run of ≥ 300 ms in the audio before the word, or ≥ 200 ms after a printed
  waqf mark (al-Kouchi, al-Baqara: real breaths are mostly ≥ 600 ms; 100–200 ms quiet runs are everywhere inside a
  jumla; at a waqf mark he either stops or joins, < 200 ms). A waqf mark he reads through starts no jumla.
  --audio (numpy + ffmpeg: the aligner's venv) measures the quiet runs on the recording, anywhere inside the ayah,
  and the word nearest to where the voice comes back starts the jumla, at that moment: the aligner often stretches
  a word over the breath beside it (al-Baqara: words of 5–10 s), so the quiet between aligned words misses breaths
  (jumlas of up to 57 s). Without --audio: the aligner's own quiet runs between words (4th field, newer aligner only).
  The aligner's gaps are no substitute either: in al-Baqara 2/3 of the gaps ≥ 400 ms have no quiet in the audio.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = os.path.expanduser('~/.local/bin/ffmpeg')
BREATH_MS, WAQF_BREATH_MS = 300, 200
LETTERS = re.compile('[ء-يٱ-ۓ]')  # as PositionTracker.setRange
WAQF = re.compile('[ۖ-ۛ]')


def loudness(url: str):
    """dB per 10 ms of the recording, and the quiet threshold."""
    import numpy as np
    with tempfile.NamedTemporaryFile(suffix='.mp3') as f:
        with urllib.request.urlopen(url, timeout=120) as r:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        f.flush()
        pcm = subprocess.run([FFMPEG, '-loglevel', 'error', '-i', f.name, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
                             check=True, capture_output=True).stdout
    wav = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
    n = len(wav) // 160
    db = 20 * np.log10(np.sqrt((wav[: n * 160].reshape(n, 160) ** 2).mean(1)) + 1e-6)
    return db, quiet_threshold(db)


def loudness_cached(url: str, path: str):
    """loudness(), kept beside the aligner output (IN_DIR/loudness/NNN.npy, ~25 KB per minute) for rebuilds."""
    import numpy as np
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        db, _ = loudness(url)
        np.save(path + '.tmp.npy', db.astype(np.float16))
        os.replace(path + '.tmp.npy', path)
    db = np.load(path).astype(np.float32)
    return db, quiet_threshold(db)


def quiet_threshold(db) -> float:
    """Halfway between the silence (5th percentile) and the voice (70th): recordings differ by 10 dB (al-Mulk is
    quieter than al-Baqara), and align_timings' 10th percentile + 8 dB is the median loudness in al-Mulk."""
    import numpy as np
    return float(np.percentile(db, 5) + np.percentile(db, 70)) / 2


INHALE_MS = 350  # the breath in is audible: quiet, inhale, quiet. Two quiet runs this close are one pause.


def quiet_runs(db, thr: float, lo_ms: float, hi_ms: float, min_ms: int) -> list[tuple[int, int]]:
    """(start ms, end ms) of every pause ≥ min_ms of quiet in [lo, hi] (quiet runs ≥ 100 ms joined across an inhale)."""
    lo, hi = max(0, int(lo_ms // 10)), min(len(db), int(hi_ms // 10) + 1)
    runs, run = [], None
    for i in range(lo, hi + 1):
        if i < hi and db[i] < thr:
            run = i if run is None else run
        elif run is not None:
            if i - run >= 10:
                runs.append([run * 10, i * 10, (i - run) * 10])
            run = None
    out = []
    for r in runs:
        if out and r[0] - out[-1][1] < INHALE_MS:
            out[-1][1] = r[1]
            out[-1][2] += r[2]
        else:
            out.append(r)
    return [(a, b) for a, b, quiet in out if quiet >= min_ms]


def build(rows: list[dict], quran: dict[int, dict], surah: int, audio=None) -> list[dict]:
    out = []
    for r in rows:
        printed = [t for t in quran[r['ayah']]['t'].split() if LETTERS.search(t)]
        n = len(printed)
        w: list[int | None] = [None] * n
        g: list[int | None] = [None] * n
        quiet = [0] * n  # from the aligner (4th field), when no audio
        ws = [x for x in r['words'] if x[0] < n]
        if len(ws) < len(r['words']):
            print(f'{surah}:{r["ayah"]}: words beyond the {n} printed words', file=sys.stderr)
        prev_end = None
        for j, st, en, *rest in ws:
            w[j] = st
            g[j] = 0 if j == 0 or prev_end is None else max(0, st - prev_end)
            quiet[j] = rest[0] if rest else 0
            prev_end = en
        if w[0] is None:  # the first word always has the ayah start
            w[0], g[0] = r['start_time'], 0
        stops = lambda k, ms: ms >= BREATH_MS or ms >= WAQF_BREATH_MS and WAQF.search(printed[k - 1])
        jumla = {0}
        if audio and len(ws) > 1:
            # The breaths, measured on the audio inside the ayah (after the first word, up to the last word's start).
            # The aligner often stretches a word over the breath next to it, so a breath is matched to the word whose
            # start is nearest the moment the voice comes back, and that word starts there.
            # Where the alignment is off (the nearest start ≥ 0.5 s away), a waqf mark next to that word decides.
            for rs, re_ in quiet_runs(*audio, ws[0][2] - 100, ws[-1][1] + 100, WAQF_BREATH_MS):
                # not the last word: before it the ayah's end pause, when the aligner put that word too late
                cand = [k for k in range(1, n - 1) if w[k] is not None and w[k] >= rs - 50]
                if not cand:
                    continue
                k = min(cand, key=lambda m: abs(w[m] - re_))
                if abs(w[k] - re_) >= 500:
                    near = [m for m in (k - 1, k, k + 1) if m in cand and WAQF.search(printed[m - 1])]
                    k = near[0] if len(near) == 1 else k
                prv = next((w[m] for m in range(k - 1, -1, -1) if w[m] is not None), 0)
                nxt = next((w[m] for m in range(k + 1, n) if w[m] is not None), r['end_time'])
                if not stops(k, re_ - rs) or not prv < re_ < nxt:
                    continue
                jumla.add(k)
                w[k], g[k] = re_, re_ - rs
        else:
            jumla |= {k for k in range(1, n) if stops(k, quiet[k])}
        out.append({'a': r['ayah'], 'e': r['end_time'], 'w': w, 'g': g, 'j': sorted(jumla)})
    return out


def main():
    args = sys.argv[1:]
    folder = None
    if '--audio' in args:
        k = args.index('--audio')
        folder = args[k + 1]
        args = args[:k] + args[k + 2:]
    src = args[0]
    riwaya, reciter = (args[1], args[2]) if len(args) > 2 else ('warsh', 'laayoun-kouchi')
    quran = json.load(open(os.path.join(ROOT, 'client/public/riwayat', riwaya, 'quran.json')))
    dst = os.path.join(ROOT, 'client/public/riwayat', riwaya, 'words', reciter)
    os.makedirs(dst, exist_ok=True)
    total, surahs, blind = 0, [], []
    for name in sorted(os.listdir(src)):
        if not re.fullmatch(r'\d{3}\.json', name):
            continue
        s = int(name[:3])
        rows = json.load(open(os.path.join(src, name)))
        if not all('words' in r for r in rows):
            print(f'{name}: no word timings (run align_timings.py with --words)', file=sys.stderr)
            continue
        ayat = {x['a']: x for x in quran if x['s'] == s}
        if sorted(r['ayah'] for r in rows) != sorted(ayat):
            print(f'{name}: ayat differ from quran.json, skipped', file=sys.stderr)
            continue
        audio = loudness_cached(f'{folder}{name[:3]}.mp3', os.path.join(src, 'loudness', name[:3] + '.npy')) if folder else None
        if not audio and any(len(x) < 4 for r in rows for x in r['words']):
            blind.append(s)
        text = json.dumps(build(rows, ayat, s, audio), ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(dst, name), 'w') as f:
            f.write(text)
        total += len(text)
        surahs.append(s)
    print(f'{len(surahs)} surahs → {os.path.relpath(dst, ROOT)}, {total / 1024:.1f} KB')
    if blind:
        print(f'no quiet runs (pass --audio) → jumlas only at the ayah starts in: {blind}', file=sys.stderr)


if __name__ == '__main__':
    main()
