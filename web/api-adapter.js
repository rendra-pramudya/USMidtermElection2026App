'use strict';

/**
 * Web API adapter — shims window.api to match the Electron contextBridge API
 * so the exact same renderer.js runs in both Electron and the browser.
 *
 * Electron:  window.api.fieldEdit(o)  → ipcRenderer.invoke('field-edit', o)
 * Web:       window.api.fieldEdit(o)  → fetch('/api/field-edit', { method:'POST', body: JSON.stringify(o) })
 */

const JSON_POST = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

window.api = {
  // ── Read data ────────────────────────────────────────────────────────────
  getElectionData: () =>
    fetch('/api/election-data').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),

  getSvg: () =>
    fetch('/us.svg').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }),

  getStats: () =>
    fetch('/api/stats').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),

  // ── Push actions ─────────────────────────────────────────────────────────
  pushNow: () => JSON_POST('/api/push-now', {}),

  // ── Manual field editing ──────────────────────────────────────────────────
  /** Apply a single override + push. override = { scope, key, value } */
  fieldEdit: (override) => JSON_POST('/api/field-edit', override),

  /** Apply multiple overrides + push once. overrides = [{scope,key,value},...] */
  fieldEdits: (overrides) => JSON_POST('/api/field-edits', overrides),

  /** Clear all overrides + push clean file data. */
  clearOverrides: () => JSON_POST('/api/clear-overrides', {}),

  // ── Stubs for Electron-only methods not used in web mode ─────────────────
  getConfig:     () => Promise.resolve({}),
  getEvents:     () => Promise.resolve([]),
  applyOverride: () => Promise.resolve(true),
  onEvent:       () => () => {},
};
