#!/usr/bin/env python3
"""Export one Shamela tafsir as static JSON per surah (Hafs ayah ids → text), so the app can serve it
without the laptop. Uses Shamela's own ayah index (service/tafseer.db) and its CLI. Resumable.
Usage: export_tafsir.py <book_key> <book_id>"""
import json, os, re, sqlite3, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
key, book = sys.argv[1], int(sys.argv[2])
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(BASE, 'data', 'tafsir', key)
os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join(OUT, '_pages.jsonl')
db = sqlite3.connect('file:' + os.path.expanduser('~/.local/share/shamela/database/service/tafseer.db') + '?mode=ro', uri=True)
rows = db.execute('SELECT key_id, MIN(page_id) FROM service WHERE book_id=? GROUP BY key_id', (book,)).fetchall()
pages = sorted({p for _, p in rows})
done = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        d = json.loads(line); done[d['page_id']] = d
todo = [p for p in pages if p not in done]
print(f'{key}: {len(rows)} ayat, {len(pages)} pages, {len(todo)} to fetch', flush=True)
def fetch(p):
    out = subprocess.run([os.path.expanduser('~/.local/bin/shamela_search'), 'page', str(book), str(p), '--json'], capture_output=True, text=True, timeout=60)
    d = json.loads(out.stdout)
    return {'page_id': p, 'part': d.get('part'), 'page': d.get('page'), 'body': d.get('body', ''), 'book': d.get('book_name'), 'author': d.get('author')}
with open(CACHE, 'a') as f, ThreadPoolExecutor(4) as ex:
    for i, d in enumerate(ex.map(fetch, todo)):
        f.write(json.dumps(d, ensure_ascii=False) + '\n'); f.flush(); done[d['page_id']] = d
        if i % 100 == 0: print(i, '/', len(todo), flush=True)
hafs = json.load(open(os.path.join(BASE, 'data', 'riwayat', 'hafs', 'data.json')))
sura_of = {x['id']: x['sora'] for x in hafs}
per = {}
for hid, p in rows:
    body = done[p]['body']
    at = body.find(f'aya-{hid}"')
    if at >= 0:
        nxt = body.find('<span id="aya-', at + 10)
        sec = body[body.rfind('<', 0, at): nxt if nxt > 0 else None]
        if len(sec) > 200: body = sec
    text = re.sub(r'\(¬\d+\)', '', re.sub(r'<[^>]+>', '', body)).replace('\r', '\n').strip()[:3500]
    per.setdefault(sura_of[hid], {})[hid] = {'text': text, 'part': done[p]['part'], 'page': done[p]['page']}
meta = next(iter(done.values()))
for s, m in per.items():
    json.dump({'book': meta['book'], 'author': meta['author'], 'ayat': m}, open(os.path.join(OUT, f'{s}.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('written', len(per), 'surahs')
