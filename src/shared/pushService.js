'use strict';

/**
 * Push service — file watcher -> parser -> diff -> Viz SHM client.
 *
 * Runs standalone via `npm run push`, and is also used by the Electron main
 * process (see src/main/main.js) so the UI can subscribe to events.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { loadAll } = require('./parser');
const { buildEntries, buildFileEntries, buildFileEntriesFromDataset, diffEntries } = require('./keymap');
const { VizShmClient } = require('./vizshm');

function loadConfig(configPath) {
  const resolved = path.resolve(configPath || path.join(__dirname, '..', '..', 'config.json'));
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

class PushService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new VizShmClient({
      host: config.vizEngine.host,
      port: config.vizEngine.port,
      reconnectIntervalMs: config.vizEngine.reconnectIntervalMs,
      commandTimeoutMs: config.vizEngine.commandTimeoutMs,
      logCommands: config.shm.logCommands
    });

    this._wireClient();
    this._watcher = null;
    this._debounceTimer = null;
    this._lastEntries = [];
    this._stats = {
      connected: false,
      lastPushAt: null,
      lastPushCount: 0,
      lastPushKeys: 0,
      totalPushed: 0,
      errors: 0
    };
  }

  _wireClient() {
    this.client.on('connect', (info) => {
      this._stats.connected = true;
      this.emit('status', { type: 'connect', info });
      // Flush any changes the engine missed while disconnected.
      this._triggerPush('reconnect');
    });
    this.client.on('disconnect', () => {
      this._stats.connected = false;
      this.emit('status', { type: 'disconnect' });
    });
    this.client.on('error', (err) => {
      this._stats.errors++;
      this.emit('status', { type: 'error', error: err.message });
    });
    this.client.on('command', (cmd) => {
      this.emit('command', cmd);
    });
  }

  start() {
    this.client.connect();
    this._startWatcher();
    // Initial push is triggered by the 'connect' event (see _wireClient) so
    // we don't race the TCP handshake. If already connected (e.g. hot-reload),
    // fire it immediately.
    if (this._stats.connected) this._triggerPush('initial');
  }

  stop() {
    if (this._watcher) this._watcher.close();
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this.client.close();
  }

  _startWatcher() {
    const cfg = this.config.dataSource;
    if (cfg.mode !== 'file') return;

    let chokidar;
    try {
      chokidar = require('chokidar');
    } catch (_) {
      // Fallback: fs.watch on each file if chokidar isn't installed yet.
      this._startFallbackWatcher();
      return;
    }

    const dir = path.resolve(cfg.fileDir);
    const files = Object.values(cfg.files).map(f => path.resolve(dir, f));
    this._watcher = chokidar.watch(files, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    const onAny = (filePath) => this._scheduleDebounced(filePath);
    this._watcher.on('add', onAny);
    this._watcher.on('change', onAny);
  }

  _startFallbackWatcher() {
    const cfg = this.config.dataSource;
    const dir = path.resolve(cfg.fileDir);
    for (const f of Object.values(cfg.files)) {
      const full = path.resolve(dir, f);
      if (!fs.existsSync(full)) continue;
      try {
        fs.watch(full, { persistent: true }, () => this._scheduleDebounced(full));
      } catch (err) {
        this.emit('status', { type: 'error', error: `fs.watch failed: ${err.message}` });
      }
    }
  }

  _scheduleDebounced(triggeredBy) {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const delay = this.config.dataSource.watchDebounceMs || 500;
    this._debounceTimer = setTimeout(() => {
      this._triggerPush(`change:${path.basename(triggeredBy || '')}`);
    }, delay);
  }

  /**
   * Manual push (used by Electron UI "Push now" button).
   * @param {string} reason
   * @param {boolean} forceFields  Force per-field entries even when pushMode='files'.
   *   Pass true when clearing overrides so clean values overwrite any Viz keys
   *   that were previously set by a manual-edit push.
   */
  async pushNow(reason = 'manual', forceFields = false) {
    return this._triggerPush(reason, forceFields);
  }

  /**
   * Apply a manual override (used by Electron UI "edit field" flow).
   * Overrides are merged into the parsed dataset before pushing.
   * @param {{scope:string, key:string, value:any}} override
   *    scope = 'governorAll' | 'houseAll' | 'senateAll' |
   *            'governorByState:<STATE>' | 'houseByState:<STATE>'
   */
  applyOverride(override) {
    this._overrides = this._overrides || [];
    this._overrides.push(override);
  }

  clearOverrides() {
    this._overrides = [];
  }

  _applyOverridesTo(dataset) {
    if (!this._overrides || !this._overrides.length) return dataset;
    for (const o of this._overrides) {
      const [scope, state] = o.scope.split(':');
      if (scope === 'governorByState' || scope === 'houseByState') {
        dataset[scope] = dataset[scope] || {};
        dataset[scope][state] = { ...(dataset[scope][state] || {}), [o.key]: o.value };
      } else if (dataset[scope]) {
        dataset[scope] = { ...dataset[scope], [o.key]: o.value };
      }
    }
    return dataset;
  }

  async _triggerPush(reason, forceFields = false) {
    try {
      const pushMode = (this.config.shm.pushMode || 'hybrid').toLowerCase();
      const hasOverrides = this._overrides && this._overrides.length > 0;
      const wantFields = forceFields || pushMode === 'fields' || pushMode === 'hybrid';
      const wantFiles  = pushMode === 'files'  || pushMode === 'hybrid';

      const entries = [];

      // Load + apply overrides when: field keys are needed, OR file blobs must
      // be re-serialized from the overridden dataset.
      let dataset = null;
      if (wantFields || (wantFiles && hasOverrides)) {
        const raw = loadAll(this.config.dataSource);
        dataset = this._applyOverridesTo(raw);
      }

      if (wantFields) {
        entries.push(...buildEntries(dataset, this.config.shm.keyPrefix));
      }

      if (wantFiles) {
        if (hasOverrides) {
          // Re-serialize the five TXT blobs from the overridden in-memory
          // dataset so templates that parse the blob see the edited values —
          // same wire format as a normal file-change push.
          entries.push(...buildFileEntriesFromDataset(dataset, this.config.dataSource, this.config.shm.keyPrefix));
        } else {
          // No overrides — read raw file bytes directly (fast path).
          entries.push(...buildFileEntries(this.config.dataSource, this.config.shm.keyPrefix));
        }
      }

      const toPush = this.config.shm.pushOnlyChanged
        ? diffEntries(this._lastEntries, entries)
        : entries;

      if (toPush.length === 0) {
        this.emit('push', { reason, total: entries.length, pushed: 0, skipped: true });
        return { pushed: 0, total: entries.length };
      }

      if (!this._stats.connected) {
        this.emit('push', { reason, total: entries.length, pushed: 0, skipped: true, note: 'not connected' });
        return { pushed: 0, total: entries.length, note: 'not connected' };
      }

      const results = await this.client.setBatch(toPush);
      const okCount = results.filter(r => r.ok).length;

      this._lastEntries = entries;
      this._stats.lastPushAt = new Date().toISOString();
      this._stats.lastPushCount = okCount;
      this._stats.lastPushKeys = entries.length;
      this._stats.totalPushed += okCount;

      this.emit('push', {
        reason,
        mode: pushMode,
        total: entries.length,
        pushed: okCount,
        failed: results.length - okCount,
        sampleKeys: toPush.slice(0, 5).map(e => e.key)
      });

      return { pushed: okCount, total: entries.length, failed: results.length - okCount };
    } catch (err) {
      this._stats.errors++;
      this.emit('status', { type: 'error', error: err.message });
      return { error: err.message };
    }
  }

  getStats() {
    return { ...this._stats };
  }

  /**
   * Return the full parsed dataset with any current overrides applied.
   * Used by the web server so /api/election-data reflects manual edits.
   */
  getDataWithOverrides() {
    const raw = loadAll(this.config.dataSource);
    return this._applyOverridesTo(raw);
  }

  /** Return a copy of the current overrides list. */
  getOverrides() {
    return this._overrides ? [...this._overrides] : [];
  }

  /**
   * Switch the Viz Engine target at runtime without restarting the process.
   * Closes the current TCP connection, builds a fresh VizShmClient with the
   * new host/port, wires its events, and reconnects.
   * @param {{ host?: string, port?: number, reconnectIntervalMs?: number, commandTimeoutMs?: number }} vizConfig
   */
  reconnectViz(vizConfig) {
    Object.assign(this.config.vizEngine, vizConfig);
    this.client.close();
    this.client = new VizShmClient({
      host:               this.config.vizEngine.host,
      port:               this.config.vizEngine.port,
      reconnectIntervalMs: this.config.vizEngine.reconnectIntervalMs,
      commandTimeoutMs:   this.config.vizEngine.commandTimeoutMs,
      logCommands:        this.config.shm.logCommands,
    });
    this._stats.connected = false;
    this._wireClient();
    this.client.connect();
  }

  /** Return the active Viz Engine connection settings. */
  getVizConfig() {
    return {
      host:               this.config.vizEngine.host,
      port:               this.config.vizEngine.port,
      reconnectIntervalMs: this.config.vizEngine.reconnectIntervalMs,
      commandTimeoutMs:   this.config.vizEngine.commandTimeoutMs,
    };
  }
}

// CLI entry point: `npm run push`
if (require.main === module) {
  const cfg = loadConfig();
  const svc = new PushService(cfg);
  svc.on('status', (s) => console.log('[status]', s));
  svc.on('push', (p) => console.log('[push]', p));
  svc.on('command', (c) => console.log('[cmd]', c.cmdId, c.command));
  svc.start();
  process.on('SIGINT', () => { svc.stop(); process.exit(0); });
  console.log(`Push service started. Viz Engine: ${cfg.vizEngine.host}:${cfg.vizEngine.port}`);
  console.log(`Push mode: ${cfg.shm.pushMode || 'hybrid'}  (fields|files|hybrid)`);
  console.log(`Watching: ${Object.values(cfg.dataSource.files).join(', ')}`);
}

module.exports = { PushService, loadConfig };
