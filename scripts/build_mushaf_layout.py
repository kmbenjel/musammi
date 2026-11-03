#!/usr/bin/env python3
"""The Warsh mushaf page by page, 15 lines each, as the Madina mushaf (KFGQPC, 1441) sets them, in the app's own
Warsh font: client/public/riwayat/warsh/mushaf.json, for the mushaf mode (client/src/mushaf/).

The KFGQPC data gives each ayah's page and first and last line, not where its words break inside. So the words of
an ayah that spans lines are spread over them here: each word measured in the font (HarfBuzz), and the breaks
chosen so that every line comes as close as possible to one common width, the width of a full line. Then each line
is brought to that width as print does it, by kashida: tatweels shared out evenly among its words (each at its
word's last joining point), measured again. The app sizes the font so that a full line fills the page, and spaces
the words of each line to its edges for what is left.

  uv run --with uharfbuzz --with fonttools --with brotli scripts/build_mushaf_layout.py

Output: {"lines": 15, "width": W, "pages": [{"l": [line, ... 15], "f": scale?}, ...]}, a line being
  {"h": surah}            the surah's name in its frame
  {"b": 1}                the basmala
  null                    nothing (pages 1 and 2 hold 8 lines)
  [[ayah id, k0, k1], …]  printed words k0..k1 of each ayah on it (k: tokens with letters, as the tracker and the
                          word timings count them); the ayah's number follows its last word.
"f": the page's font is that much smaller: one of its lines is longer than W in this font.
"k": the kashida, [ayah id, k, at, n]: n tatweels go into printed word k at character `at` (the word as printed,
     «۞ » before it if it has one).
"c": lines kashida cannot bring to SHORT of W (few words, few joining letters): set in the middle, unstretched,
     at the usual spacing, as print sets the last line of a surah.
"""
import io, json, os, re, statistics, unicodedata
import uharfbuzz as hb
from fontTools.ttLib import TTFont

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RAW = os.path.join(BASE, 'data', 'riwayat', 'warsh', 'data.json')
FONT = os.path.join(BASE, 'client', 'public', 'riwayat', 'warsh', 'font.woff2')
OUT = os.path.join(BASE, 'client', 'public', 'riwayat', 'warsh', 'mushaf.json')
LETTERS = re.compile('[ء-يٱ-ۓ]')
LINES = 15
MARK_EM = {1: 1.05, 2: 1.15, 3: 1.4}  # the ayah number's disc (MushafPage.css .num), in em, by digits
PERCENTILE = 0.985  # W: a full line; the few longer ones shrink their page (f)
SHORT = 0.85  # a line kashida cannot bring this close to W is centred, unstretched
KASHIDA = '\u0640'
MAX_KASHIDA = 8  # tatweels in one word
DUAL = set('بتثجحخسشصضطظعغفقكلمنهيىئ\u0640')  # letters that join the letter after them
JOINS = DUAL | set('اأإآٱدذرزوؤةے')  # letters that join the letter before them
ALEFS = set('اأإآٱ')


def kashida_at(word):
    """Where a tatweel goes in this word: before the letter after its last joining point (after the marks of the letter
    before), not inside lam-alif nor the name of Allah. None: nowhere."""
    bases = [(i, ch) for i, ch in enumerate(word) if unicodedata.category(ch) not in ('Mn', 'Me')]
    letters = ''.join(ch for _, ch in bases)
    allah = letters.find('لله')
    best = None
    for n, ((i, a), (j, b)) in enumerate(zip(bases, bases[1:])):
        if a not in DUAL or b not in JOINS or (a == 'ل' and b in ALEFS): continue
        if allah >= 0 and allah <= n <= allah + 1: continue
        best = j
    return best


def font():
    tt = TTFont(FONT)
    tt.flavor = None
    buf = io.BytesIO()
    tt.save(buf)
    face = hb.Face(buf.getvalue())
    f = hb.Font(face)
    return f, face.upem


def measure(f, upem, text):
    b = hb.Buffer()
    b.add_str(text)
    b.guess_segment_properties()
    hb.shape(f, b, {})
    return sum(p.x_advance for p in b.glyph_positions) / upem  # em


