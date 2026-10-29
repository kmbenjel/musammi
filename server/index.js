const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ override: true });

const app = express();
const PORT = process.env.PORT || 3000;
// The Shamela library behind the Cloudflare app: only callers with the private key may read it.
const ACCESS_KEY = process.env.ACCESS_KEY;
if (!ACCESS_KEY) {
  console.warn('⚠️ WARNING: ACCESS_KEY is not set: anyone with the address can read the library');
}

app.use(express.json());

function requireKey(req, res, next) {
  const given = String(req.headers['x-access-key'] || '');
  const ok =
    !ACCESS_KEY ||
    (given.length === ACCESS_KEY.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ACCESS_KEY)));
  if (!ok) return res.status(401).json({ ok: false, error: 'افتح التطبيق من رابطك الخاص مرة واحدة' });
  next();
}

// Tafsir from the local Shamela library: Shamela's own ayah index (service/tafseer.db, Hafs ids) points
// to the page of each tafsir that explains the ayah; the page text comes from its CLI.
const { execFile } = require('child_process');
const SHAMELA_DB = path.join(process.env.HOME || '', '.local/share/shamela/database/service/tafseer.db');
const SHAMELA_CLI = path.join(process.env.HOME || '', '.local/bin/shamela_search');
const TAFSIR_BOOKS = {
  ibn_juzay: 30186, // التسهيل لعلوم التنزيل (مالكي، موجز)
  ibn_kathir: 1503,
  tabari: 7798,
  zad_almasir: 23619,
  wasit: 115098, // التفسير الوسيط - مجمع البحوث
  irab: 22916, // الجدول في إعراب القرآن
};
// A warm Shamela engine (scripts/shamela_daemon.py, a child of this server): the CLI starts a JVM per call
// (1.5-4 s), the daemon answers in milliseconds. Falls back to the CLI while it starts or if it died.
const DAEMON_PORT = 3901;
// the Python that can load the Shamela CLI (its virtualenv)
const SHAMELA_PYTHON = process.env.SHAMELA_PYTHON || path.join(process.env.HOME || '', '.venv/bin/python');
let daemon = null;
function startDaemon() {
  daemon = require('child_process').spawn(SHAMELA_PYTHON, [path.join(__dirname, '..', 'scripts', 'shamela_daemon.py'), String(DAEMON_PORT)], { stdio: 'ignore' });
  daemon.on('exit', () => setTimeout(startDaemon, 5000));
}
startDaemon();
process.on('exit', () => daemon?.kill());

/** cmd = ['search', q, '--book-id', id, '--limit', n] or ['page', book, pageId]; resolves to the CLI's JSON. */
async function shamela(cmd) {
  const url =
    cmd[0] === 'search'
      ? `http://127.0.0.1:${DAEMON_PORT}/search?` + new URLSearchParams({ q: cmd[1], book: cmd[3], limit: cmd[5] })
      : `http://127.0.0.1:${DAEMON_PORT}/page?` + new URLSearchParams({ book: cmd[1], page: cmd[2] });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (r.ok) return await r.json();
  } catch {
    /* daemon not up: use the CLI */
  }
  return new Promise((resolve, reject) =>
    execFile(SHAMELA_CLI, [...cmd, '--json'], { timeout: 20000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'))));
      } catch (e) {
        reject(e);
      }
    }),
  );
}

let tafseerDb = null;
function tafsirPage(hafsId, bookId) {
  if (!tafseerDb) {
    const { DatabaseSync } = require('node:sqlite');
    tafseerDb = new DatabaseSync(SHAMELA_DB, { readOnly: true });
  }
  return tafseerDb.prepare('SELECT page_id FROM service WHERE key_id = ? AND book_id = ? ORDER BY page_id LIMIT 1').get(hafsId, bookId)?.page_id;
}

