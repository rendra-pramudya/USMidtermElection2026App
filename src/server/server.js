'use strict';

/**
 * US Midterm 2026 — Combined Web Server + Vizrt Push Service
 *
 * Serves the election dashboard on http://0.0.0.0:3000 while
 * simultaneously running the Vizrt SHM push service.
 *
 * Routes:
 *   POST /api/login            → authenticate, returns session token
 *   POST /api/logout           → invalidate session token
 *   GET  /api/me               → current user info
 *   GET  /                     → web/index.html
 *   GET  /api-adapter.js       → web/api-adapter.js
 *   GET  /renderer.js          → src/renderer/renderer.js  (shared with Electron)
 *   GET  /styles.css           → src/renderer/styles.css   (shared with Electron)
 *   GET  /us.svg               → us.svg (project root)
 *   GET  /api/election-data    → parsed election JSON          [requires login]
 *   GET  /api/stats            → Viz Engine connection stats   [requires login]
 *   POST /api/push-now         → trigger manual push           [requires editor]
 *   POST /api/field-edit       → apply single override + push  [requires editor]
 *   POST /api/field-edits      → batch overrides + push        [requires editor]
 *   POST /api/clear-overrides  → clear overrides + push        [requires editor]
 *   GET  /api/get-overrides    → list current overrides        [requires login]
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { PushService, loadConfig } = require('../shared/pushService');

const PORT       = parseInt(process.env.PORT || '3000', 10);
const ROOT       = path.resolve(__dirname, '..', '..');
const WEB_DIR    = path.join(ROOT, 'web');
const RND_DIR    = path.join(ROOT, 'src', 'renderer');
const USERS_FILE = path.join(ROOT, 'users.json');

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
    const ok   = p.pushed  ?? 0;
    const tot  = p.total   ?? 0;
    const fail = p.failed  ? ` (${p.failed} failed)` : '';
    console.log(`[push] ${ok}/${tot} keys${fail} — ${p.reason}`);
  }
});

pushService.start();
console.log('[srv]  Vizrt push service started');

// ── Auth ──────────────────────────────────────────────────────────────────────
// sessions: token → { username, role }
const sessions = new Map();

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || [];
  } catch {
    return [];
  }
}

function tokenFromReq(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function getSession(req) {
  const token = tokenFromReq(req);
  return token ? (sessions.get(token) || null) : null;
}

// Returns session or sends 401 and returns null.
function requireLogin(req, res) {
  const session = getSession(req);
  if (!session) { sendJson(res, { error: 'Unauthorized' }, 401); return null; }
  return session;
}

// Returns session or sends 401/403 and returns null.
function requireEditor(req, res) {
  const session = requireLogin(req, res);
  if (!session) return null;
  if (session.role !== 'editor') { sendJson(res, { error: 'Forbidden' }, 403); return null; }
  return session;
}

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
const STATIC = {
  '/':               path.join(WEB_DIR, 'index.html'),
  '/index.html':     path.join(WEB_DIR, 'index.html'),
  '/api-adapter.js': path.join(WEB_DIR, 'api-adapter.js'),
  '/renderer.js':    path.join(RND_DIR, 'renderer.js'),
  '/styles.css':     path.join(RND_DIR, 'styles.css'),
  '/us.svg':         path.join(ROOT, 'us.svg'),
};

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── Auth: login ──────────────────────────────────────────────────────────
  if (url === '/api/login' && method === 'POST') {
    try {
      const { username, password } = JSON.parse(await readBody(req));
      const users = loadUsers();
      const user  = users.find(u => u.username === username && u.password === password);
      if (!user) {
        sendJson(res, { ok: false, error: 'Invalid username or password' }, 401);
        return;
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { username: user.username, role: user.role });
      console.log(`[auth] login: ${user.username} (${user.role})`);
      sendJson(res, { ok: true, token, role: user.role, username: user.username });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 400);
    }
    return;
  }

  // ── Auth: logout ─────────────────────────────────────────────────────────
  if (url === '/api/logout' && method === 'POST') {
    const token = tokenFromReq(req);
    if (token && sessions.has(token)) {
      const s = sessions.get(token);
      console.log(`[auth] logout: ${s.username}`);
      sessions.delete(token);
    }
    sendJson(res, { ok: true });
    return;
  }

  // ── Auth: current user ───────────────────────────────────────────────────
  if (url === '/api/me' && method === 'GET') {
    const session = getSession(req);
    if (!session) {
      sendJson(res, { loggedIn: false }, 401);
    } else {
      sendJson(res, { loggedIn: true, username: session.username, role: session.role });
    }
    return;
  }

  // ── API: election data ────────────────────────────────────────────────────
  if (url === '/api/election-data' && method === 'GET') {
    if (!requireLogin(req, res)) return;
    try {
      sendJson(res, pushService.getDataWithOverrides());
    } catch (e) {
      sendJson(res, { error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: Viz Engine stats ─────────────────────────────────────────────────
  if (url === '/api/stats' && method === 'GET') {
    if (!requireLogin(req, res)) return;
    sendJson(res, pushService.getStats());
    return;
  }

  // ── API: manual push ──────────────────────────────────────────────────────
  if (url === '/api/push-now' && method === 'POST') {
    if (!requireEditor(req, res)) return;
    try {
      const result = await pushService.pushNow('web-ui');
      sendJson(res, { ok: true, result: result ?? null });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: single field edit ────────────────────────────────────────────────
  if (url === '/api/field-edit' && method === 'POST') {
    if (!requireEditor(req, res)) return;
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

  // ── API: batch field edits ────────────────────────────────────────────────
  if (url === '/api/field-edits' && method === 'POST') {
    if (!requireEditor(req, res)) return;
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

  // ── API: clear all overrides ──────────────────────────────────────────────
  if (url === '/api/clear-overrides' && method === 'POST') {
    if (!requireEditor(req, res)) return;
    try {
      pushService.clearOverrides();
      const result = await pushService.pushNow('clear-overrides', true);
      sendJson(res, { ok: true, result: result ?? null });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e.message) }, 500);
    }
    return;
  }

  // ── API: list current overrides ───────────────────────────────────────────
  if (url === '/api/get-overrides' && method === 'GET') {
    if (!requireLogin(req, res)) return;
    sendJson(res, pushService.getOverrides());
    return;
  }

  // ── Static files (no auth required — login overlay is inline) ────────────
  const filePath = STATIC[url];
  if (filePath) {
    serveFile(res, filePath);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const localIPs = Object.values(nets).flat()
    .filter(n => n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  US Midterm 2026 — Election Dashboard        │`);
  console.log(`  │  http://localhost:${PORT}                      │`);
  for (const ip of localIPs) {
    const padded = `http://${ip}:${PORT}`.padEnd(45);
    console.log(`  │  ${padded}│`);
  }
  console.log(`  │  Ctrl+C to stop                              │`);
  console.log(`  └─────────────────────────────────────────────┘\n`);
  console.log(`  Default accounts:  admin / admin123  (editor)`);
  console.log(`                     viewer / viewer123 (viewer)\n`);
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

process.on('SIGINT',  () => { pushService.stop(); process.exit(0); });
process.on('SIGTERM', () => { pushService.stop(); process.exit(0); });
