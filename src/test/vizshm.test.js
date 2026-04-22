'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { VizShmClient, escapeVizString, escapeVizStringRaw } = require('../shared/vizshm');

test('escapeVizString escapes backslash, quotes, newlines', () => {
  assert.strictEqual(escapeVizString('hello'), 'hello');
  assert.strictEqual(escapeVizString('a"b'), 'a\\"b');
  assert.strictEqual(escapeVizString('a\\b'), 'a\\\\b');
  assert.strictEqual(escapeVizString('a\nb'), 'a b');
});

test('escapeVizStringRaw preserves line structure using pipe separator', () => {
  assert.strictEqual(escapeVizStringRaw('a\nb'), 'a|b');
  assert.strictEqual(escapeVizStringRaw('a\r\nb'), 'a|b');
  assert.strictEqual(escapeVizStringRaw('a\rb'), 'a|b');
  assert.strictEqual(escapeVizStringRaw('a\tb'), 'a b');
  assert.strictEqual(escapeVizStringRaw('a\\b'), 'a\\\\b');
  assert.strictEqual(escapeVizStringRaw('a"b'), 'a\\"b');
  assert.strictEqual(escapeVizStringRaw('x\ny\nz'), 'x|y|z');
});

function startEchoServer(t, handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let i;
        while ((i = buf.indexOf(0)) !== -1) {
          const msg = buf.slice(0, i).toString('utf8');
          buf = buf.slice(i + 1);
          const reply = handler(msg);
          sock.write(Buffer.concat([Buffer.from(reply, 'utf8'), Buffer.from([0])]));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => {
        for (const s of sockets) s.destroy();
        return new Promise((r) => server.close(() => r()));
      });
      resolve({ server, port });
    });
  });
}

test('VizShmClient setString uses SET_STRING_ELEMENT', async (t) => {
  const received = [];
  const { port } = await startEchoServer(t, (msg) => {
    received.push(msg);
    const spaceIdx = msg.indexOf(' ');
    return `${msg.slice(0, spaceIdx)} 0`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  const answer = await client.setString('GOP_LABEL', 'GOP');
  assert.strictEqual(answer, '0');
  assert.match(received[0], /MAIN\*VIZ_COMMUNICATION\*MAP SET_STRING_ELEMENT "GOP_LABEL" "GOP"/);
});

test('VizShmClient setInt uses SET_INTEGER_ELEMENT with bare int', async (t) => {
  const received = [];
  const { port } = await startEchoServer(t, (msg) => {
    received.push(msg);
    const spaceIdx = msg.indexOf(' ');
    return `${msg.slice(0, spaceIdx)} 0`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  await client.setInt('GOP_SEATS', 212.7);
  assert.match(received[0], /SET_INTEGER_ELEMENT "GOP_SEATS" 212$/);
});

test('VizShmClient setDouble quotes the value per Viz manual', async (t) => {
  const received = [];
  const { port } = await startEchoServer(t, (msg) => {
    received.push(msg);
    const spaceIdx = msg.indexOf(' ');
    return `${msg.slice(0, spaceIdx)} 0`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  await client.setDouble('GOP_PCT', 50.51);
  assert.match(received[0], /SET_DOUBLE_ELEMENT "GOP_PCT" "50.51"$/);
});

test('VizShmClient rejects when engine returns ERROR', async (t) => {
  const { port } = await startEchoServer(t, (msg) => {
    const spaceIdx = msg.indexOf(' ');
    return `${msg.slice(0, spaceIdx)} ERROR: unknown key`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  await assert.rejects(() => client.setString('BAD', 'x'), /Viz Engine error.*ERROR: unknown key/);
});

test('VizShmClient setStringRaw encodes newlines on the wire', async (t) => {
  const received = [];
  const { port } = await startEchoServer(t, (msg) => {
    received.push(msg);
    const spaceIdx = msg.indexOf(' ');
    return `${msg.slice(0, spaceIdx)} 0`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  await client.setStringRaw('FILE_BLOB', 'line1\nline2\tTAB');
  assert.match(received[0], /SET_STRING_ELEMENT "FILE_BLOB" "line1\|line2 TAB"$/);
  assert.ok(!received[0].includes('\n'), 'no real newline on the wire');
  assert.ok(!received[0].includes('\t'), 'no real tab on the wire');
});

test('VizShmClient setBatch dispatches string-raw via setStringRaw', async (t) => {
  const received = [];
  const { port } = await startEchoServer(t, (msg) => {
    received.push(msg);
    const spaceIdx = msg.indexOf(' ');
    return `${msg.slice(0, spaceIdx)} 0`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  const results = await client.setBatch([
    { key: 'RAW', value: 'a\nb', type: 'string-raw' }
  ]);
  assert.strictEqual(results[0].ok, true);
  assert.match(received[0], /SET_STRING_ELEMENT "RAW" "a\|b"$/);
});

test('VizShmClient setBatch reports per-key ok/fail', async (t) => {
  let count = 0;
  const { port } = await startEchoServer(t, (msg) => {
    count++;
    const spaceIdx = msg.indexOf(' ');
    const cmdId = msg.slice(0, spaceIdx);
    return count === 2 ? `${cmdId} ERROR: bad` : `${cmdId} 0`;
  });
  const client = new VizShmClient({ host: '127.0.0.1', port });
  t.after(() => client.close());
  await new Promise((r) => { client.once('connect', r); client.connect(); });
  const results = await client.setBatch([
    { key: 'A', value: 'a', type: 'string' },
    { key: 'B', value: 'b', type: 'string' },
    { key: 'C', value: 3, type: 'int' }
  ]);
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[1].ok, false);
  assert.strictEqual(results[2].ok, true);
});
