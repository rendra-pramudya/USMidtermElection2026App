'use strict';

/**
 * Web API adapter — shims window.api to match the Electron contextBridge API
 * so the exact same renderer.js runs in both Electron and the browser.
 *
 * Auth token is stored in sessionStorage and sent as a Bearer token on every
 * request.  window.api.login() / window.api.logout() manage the token.
 * window.api.getRole() returns 'editor' | 'viewer' | null.
 */

let _token    = sessionStorage.getItem('auth_token')    || null;
let _role     = sessionStorage.getItem('auth_role')     || null;
let _username = sessionStorage.getItem('auth_username') || null;

function _authHeaders() {
  return _token ? { 'Authorization': `Bearer ${_token}` } : {};
}

function _get(url) {
  return fetch(url, { headers: _authHeaders() }).then(r => {
    if (r.status === 401) { _clearSession(); throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function _post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ..._authHeaders() },
    body: JSON.stringify(body),
  }).then(r => {
    if (r.status === 401) { _clearSession(); throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
    if (r.status === 403) throw Object.assign(new Error('Forbidden'), { status: 403 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function _clearSession() {
  _token = _role = _username = null;
  sessionStorage.removeItem('auth_token');
  sessionStorage.removeItem('auth_role');
  sessionStorage.removeItem('auth_username');
}

window.api = {
  // ── Auth ─────────────────────────────────────────────────────────────────
  login(username, password) {
    return fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(r => r.json()).then(data => {
      if (data.ok) {
        _token    = data.token;
        _role     = data.role;
        _username = data.username;
        sessionStorage.setItem('auth_token',    _token);
        sessionStorage.setItem('auth_role',     _role);
        sessionStorage.setItem('auth_username', _username);
      }
      return data;
    });
  },

  logout() {
    return _post('/api/logout', {}).finally(() => {
      _clearSession();
    });
  },

  me() {
    return fetch('/api/me', { headers: _authHeaders() }).then(r => r.json());
  },

  getRole()     { return _role; },
  getUsername() { return _username; },
  isLoggedIn()  { return !!_token; },

  // ── Read data ─────────────────────────────────────────────────────────────
  getElectionData: () => _get('/api/election-data'),
  getSvg:          () => fetch('/us.svg').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
  getStats:        () => _get('/api/stats'),

  // ── Push actions ──────────────────────────────────────────────────────────
  pushNow: () => _post('/api/push-now', {}),

  // ── Manual field editing ──────────────────────────────────────────────────
  fieldEdit:      (override)  => _post('/api/field-edit',      override),
  fieldEdits:     (overrides) => _post('/api/field-edits',     overrides),
  clearOverrides: ()          => _post('/api/clear-overrides', {}),

  // ── Simulation control (editor only) ─────────────────────────────────────
  simStatus: ()        => _get('/api/sim/status'),
  simStart:  ()        => _post('/api/sim/start',  {}),
  simStop:   ()        => _post('/api/sim/stop',   {}),
  simReset:  ()        => _post('/api/sim/reset',  {}),
  simSpeed:  (speed)   => _post('/api/sim/speed',  { speed }),

  // ── Stubs for Electron-only methods not used in web mode ─────────────────
  getConfig:     () => Promise.resolve({}),
  getEvents:     () => Promise.resolve([]),
  applyOverride: () => Promise.resolve(true),
  onEvent:       () => () => {},
};
