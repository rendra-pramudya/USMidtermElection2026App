'use strict';

/**
 * Vizrt Shared Memory TCP client.
 *
 * Speaks the Viz Engine command protocol (default TCP port 6100). Each command is
 * sent as:   "<commandId> <command>\0"   and the engine replies with
 *           "<commandId> <answer>\0"
 *
 * The shared memory map is addressed via  MAIN*VIZ_COMMUNICATION*MAP.
 * Commands (per Viz Engine 5.x command reference for the MAP object):
 *   CREATE_ELEMENT         "<key>"
 *   DELETE_ELEMENT         "<key>"
 *   HAS_ELEMENT            "<key>"
 *   SET_STRING_ELEMENT     "<key>" "<string>"
 *   SET_INTEGER_ELEMENT    "<key>" <int>
 *   SET_DOUBLE_ELEMENT     "<key>" "<double-as-string>"
 *   SET_BOOLEAN_ELEMENT    "<key>" <bool>
 *
 * The client auto-reconnects and serialises outbound commands so every request
 * gets a matching reply. It emits 'connect', 'disconnect', 'command', 'error'.
 */

const net = require('net');
const EventEmitter = require('events');

const NULL_BYTE = 0x00;
const SHM_PATH = 'MAIN*VIZ_COMMUNICATION*MAP';

function escapeVizString(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t\0]/g, ' ');
}

/**
 * Like escapeVizString, but preserves line structure by converting newlines
 * to the pipe character "|" (file data uses ";" as field separator and "," for
 * lists, so "|" is unused and safe as a line separator).
 *
 * Used for "file-blob" mode where an entire TXT file is pushed as one SHM
 * string and the broadcast template parses it internally. The Viz command
 * parser rejects actual newlines inside quoted strings, so we keep them
 * encoded on the wire; the template can split on "|" to reconstruct lines.
 */
function escapeVizStringRaw(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '|')
    .replace(/\n/g, '|')
    .replace(/\r/g, '|')
    .replace(/[\t\0]/g, ' ');
}

class VizShmClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.reconnectIntervalMs = opts.reconnectIntervalMs ?? 3000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 5000;
    this.logCommands = !!opts.logCommands;

    this.socket = null;
    this.connected = false;
    this.shuttingDown = false;
    this._reconnectTimer = null;
    this._buffer = Buffer.alloc(0);
    this._nextCmdId = 1;
    this._pending = new Map();
  }

  connect() {
    if (this.socket || this.shuttingDown) return;
    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on('connect', () => {
      this.connected = true;
      this.emit('connect', { host: this.host, port: this.port });
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this._failAllPending(new Error('socket closed'));
      this.emit('disconnect');
      if (!this.shuttingDown) this._scheduleReconnect();
    });

    socket.connect(this.port, this.host);
  }

  close() {
    this.shuttingDown = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      try { this.socket.end(); } catch (_) { /* ignore */ }
      try { this.socket.destroy(); } catch (_) { /* ignore */ }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this.reconnectIntervalMs);
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    let idx;
    while ((idx = this._buffer.indexOf(NULL_BYTE)) !== -1) {
      const msg = this._buffer.slice(0, idx).toString('utf8');
      this._buffer = this._buffer.slice(idx + 1);
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    const spaceIdx = msg.indexOf(' ');
    const cmdId = spaceIdx === -1 ? Number(msg) : Number(msg.slice(0, spaceIdx));
    const answer = spaceIdx === -1 ? '' : msg.slice(spaceIdx + 1);
    const pending = this._pending.get(cmdId);
    if (!pending) {
      this.emit('unsolicited', { cmdId, answer });
      return;
    }
    this._pending.delete(cmdId);
    clearTimeout(pending.timer);
    if (/^ERROR\b/i.test(answer.trim())) {
      pending.reject(new Error(`Viz Engine error for [${pending.cmdText}]: ${answer}`));
    } else {
      pending.resolve(answer);
    }
  }

  _failAllPending(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  send(command) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Viz Engine not connected'));
    }
    const cmdId = this._nextCmdId++;
    const line = `${cmdId} ${command}`;
    const payload = Buffer.concat([Buffer.from(line, 'utf8'), Buffer.from([NULL_BYTE])]);
    if (this.logCommands) this.emit('command', { cmdId, command });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(cmdId)) {
          this._pending.delete(cmdId);
          reject(new Error(`Command timed out: ${command}`));
        }
      }, this.commandTimeoutMs);
      this._pending.set(cmdId, { resolve, reject, timer, cmdText: command });
      this.socket.write(payload, (err) => {
        if (err) {
          this._pending.delete(cmdId);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  setString(key, value) {
    const cmd = `${SHM_PATH} SET_STRING_ELEMENT "${escapeVizString(key)}" "${escapeVizString(value)}"`;
    return this.send(cmd);
  }

  /**
   * Set a string whose value may contain newlines and tabs (e.g. raw file
   * contents). Newlines are encoded as the literal 2-char sequence "\n" so
   * the Viz command parser does not see real line breaks.
   */
  setStringRaw(key, value) {
    const cmd = `${SHM_PATH} SET_STRING_ELEMENT "${escapeVizString(key)}" "${escapeVizStringRaw(value)}"`;
    return this.send(cmd);
  }

  setInt(key, value) {
    const v = Number.isFinite(value) ? Math.trunc(value) : 0;
    const cmd = `${SHM_PATH} SET_INTEGER_ELEMENT "${escapeVizString(key)}" ${v}`;
    return this.send(cmd);
  }

  setDouble(key, value) {
    const v = Number.isFinite(value) ? value : 0;
    // Per Viz 5.x manual, SET_DOUBLE_ELEMENT takes the value as a String arg.
    const cmd = `${SHM_PATH} SET_DOUBLE_ELEMENT "${escapeVizString(key)}" "${v}"`;
    return this.send(cmd);
  }

  setBoolean(key, value) {
    const cmd = `${SHM_PATH} SET_BOOLEAN_ELEMENT "${escapeVizString(key)}" ${value ? 1 : 0}`;
    return this.send(cmd);
  }

  createElement(key) {
    const cmd = `${SHM_PATH} CREATE_ELEMENT "${escapeVizString(key)}"`;
    return this.send(cmd);
  }

  deleteElement(key) {
    const cmd = `${SHM_PATH} DELETE_ELEMENT "${escapeVizString(key)}"`;
    return this.send(cmd);
  }

  hasElement(key) {
    const cmd = `${SHM_PATH} HAS_ELEMENT "${escapeVizString(key)}"`;
    return this.send(cmd);
  }

  async setBatch(entries) {
    const results = [];
    for (const e of entries) {
      try {
        let answer;
        if (e.type === 'int') answer = await this.setInt(e.key, e.value);
        else if (e.type === 'double') answer = await this.setDouble(e.key, e.value);
        else if (e.type === 'boolean') answer = await this.setBoolean(e.key, e.value);
        else if (e.type === 'string-raw') answer = await this.setStringRaw(e.key, e.value ?? '');
        else answer = await this.setString(e.key, e.value ?? '');
        results.push({ key: e.key, ok: true, answer });
      } catch (err) {
        results.push({ key: e.key, ok: false, error: err.message });
      }
    }
    return results;
  }
}

module.exports = { VizShmClient, escapeVizString, escapeVizStringRaw, SHM_PATH };