def main():
    d = json.load(open(RAW))
    f, upem = font()
    space = measure(f, upem, ' ')
    ayat = []  # (id, words as printed, widths in em, first global line, last global line)
    for x in d:
        pages = [int(p) for p in str(x['page']).split('-')]
        g0 = (pages[0] - 1) * LINES + x['line_start'] - 1
        g1 = (pages[-1] - 1) * LINES + x['line_end'] - 1
        toks = x['aya_text'].replace('\xa0', ' ').split()
        num = toks.pop() if toks and re.fullmatch('[٠-٩]+', toks[-1]) else None
        assert num, x['id']
        words, pre = [], ''
        for t in toks:
            if LETTERS.search(t):
                words.append(pre + t)
                pre = ''
            else:
                pre += t + ' '  # ۞ goes with the word after it
        widths = [measure(f, upem, w) for w in words]
        widths[-1] += space + MARK_EM[len(num)]
        ayat.append((x['id'], words, widths, g0, g1))

    # words in mushaf order, each with the global lines it may stand on
    W_ = []  # (ayah index, k, width, lo, hi)
    for i, (_, words, widths, g0, g1) in enumerate(ayat):
        n = len(words)
        for k in range(n):
            lo, hi = g0, g1
            if k == 0: hi = g0  # the first word on the ayah's first line, the last on its last
            if k == n - 1: lo = g1
            W_.append((i, k, widths[k], lo, hi))

    def width(a, b):  # words a..b-1 on one line
        return sum(w[2] for w in W_[a:b]) + space * (b - a - 1)

    def solve(target):
        """Breaks of minimum cost, piece by piece: a piece ends where an ayah ends on the line before the next starts."""
        lines = {}  # global line → (first word, end word)
        start = 0
        while start < len(W_):
            # a piece goes on while the next ayah may start on the line the previous one ends on
            end = start + 1
            while end < len(W_) and not (W_[end][1] == 0 and W_[end][3] > W_[end - 1][4]):
                end += 1
            # DP over (word j starts line L)
            best = {(start, W_[start][3]): (0.0, None)}
            for j in range(start, end):
                for L in [L for (jj, L) in list(best) if jj == j]:
                    cost, _ = best[(j, L)]
                    for e in range(j + 1, end + 1):
                        if not (W_[e - 1][3] <= L <= W_[e - 1][4]): break
                        w = width(j, e)
                        c = cost + ((w - target) / target) ** 2 + (10 * ((w - target * 1.06) / target) ** 2 if w > target * 1.06 else 0)
                        if e == end:
                            if L == W_[e - 1][4]:
                                key = (end, -1)
                                if key not in best or c < best[key][0]: best[key] = (c, (j, L))
                            continue
                        L2 = L + 1 if W_[e][1] != 0 or W_[e][3] <= L + 1 else W_[e][3]
                        if not (W_[e][3] <= L2 <= W_[e][4]): continue
                        key = (e, L2)
                        if key not in best or c < best[key][0]: best[key] = (c, (j, L))
            assert (end, -1) in best, (start, ayat[W_[start][0]][0])
            key, e = (end, -1), end
            while True:
                _, prev = best[key]
                if prev is None: break
                j, L = prev
                lines[L] = (j, e)
                key, e = prev, j
            start = end
        return lines

    # W: from the lines as they come at a first guess, then again at the width found
    total = sum(w[2] for w in W_)
    target = total / len({g for (_, _, _, g0, g1) in ayat for g in range(g0, g1 + 1)}) * 1.1
    for _ in range(3):
        lines = solve(target)
        ws = sorted(width(a, b) for g, (a, b) in lines.items() if g >= 2 * LINES)  # pages 1 and 2 are centred
        target = ws[int(len(ws) * PERCENTILE)]
        print(f'W={target:.2f}em  median fill {statistics.median(ws) / target:.3f}  p5 {ws[int(len(ws) * .05)] / target:.3f}')

    tw = measure(f, upem, KASHIDA)
    fills = []

    def stretch(a, b, target):
        """Kashida for words a..b-1: as many tatweels as the line lacks, one word after the other, then fewer while it
        is too long (a tatweel can undo a ligature, so each word is measured again)."""
        words = [(w, ayat[w[0]][1][w[1]]) for w in W_[a:b]]
        at = {i: kashida_at(t) for i, (_, t) in enumerate(words)}
        cand = [i for i in at if at[i] is not None]
        n = dict.fromkeys(cand, 0)
        budget = int((target - width(a, b)) / tw)
        while budget > 0 and cand and any(n[i] < MAX_KASHIDA for i in cand):
            for i in cand:
                if budget and n[i] < MAX_KASHIDA:
                    n[i] += 1
                    budget -= 1
        base = width(a, b)
        delta = {}
        def grown(i):
            t = words[i][1]
            return measure(f, upem, t[:at[i]] + KASHIDA * n[i] + t[at[i]:]) - measure(f, upem, t)
        for i in cand:
            if n[i]: delta[i] = grown(i)
        while base + sum(delta.values()) > target and delta:
            i = max(delta, key=lambda x: n[x])
            n[i] -= 1
            if n[i]: delta[i] = grown(i)
            else: del delta[i]
        got = base + sum(delta.values())
        fills.append(got / target)
        return [[ayat[words[i][0][0]][0], words[i][0][1], at[i], n[i]] for i in delta], got

    headers = {}
    for i, (aid, *_r, g0, g1) in enumerate(ayat):
        s, a = d[i]['sura_no'], d[i]['aya_no']
        if a == 1:
            if s == 9: headers[g0 - 1] = {'h': s}
            else: headers[g0 - 2], headers[g0 - 1] = {'h': s}, {'b': 1}
    pages = []
    for p in range(604):
        out, longest, short, kash = [], 0, [], []
        for ln in range(LINES):
            g = p * LINES + ln
            if g in lines:
                a, b = lines[g]
                segs = []
                for w in W_[a:b]:
                    aid = ayat[w[0]][0]
                    if segs and segs[-1][0] == aid: segs[-1][2] = w[1]
                    else: segs.append([aid, w[1], w[1]])
                out.append(segs)
                longest = max(longest, width(a, b))
                got = width(a, b)
                if p >= 2 and got < target:
                    add, got = stretch(a, b, target)
                    if got >= target * SHORT: kash += add
                if got < target * SHORT: short.append(ln)
            else:
                out.append(headers.get(g))
        page = {'l': out}
        if longest > target and p >= 2: page['f'] = round(target / longest, 3)
        if short and p >= 2: page['c'] = short
        if kash: page['k'] = kash
        pages.append(page)
    shrunk = [p for p in pages if 'f' in p]
    print(f'{len(shrunk)} pages shrunk, smallest f={min((p["f"] for p in shrunk), default=1)}; '
          f'{sum(len(p.get("c", [])) for p in pages)} short lines centred; {sum(len(p.get("k", [])) for p in pages)} words stretched; '
          f'lines after kashida: median fill {statistics.median(fills):.3f}, p5 {sorted(fills)[len(fills) // 20]:.3f}')
    json.dump({'lines': LINES, 'width': round(target, 3), 'pages': pages}, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('wrote', OUT, os.path.getsize(OUT))


if __name__ == '__main__':
    main()
