import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openDb, getMeta, setMeta, hashPassword } from './db.js';
import { createApp } from './app.js';

process.umask(0o077);
const db = openDb(process.env.DATABASE_PATH || 'data/mailbox.sqlite');
function syncPassword() {
  let password = process.env.MAILBOX_PASSWORD;
  if (process.env.RUNTIME_CONFIG) { try { password = JSON.parse(readFileSync(process.env.RUNTIME_CONFIG, 'utf8')).password || password; } catch { throw new Error('Cannot read runtime configuration.'); } }
  if (!password) return;
  if (password.length < 12) throw new Error('Mailbox password must contain at least 12 characters.');
  const fingerprint = createHash('sha256').update(password).digest('hex');
  if (getMeta(db, 'password_source') !== fingerprint) { setMeta(db, 'password_hash', hashPassword(password)); setMeta(db, 'password_source', fingerprint); db.prepare('DELETE FROM sessions').run(); }
}
syncPassword();
const service = createApp(db);
const server = service.app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`Release Mailbox listening on port ${process.env.PORT || 3000}`));
const tick = async () => { syncPassword(); if (process.env.DEMO_MODE === 'true') return; await service.poller.poll(); await service.notifications.run(); };
const runTick = () => void tick().catch(() => console.error('Background update failed; will retry on the next tick.'));
runTick(); const timer = setInterval(runTick, 30_000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer); service.close(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); });
