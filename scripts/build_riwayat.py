#!/usr/bin/env python3
"""Builds the app's data for every KFGQPC riwaya (data/riwayat/<key>/data.json + font.woff2, from
github.com/thetruetruth/quran-data-kfgqpc) into client/public/riwayat/<key>/:

  quran.json         compact ayat {id,s,a,p,j,t,c} (t = KFGQPC text for its own font, c = normalized)
  surahs.json        surah names and ayah counts in this riwaya's counting
  mutashabihat.json  phrases (4-5 opening words) shared by several ayat, for the exam
  diff.json          words read differently from Hafs (farsh), keyed "surah:ayah" in this riwaya's
                     numbering: the live prompt lists them so the model stops "correcting" to Hafs
  font.woff2

  to_hafs.json       "surah:ayah" → Hafs global ayah id (Shamela's tafsir index; other numberings)

(to_hafs.json is also kept in data/riwayat/<key>/ for the server).
"""
import json, os, re, shutil, difflib
from collections import defaultdict

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RAW = os.path.join(BASE, 'data', 'riwayat')
PUBLIC = os.path.join(BASE, 'client', 'public', 'riwayat')
KEYS = ['warsh', 'qaloon', 'hafs', 'shouba', 'doori', 'soosi', 'bazzi', 'qumbul']
NUM = re.compile(r'[٠-٩\d۝۞۩]+')


def normalize_arabic(text):
    """Letters only, for matching speech transcripts (same rules as client/src/utils/arabic.ts)."""
    text = re.sub(r'[٠-٩\d]+', '', text.strip())
    text = re.sub(r'[ۖ-ۛ۞\xa0]', ' ', text)
    text = re.sub(r'ٰ', 'ا', text)
    text = re.sub(r'[ؐ-ًؚ-ٟۜ۟-۪ۨ-ۭ‏‎ـ]', '', text)
    text = re.sub(r'[إأآٱ]', 'ا', text)
    text = re.sub(r'[ىيۦے]', 'ي', text)
    text = re.sub(r'ة', 'ه', text)
    text = re.sub(r'الرحمان', 'الرحمن', text)
    return re.sub(r'\s+', ' ', text).strip()


def words(t):
    return [w for w in NUM.sub(' ', t.replace('\xa0', ' ')).split() if re.search('[ء-ي]', w)]


def norm(w, vowels):
    """Word key for the Hafs comparison: ignores orthography and usul (hamza forms, naql, madd
    letters, silat al-mim, final vowels), keeps letters + damma/kasra + dagger alif (farsh)."""
    w = w.replace('ے', 'ي').replace('ی', 'ي').replace('ى', 'ي').replace('ة', 'ه').replace('۪', 'َ')
    w = w.replace('ؤ', 'و').replace('ئ', 'ي').replace('ۓ', 'ي')
    w = re.sub(r'[ۥۦـءٕٔ]', '', w)
    w = re.sub(r'^[اأإآٱ]', 'H', w)
    w = re.sub(r'^([وفبكل][َ-ْ]*)[ا]', r'\1H', w)
    w = re.sub(r'[أإآٱ]', 'H', w)
    w = w.replace('ٰ', 'A').replace('ا', 'A')
    w = re.sub(r'[^ب-يُِAH]', '', w)
    w = w.replace('A', 'H')
    w = re.sub(r'[ُِ]*H[ُِ]*', 'H', w)
    w = re.sub(r'H+', 'H', w)
    w = re.sub(r'^([وفبكل]{0,2})Hل', r'\1', w)
    w = re.sub(r'[ُِ]*H?$', '', w)
    w = re.sub(r'[ُِ]+$', '', w)
    w = re.sub(r'(?<=م)ُ', '', w)
    if not vowels:
        w = re.sub(r'[ُِAH]', '', w)
    return w


def load(key):
    d = json.load(open(os.path.join(RAW, key, 'data.json')))
    for x in d:
        x['s'] = int(x.get('sura_no') or x.get('sora'))
        x['a'] = int(x['aya_no'])
    return d


