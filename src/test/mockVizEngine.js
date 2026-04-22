'use strict';

/**
 * Mock Viz Engine TCP server for testing without real Vizrt infrastructure.
 * Listens on port 6100 by default (PORT env overrides). Accepts null-terminated
 * commands, recognises Viz 5.x MAP commands, replies with "<cmdId> 0" for
 * success. Logs every command and prints the SHM map on SIGINT.
 */

const net = require('net');

const PORT = Number(process.env.PORT || 6100);
const HOST = process.env.HOST || '0.0.0.0';

const shm = new Map(); // key -> {type, value}

// Matches the Viz 5.x MAP object setters. Captures: type, key, quoted value, or bare numeric value.
const SET_RE = /MAP\s+SET_(STRING|INTEGER|DOUBLE|BOOLEAN)_ELEMENT\s+"([^"]*)"\s+(?:"((?:\\.|[^"\\])*)"|(-?\d+(?:\.\d+)?))/;
const CREATE_RE = /MAP\s+CREATE_ELEMENT\s+"([^"]*)"/;
const DELETE_RE = /MAP\s+DELETE_ELEMENT\s+"([^"]*)"/;

function handleCommand(line) {
  let m = line.match(SET_RE);
  if (m) {
    const type = m[1].toLowerCase();
    const key = m[2];
    const value = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[4];
    shm.set(key, { type, value });
    return '0';
  }
  m = line.match(CREATE_RE);
  if (m) { shm.set(m[1], { type: 'empty', value: '' }); return '0'; }
  m = line.match(DELETE_RE);
  if (m) { shm.delete(m[1]); return '0'; }
  return '0';
}

const server = net.createServer((socket) => {
  console.log(`[mock-viz] client connected ${socket.remoteAddress}:${socket.remotePort}`);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(0)) !== -1) {
      const msg = buffer.slice(0, idx).toString('utf8');
      buffer = buffer.slice(idx + 1);
      const spaceIdx = msg.indexOf(' ');
      const cmdId = spaceIdx === -1 ? msg : msg.slice(0, spaceIdx);
      const cmd = spaceIdx === -1 ? '' : msg.slice(spaceIdx + 1);
      const answer = handleCommand(cmd);
      const reply = Buffer.concat([Buffer.from(`${cmdId} ${answer}`, 'utf8'), Buffer.from([0])]);
      socket.write(reply);
      console.log(`[mock-viz] [${cmdId}] ${cmd}   -> ${answer}   (shm keys: ${shm.size})`);
    }
  });
  socket.on('close', () => console.log('[mock-viz] client disconnected'));
  socket.on('error', (err) => console.log('[mock-viz] socket error:', err.message));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-viz] listening on ${HOST}:${PORT}`);
  console.log('[mock-viz] press Ctrl+C to stop');
});

process.on('SIGINT', () => {
  console.log(`\n[mock-viz] final SHM state - ${shm.size} keys:`);
  for (const [k, v] of shm) console.log(`  ${k} (${v.type}) = ${v.value}`);
  process.exit(0);
});
