import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import '../../server/notifications.ts';
import { SimplePool } from 'nostr-tools/pool';

// Accept TCP but never finish TLS: reproduce a real stalled WSS handshake.
const sockets = new Set();
const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const pool = new SimplePool();
try {
  const connection = pool.ensureRelay(`wss://127.0.0.1:${server.address().port}`, { connectionTimeout: 120 });
  if (process.argv[2] === 'destroy') setTimeout(() => pool.destroy(), 30);
  let rejected = false;
  try { await connection; } catch { rejected = true; }
  await delay(40); // Allow ws to emit its asynchronous error after library cleanup.
  if (!rejected) throw new Error('Stalled connection unexpectedly succeeded.');
  console.log('survived');
} finally {
  pool.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