def compare(R, H, hid):
    """Farsh differences of riwaya R from Hafs H, and the R → Hafs ayah id map."""
    out, to_hafs = {}, {}
    for s in range(1, 115):
        ra = [(x['a'], w) for x in R if x['s'] == s for w in words(x['aya_text'])]
        ha = [(x['a'], w) for x in H if x['s'] == s for w in words(x['aya_text'])]
        sm = difflib.SequenceMatcher(None, [norm(w, 0) for _, w in ra], [norm(w, 0) for _, w in ha], autojunk=False)
        wmap = {}
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                wmap.setdefault(blk.a + k, blk.b + k)
        for i, (a, _) in enumerate(ra):
            if f'{s}:{a}' in to_hafs:
                continue
            j = next((wmap[k] for k in range(i, min(i + 8, len(ra))) if k in wmap), None)
            if j is not None:
                to_hafs[f'{s}:{a}'] = hid[(s, ha[j][0])]
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            pairs = []
            if op == 'equal':
                pairs = [(ra[i1 + k], ha[j1 + k][1]) for k in range(i2 - i1) if norm(ra[i1 + k][1], 1) != norm(ha[j1 + k][1], 1)]
            elif i1 < len(ra):
                pairs = [((ra[i1][0], ' '.join(w for _, w in ra[i1:i2])), ' '.join(w for _, w in ha[j1:j2]))]
            for (a, w), h in pairs:
                w = re.sub(r'[ۖ-ۜ۞۩]', '', w).strip()
                h = re.sub(r'[ۖ-ۜ۞۩]', '', h).strip()
                if w and h and 'ۧ' not in h:
                    out.setdefault(f'{s}:{a}', []).append([w, h])
    return out, to_hafs


def mutashabihat(ayat):
    phrase_map = defaultdict(list)
    for aya in ayat:
        ws, orig = aya['c'].split(), aya['t'].split()
        for n in (4, 5):
            if len(ws) >= n:
                cue = re.sub(r'[٠-٩\d\xa0]+$', '', ' '.join(orig[:n])).strip()
                phrase_map[(n, ' '.join(ws[:n]))].append({'sura': aya['s'], 'aya': aya['a'], 'page': aya['p'], 'juz': aya['j'], 'cue': cue, 'full_text': aya['t']})
    groups, seen = [], set()
    for (n, p), occ in phrase_map.items():
        uniq = list({(o['sura'], o['aya']): o for o in occ}.values())
        if len(uniq) >= 2:
            pair = tuple(sorted((o['sura'], o['aya']) for o in uniq[:2]))
            if pair not in seen:
                seen.add(pair)
                groups.append({'phrase_norm': p, 'word_count': n, 'cue': uniq[0]['cue'], 'occurrences': uniq})
    return groups


H = load('hafs')
hid = {(x['s'], x['a']): x['id'] for x in H}
for key in KEYS:
    R = load(key)
    ayat, surahs = [], {}
    for x in R:
        page = int(str(x['page']).split('-')[0])
        name = (x.get('sura_name_ar') or x.get('sora_name_ar')).strip()
        surahs.setdefault(x['s'], {'no': x['s'], 'name_ar': name, 'name_en': (x.get('sura_name_en') or x.get('sora_name_en')).strip(), 'ayah_count': 0, 'start_page': page, 'start_juz': int(x['jozz'])})
        surahs[x['s']]['ayah_count'] += 1
        ayat.append({'id': int(x['id']), 's': x['s'], 'a': x['a'], 'p': page, 'j': int(x['jozz']), 'h': None, 'th': None, 't': x['aya_text'].strip(), 'c': normalize_arabic(x['aya_text'])})
    diff, to_hafs = ({}, {f"{x['s']}:{x['a']}": x['id'] for x in H}) if key == 'hafs' else compare(R, H, hid)
    out = os.path.join(PUBLIC, key)
    os.makedirs(out, exist_ok=True)
    dump = lambda name, obj: json.dump(obj, open(os.path.join(out, name), 'w'), ensure_ascii=False, separators=(',', ':'))
    dump('quran.json', ayat)
    dump('surahs.json', [surahs[k] for k in sorted(surahs)])
    dump('mutashabihat.json', mutashabihat(ayat))
    dump('diff.json', diff)
    shutil.copy(os.path.join(RAW, key, 'font.woff2'), os.path.join(out, 'font.woff2'))
    json.dump(to_hafs, open(os.path.join(RAW, key, 'to_hafs.json'), 'w'), separators=(',', ':'))
    dump('to_hafs.json', to_hafs)
    print(f'{key:7} {len(ayat)} ayat, {len(diff)} ayat with farsh ({sum(map(len, diff.values()))} words), {len(to_hafs)} mapped to Hafs')