// ?hafs=<Hafs global ayah id> (the client maps its riwaya's numbering with riwayat/<key>/to_hafs.json)
app.get('/api/tafsir', requireKey, (req, res) => {
  const book = TAFSIR_BOOKS[req.query.book] ? String(req.query.book) : 'ibn_juzay';
  const hafsId = Number(req.query.hafs);
  if (!hafsId) return res.status(404).json({ ok: false, error: 'لا توجد هذه الآية' });
  let pageId;
  try {
    pageId = tafsirPage(hafsId, TAFSIR_BOOKS[book]);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'مكتبة الشاملة غير متاحة: ' + e.message });
  }
  if (!pageId) return res.status(404).json({ ok: false, error: 'لا يوجد كلام لهذا التفسير على هذه الآية' });
  shamela(['page', String(TAFSIR_BOOKS[book]), String(pageId)]).then((p) => {
    try {
      let body = String(p.body || '');
      // keep this ayah's section when the page is marked by ayah anchors
      const at = body.indexOf(`aya-${hafsId}"`);
      if (at >= 0) {
        const next = body.indexOf('<span id="aya-', at + 10);
        const section = body.slice(body.lastIndexOf('<', at), next > 0 ? next : undefined);
        if (section.length > 200) body = section;
      }
      body = body.replace(/<[^>]+>/g, '').replace(/\r/g, '\n').replace(/\(¬\d+\)/g, '').trim().slice(0, 3500);
      res.json({ ok: true, book: p.book_name, author: p.author, part: p.part, page: p.page, text: body });
    } catch {
      res.status(500).json({ ok: false, error: 'تعذّرت قراءة الشاملة' });
    }
  }, () => res.status(500).json({ ok: false, error: 'تعذّرت قراءة الشاملة' }));
});

// Word / topic search in a few reference books of the local Shamela library (one CLI call, ~1.5 s).
const LIBRARY_BOOKS = {
  badour: 57, // البدور الزاهرة في القراءات العشر المتواترة - عبد الفتاح القاضي
  nashr: 22642, // النشر في القراءات العشر - ابن الجزري
  itqan: 11728, // الإتقان في علوم القرآن - السيوطي
};
const strip = (t) => t.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
app.get('/api/library', requireKey, (req, res) => {
  const book = LIBRARY_BOOKS[req.query.book];
  const q = String(req.query.q || '').slice(0, 80).trim();
  if (!book || !q) return res.status(400).json({ ok: false, error: 'كتاب أو بحث غير صالح' });
  shamela(['search', q, '--book-id', String(book), '--limit', '3']).then((d) => {
    try {
      const terms = strip(q).split(/\s+/).filter((w) => w.length > 1);
      const results = (d.results || []).slice(0, 3).map((r) => {
        // searched and cut on the text without tashkeel, so the offsets match
        const plain = strip(String(r.body || '').replace(/<[^>]+>/g, '').replace(/\r/g, '\n').replace(/\(¬\d+\)/g, ''));
        const at = terms.map((t) => plain.indexOf(t)).find((i) => i >= 0) ?? 0;
        const from = Math.max(0, at - 300);
        return { book: r.book_name, part: r.part, page: r.page, text: plain.slice(from, from + 1400) };
      });
      res.json({ ok: true, results });
    } catch {
      res.status(500).json({ ok: false, error: 'تعذّر البحث في الشاملة' });
    }
  }, () => res.status(500).json({ ok: false, error: 'تعذّر البحث في الشاملة' }));
});

// The app itself lives on Cloudflare (musammi.benjelloun.dev); this laptop only serves the Shamela library
// to it. The old address sends everyone there (with ?k=…), and an old installed app drops its worker.
const APP_ORIGIN = 'https://musammi.benjelloun.dev';
app.get('/sw.js', (req, res) => res.type('application/javascript').send('self.registration.unregister();'));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Endpoint not found' });
  }
  res.redirect(301, APP_ORIGIN + req.originalUrl);
});

const http = require('http');
const https = require('https');

// HTTP server
http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`[Hifz-Warsh Server] HTTP running on http://0.0.0.0:${PORT}`);
});

// HTTPS server for Mobile Chrome (Microphone & Camera permission requirements)
const certPath = path.join(__dirname, '..', 'certs', 'cert.pem');
const keyPath = path.join(__dirname, '..', 'certs', 'key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[Hifz-Warsh Server] HTTPS running on https://0.0.0.0:${HTTPS_PORT}`);
    });
  } catch (err) {
    console.warn('Failed to start HTTPS server:', err.message);
  }
}
