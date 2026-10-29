#!/usr/bin/env python3
"""Keeps the Shamela search engine (Lucene in a JVM) warm for the app's server: the CLI starts a JVM per
call (1.5-4 s); this answers in milliseconds. Started and restarted by server/index.js; local only.

GET /search?q=…&book=<id>&limit=3   → the CLI's `search --json` result
GET /page?book=<id>&page=<page_id>  → the CLI's `page --json` result
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.machinery import SourceFileLoader
from urllib.parse import parse_qs, urlparse

# the Shamela CLI (a Python script) is loaded as a module; SHAMELA_CLI overrides where it is
cli = SourceFileLoader('shamela_cli', os.environ.get('SHAMELA_CLI', os.path.expanduser('~/.local/bin/shamela_search'))).load_module()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3901


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == '/search':
                res = cli.search_text(q['q'], limit=int(q.get('limit', 3)), book_id=int(q['book']) if q.get('book') else None)
            elif u.path == '/page':
                res = cli.get_page(int(q['book']), q['page'])
            else:
                return self.send_error(404)
            body = json.dumps(res, ensure_ascii=False, default=str).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # report, keep serving
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

    def log_message(self, *args):
        pass


cli.init_lucene()  # start the JVM once, before the first request
print(f'shamela daemon on 127.0.0.1:{PORT}', flush=True)
HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
