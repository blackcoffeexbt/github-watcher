import express from 'express';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { type Db, getMeta, setMeta, settings, senderNpub, hashPassword, checkPassword } from './db.js';
import { GitHub } from './github.js';
import { Poller } from './poller.js';
import { Notifications, recipientKey, validRelay, smtpConfig } from './notifications.js';

export function createApp(db: Db) {
  const app = express(); app.disable('x-powered-by');
  const clients = new Set<express.Response>();
  const changed = () => { for (const client of clients) client.write('event: changed\ndata: {}\n\n'); };
  const github = new GitHub(db); const poller = new Poller(db, github, changed); const notifications = new Notifications(db, changed);
  app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }); next(); });
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['x-mailbox-request'] !== '1') { res.status(403).json({ error: 'Request verification failed.' }); return; }
      const origin = req.headers.origin;
      const allowedOrigins = (process.env.APP_ORIGINS || '').split(',');
      if (origin && new URL(origin).host !== req.headers.host && !allowedOrigins.includes(origin)) { res.status(403).json({ error: 'Invalid request origin.' }); return; }
    }
    next();
  });
  const sessionKey = (req: express.Request) => { const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('mailbox_session='))?.slice(16) || ''; return createHash('sha256').update(raw).digest('hex'); };
  const authenticated = (req: express.Request) => !!db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(sessionKey(req), Date.now());
  app.get('/api/auth', (req, res) => res.json({ authenticated: authenticated(req), configured: !!getMeta(db, 'password_hash') }));
  const attempts = new Map<string, { count: number; reset: number }>();
  app.post('/api/login', (req, res) => {
    const key = req.socket.remoteAddress || 'local'; const entry = attempts.get(key);
    if (entry && entry.reset > Date.now() && entry.count >= 10) { res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }); return; }
    const hash = getMeta(db, 'password_hash'); const password = z.string().min(1).max(256).parse(req.body.password);
    if (!hash || !checkPassword(password, hash)) { attempts.set(key, { count: entry && entry.reset > Date.now() ? entry.count + 1 : 1, reset: entry && entry.reset > Date.now() ? entry.reset : Date.now() + 900_000 }); res.status(401).json({ error: hash ? 'Incorrect password.' : 'Set MAILBOX_PASSWORD or run npm run password first.' }); return; }
    attempts.delete(key); const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?)').run(createHash('sha256').update(token).digest('hex'), Date.now() + 30 * 86400_000);
    res.setHeader('Set-Cookie', `mailbox_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${req.secure || process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`); res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => { if (!authenticated(req)) { res.status(401).json({ error: 'Please sign in.' }); return; } next(); });
  app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(sessionKey(req)); res.setHeader('Set-Cookie', 'mailbox_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ ok: true }); });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); res.write(': connected\n\n'); clients.add(res);
    const ping = setInterval(() => { if (!authenticated(req)) res.end(); else res.write(': heartbeat\n\n'); }, 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });
  app.get('/api/mailbox', (_req, res) => res.json({ categories: db.prepare('SELECT * FROM categories ORDER BY name').all(), subscriptions: db.prepare('SELECT s.*, (SELECT COUNT(*) FROM releases r WHERE r.subscription_id=s.id AND r.unread=1) AS unread FROM subscriptions s ORDER BY full_name COLLATE NOCASE').all(), polling: poller.busy, demo: process.env.DEMO_MODE === 'true' }));
  const category = z.object({ name: z.string().trim().min(1).max(60) });
  app.post('/api/categories', (req, res) => { const { name } = category.parse(req.body); const result = db.prepare('INSERT INTO categories(name) VALUES (?)').run(name); changed(); res.json({ id: result.lastInsertRowid }); });
  app.patch('/api/categories/:id', (req, res) => { db.prepare('UPDATE categories SET name=? WHERE id=?').run(category.parse(req.body).name, Number(req.params.id)); changed(); res.json({ ok: true }); });
  app.delete('/api/categories/:id', (req, res) => { db.prepare('DELETE FROM categories WHERE id=?').run(Number(req.params.id)); changed(); res.json({ ok: true }); });
  const subscription = z.object({ category_id: z.number().int().positive().nullable().default(null), stable: z.boolean().default(true), prerelease: z.boolean().default(false), email: z.boolean().default(true), nostr: z.boolean().default(true) });
  app.post('/api/subscriptions', async (req, res) => {
    if (process.env.DEMO_MODE === 'true') throw new Error('Use normal mode to follow live GitHub repositories.');
    const input = subscription.extend({ repository: z.string().max(250) }).parse(req.body);
    const repo = await github.repository(input.repository);
    const result = db.prepare('INSERT INTO subscriptions(github_id,full_name,category_id,stable,prerelease,email,nostr) VALUES (?,?,?,?,?,?,?)').run(repo.id, repo.full_name, input.category_id, +input.stable, +input.prerelease, +input.email, +input.nostr);
    changed(); void poller.poll().then(() => notifications.run()); res.json({ id: result.lastInsertRowid });
  });
  app.patch('/api/subscriptions/:id', (req, res) => { const input = subscription.parse(req.body); db.prepare('UPDATE subscriptions SET category_id=?,stable=?,prerelease=?,email=?,nostr=? WHERE id=?').run(input.category_id, +input.stable, +input.prerelease, +input.email, +input.nostr, Number(req.params.id)); changed(); res.json({ ok: true }); });
  app.delete('/api/subscriptions/:id', (req, res) => { db.prepare('DELETE FROM subscriptions WHERE id=?').run(Number(req.params.id)); changed(); res.json({ ok: true }); });
  app.get('/api/releases', (req, res) => {
    const id = Number(req.query.subscription || 0); const search = String(req.query.search || '').slice(0, 200); const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json(db.prepare(`SELECT r.*,s.full_name FROM releases r JOIN subscriptions s ON s.id=r.subscription_id WHERE (?=0 OR s.id=?) AND (r.title LIKE ? OR r.tag LIKE ? OR s.full_name LIKE ?) ORDER BY r.unread DESC,r.published_at DESC,r.id DESC LIMIT 200 OFFSET ?`).all(id, id, `%${search}%`, `%${search}%`, `%${search}%`, offset));
  });
  app.patch('/api/releases/:id', (req, res) => { const { unread } = z.object({ unread: z.boolean() }).parse(req.body); db.prepare('UPDATE releases SET unread=? WHERE id=?').run(+unread, Number(req.params.id)); changed(); res.json({ ok: true }); });
  app.post('/api/read-all', (req, res) => { const { subscriptionId } = z.object({ subscriptionId: z.number().int().nonnegative().default(0) }).parse(req.body); db.prepare('UPDATE releases SET unread=0 WHERE (?=0 OR subscription_id=?)').run(subscriptionId, subscriptionId); changed(); res.json({ ok: true }); });
  app.post('/api/refresh', (_req, res) => { if (process.env.DEMO_MODE !== 'true') void poller.poll(true).then(() => notifications.run()); res.json({ ok: true }); });
  app.get('/api/releases/:id', (req, res) => { const release = db.prepare('SELECT r.*,s.full_name FROM releases r JOIN subscriptions s ON s.id=r.subscription_id WHERE r.id=?').get(Number(req.params.id)); if (!release) { res.status(404).json({ error: 'Release not found.' }); return; } res.json(release); });
  app.get('/api/settings', (_req, res) => { const config = settings(db); res.json({ ...config, githubToken: '', githubTokenSet: !!config.githubToken, senderNpub: senderNpub(db), smtpReady: !!smtpConfig() }); });
  app.put('/api/settings', (req, res) => {
    const config = z.object({ githubToken: z.string().max(255).optional(), clearGithubToken: z.boolean().optional(), emailEnabled: z.boolean(), emailRecipient: z.union([z.email(), z.literal('')]), nostrEnabled: z.boolean(), nostrRecipient: z.string().max(100), discoveryRelays: z.array(z.string().refine(validRelay, 'Use secure wss:// relay URLs.')).min(1).max(10) }).parse(req.body);
    if (config.nostrRecipient) recipientKey(config.nostrRecipient);
    if (config.emailEnabled && !config.emailRecipient) throw new Error('Enter a recipient email address.');
    if (config.nostrEnabled && !config.nostrRecipient) throw new Error('Enter a recipient npub.');
    const previous = settings(db);
    const { githubToken, clearGithubToken, ...preferences } = config;
    const token = clearGithubToken ? '' : githubToken || previous.githubToken;
    setMeta(db, 'settings', JSON.stringify({ ...previous, ...preferences, clearGithubToken: false, githubToken: token }));
    if (token !== previous.githubToken) { setMeta(db, 'github_pause', '0'); setMeta(db, 'github_backoff', '0'); }
    changed(); res.json({ ok: true });
  });
  app.get('/api/jobs', (_req, res) => res.json(db.prepare('SELECT id,channel,recipient,state,attempts,error,created_at FROM jobs ORDER BY id DESC LIMIT 100').all()));
  app.post('/api/jobs/:id/retry', (req, res) => { db.prepare("UPDATE jobs SET state='pending',attempts=0,next_attempt=0,error=NULL WHERE id=? AND state!='accepted'").run(Number(req.params.id)); void notifications.run(); changed(); res.json({ ok: true }); });
  app.post('/api/test/:channel', (req, res) => {
    const channel = z.enum(['email', 'nostr']).parse(req.params.channel); const config = settings(db);
    const recipient = channel === 'email' ? config.emailRecipient : config.nostrRecipient;
    if (!recipient || !(channel === 'email' ? config.emailEnabled : config.nostrEnabled)) throw new Error('Enable and save this notification channel first.');
    const payload = { repository: 'Release Mailbox', title: 'Your mailbox is connected', tag: 'test', prerelease: false, publishedAt: new Date().toISOString(), excerpt: 'New matching releases will arrive here.', url: 'https://github.com' };
    db.prepare('INSERT INTO jobs(channel,phase,recipient,payload,message_id) VALUES (?,?,?,?,?)').run(channel, 'test', recipient, JSON.stringify(payload), `${randomUUID()}@release-mailbox.local`); void notifications.run(); changed(); res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const constraint = error.message?.includes('UNIQUE constraint');
    const validation = error instanceof z.ZodError;
    const safe = validation ? error.issues[0]?.message : constraint ? 'That repository or category already exists.' : /^(Enter |Use |Only public|Repository unavailable|GitHub |Enable and save)/.test(error.message) ? error.message : 'The request could not be completed. Check the supplied values and try again.';
    res.status(constraint ? 409 : 400).json({ error: safe });
  });
  return { app, poller, notifications, changed, close: () => { for (const client of clients) client.end(); } };
}
