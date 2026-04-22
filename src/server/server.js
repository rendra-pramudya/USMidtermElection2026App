'use strict';

/**
 * US Midterm 2026 — Combined Web Server + Vizrt Push Service
 *
 * Serves the election dashboard on http://localhost:3000 while
 * simultaneously running the Vizrt SHM push service.
 *
 * Routes:
 *   GET  /                    → web/index.html
 *   GET  /api-adapter.js      → web/api-adapter.js
 *   GET  /renderer.js         → src/renderer/renderer.js  (shared with Electron)
 *   GET  /styles.css          → src/renderer/styles.css   (shared with Electron)
 *   GET  /us.svg              → us.svg (project root)
 *   GET  /api/election-data   → parsed election JSON
 *   GET  /api/stats           → Viz Engine connection stats
 *   POST /api/push-now        → trigger manual push
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const { PushService, loadConfig } = require('../shared/pushService');
const { loadAll }                 = require('../shared/parser');

const PORT     = parseInt(process.env.PORT || '3000', 10);
const ROOT     = path.resolve(__dirname, '..', '..');
const WEB_DIR  = path.join(ROOT, 'web');
const RND_DIR  = path.join(ROOT, 'src', 'renderer');

// ── Start Vizrt push service ──────────────────────────────────────────────────
const cfg         = loadConfig();
const pushService = new PushService(cfg);

pushService.on('status', (s) => {
  if (s.type === 'connect')    console.log(`[viz]  connected   → ${s.info.host}:${s.info.port}`);
  if (s.type === 'disconnect') console.log('[viz]  disconnected');
  if (s.type === 'error')      console.error('[viz]  error:', s.error);
});

pushService.on('push', (p) => {
  if (!p.skipped) {
    const ok  = p.pushed  ?? 0;
    const tot = p.total   ?? 0;
    const fail = p.failed  ? ` (${p.failed} failed)` : '';
    console.log(`[push] ${ok}/${tot} keys${fail} — ${p.reason}`);
  }
});

pushService.start();
console.log('[srv]  Vizrt push service started');

// ── MIME map ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function serveFile(res, filePath) {
  try {
    const buf  = fs.readFileSync(filePath);
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

// ── Static route map ──────────────────────────────────────────────────────────
// Web-specific files
const STATIC = {
  '/':              path.join(WEB_DIR, 'index.html'),
  '/index.html':    path.join(WEB_DIR, 'index.html'),
  '/api-adapter.js':path.join(WEB_DIR, 'api-adapter.js'),
  // Shared with Electron renderer (zero duplication)
  '/renderer.js':   path.join(RND_DIR, 'renderer.js'),
  '/styles.css':    path.join(RND_DIR, 'styles.css'),
  // Project root assets
  '/us.svg':        path.join(ROOT, 'us.svg'),
};

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── API: election data (always returns overrides merged with file data) ────
  if (url === '/api/election-data' && method === 'GET') {
    try {
      sendJson(res, pushService.getDataWithOverrides());
    } catch (e) {
      sendJson(res, { error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: Viz Engine stats ─────────────────────────────────────────────────
  if (url === '/api/stats' && method === 'GET') {
    sendJson(res, pushService.getStats());
    return;
  }

  // ── API: manual push ──────────────────────────────────────────────────────
  if (url === '/api/push-now' && method === 'POST') {
    try {
      const result = await pushService.pushNow('web-ui');
      sendJson(res, { ok: true, result: result ?? null });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: single field edit — apply override + push ────────────────────────
  if (url === '/api/field-edit' && method === 'POST') {
    try {
      const override = JSON.parse(await readBody(req));
      pushService.applyOverride(override);
      const result = await pushService.pushNow('field-edit');
      sendJson(res, { ok: true, result: result ?? null });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: batch field edits — apply multiple overrides, push once ──────────
  if (url === '/api/field-edits' && method === 'POST') {
    try {
      const overrides = JSON.parse(await readBody(req));
      for (const o of overrides) pushService.applyOverride(o);
      const result = await pushService.pushNow('field-edits-batch');
      sendJson(res, { ok: true, result: result ?? null });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: clear all overrides + push clean file data ───────────────────────
  if (url === '/api/clear-overrides' && method === 'POST') {
    try {
      pushService.clearOverrides();
      // forceFields=true so per-field keys are pushed even when pushMode='files',
      // ensuring any previously overridden Viz keys are reset to file values.
      const result = await pushService.pushNow('clear-overrides', true);
      sendJson(res, { ok: true, result: result ?? null });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: list current overrides ───────────────────────────────────────────
  if (url === '/api/get-overrides' && method === 'GET') {
    sendJson(res, pushService.getOverrides());
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  const filePath = STATIC[url];
  if (filePath) {
    serveFile(res, filePath);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  US Midterm 2026 — Election Dashboard        │`);
  console.log(`  │  http://localhost:${PORT}                      │`);
  console.log(`  │  Ctrl+C to stop                              │`);
  console.log(`  └─────────────────────────────────────────────┘\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  [error] Port ${PORT} is already in use.`);
    console.error(`  Try:  PORT=3001 node src/server/server.js\n`);
  } else {
    console.error('[server error]', e);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { pushService.stop(); process.exit(0); });
process.on('SIGTERM', () => { pushService.stop(); process.exit(0); });
