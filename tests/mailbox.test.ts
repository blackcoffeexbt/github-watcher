import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDb, settings, setMeta, hashPassword, checkPassword, senderSecret } from '../server/db.js';
import { ingest, Poller, INTERVAL } from '../server/poller.js';
import { GitHub, parseRepository } from '../server/github.js';
import { createApp } from '../server/app.js';
import { wrapMessage, sendEmail, Notifications, smtpConfig, type Job } from '../server/notifications.js';
import { generateSecretKey, getPublicKey, nip19, nip59, verifyEvent } from 'nostr-tools';
import { SMTPServer } from 'smtp-server';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubRelease, Subscription } from '../server/types.js';

const resources: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) await close(); });
function fixture() {
  const db = openDb(':memory:'); resources.push(() => { db.close(); });
  db.prepare("INSERT INTO subscriptions(github_id,full_name) VALUES(1,'example/project')").run();
  const sub = () => db.prepare('SELECT * FROM subscriptions WHERE id=1').get() as Subscription;
  return { db, sub };
}
function release(id: number, prerelease = false): GitHubRelease { return { id, name: `Release ${id}`, tag_name: `v${id}`, body: 'Hello **world**', html_url: `https://github.com/example/project/releases/tag/v${id}`, published_at: `2026-10-${String(id).padStart(2, '0')}T12:00:00Z`, prerelease, draft: false, author: { login: 'author' }, assets: [] }; }

describe('mailbox detection', () => {
  it('imports history quietly except latest matching release, with independent channel jobs', () => {
    const { db, sub } = fixture(); setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'a@example.com', nostrEnabled: true, nostrRecipient: 'npub-test' }));
    ingest(db, sub(), [release(1), release(2), release(3, true), { ...release(4), draft: true }]);
    expect(db.prepare('SELECT github_id FROM releases WHERE unread=1').all()).toEqual([{ github_id: 2 }]);
    expect(db.prepare('SELECT channel FROM jobs ORDER BY channel').all()).toEqual([{ channel: 'email' }, { channel: 'nostr' }]);
    expect(db.prepare('SELECT count(*) n FROM releases').get()).toEqual({ n: 3 });
    ingest(db, sub(), [release(1), release(2), release(3, true)]);
    expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({ n: 2 });
  });
  it('alerts on stable promotion but not note edits, or retroactively on preference changes', () => {
    const { db, sub } = fixture(); db.prepare('UPDATE subscriptions SET prerelease=1').run();
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'a@example.com' }));
    ingest(db, sub(), [release(1, true)]);
    db.prepare('UPDATE releases SET unread=0').run();
    ingest(db, sub(), [{ ...release(1, true), body: 'edited' }]);
    expect(db.prepare('SELECT unread FROM releases').get()).toEqual({ unread: 0 });
    ingest(db, sub(), [release(1)]);
    expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({ n: 2 });
    ingest(db, sub(), [release(1)]);
    expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({ n: 2 });
    db.prepare('UPDATE subscriptions SET prerelease=0').run(); ingest(db, sub(), [release(1), release(2, true)]);
    db.prepare('UPDATE subscriptions SET prerelease=1').run(); ingest(db, sub(), [release(1), release(2, true)]);
    expect(db.prepare('SELECT unread FROM releases WHERE github_id=2').get()).toEqual({ unread: 0 });
  });
  it('preserves read state across restart and catches overdue repositories without overlapping', async () => {
    const dir = mkdtempSync(`${tmpdir()}/mailbox-`); resources.unshift(() => rmSync(dir, { recursive: true, force: true }));
    let db = openDb(`${dir}/mailbox.sqlite`); db.prepare("INSERT INTO subscriptions(github_id,full_name) VALUES(1,'example/project')").run();
    ingest(db, db.prepare('SELECT * FROM subscriptions').get() as Subscription, [release(1)]); db.prepare('UPDATE releases SET unread=0').run(); db.prepare('UPDATE subscriptions SET next_check=0').run(); db.close();
    db = openDb(`${dir}/mailbox.sqlite`); resources.push(() => { db.close(); });
    const github = { releases: vi.fn(async () => [release(1), release(2)]) } as unknown as GitHub;
    const poller = new Poller(db, github); await Promise.all([poller.poll(), poller.poll()]);
    expect(github.releases).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT github_id,unread FROM releases ORDER BY github_id').all()).toEqual([{ github_id: 1, unread: 0 }, { github_id: 2, unread: 1 }]);
    expect((db.prepare('SELECT next_check FROM subscriptions').get() as any).next_check).toBeGreaterThan(Date.now() + INTERVAL - 1000);
  });
  it('retains data and read state after a failed poll', async () => {
    const { db, sub } = fixture(); ingest(db, sub(), [release(1)]); db.prepare('UPDATE subscriptions SET next_check=0').run();
    await new Poller(db, { releases: async () => { throw new Error('Network offline'); } } as unknown as GitHub).poll();
    expect((db.prepare('SELECT error FROM subscriptions').get() as any).error).toBe('Network offline');
    expect(db.prepare('SELECT count(*) n FROM releases').get()).toEqual({ n: 1 });
  });
});

describe('GitHub requests', () => {
  it('validates public github.com repository input', () => {
    expect(parseRepository('https://github.com/bitcoin/bitcoin.git/')).toBe('bitcoin/bitcoin');
    for (const value of ['https://evil.test/a/b', 'owner/repo/releases', '../repo', 'https://github.com/a/b?x=1']) expect(() => parseRepository(value)).toThrow();
  });
  it('paginates full history and reuses conditional cache', async () => {
    const { db, sub } = fixture(); let count = 0;
    const request = vi.fn(async (_url: any, options: any) => { count++; if (count > 2) { expect(options.headers['If-None-Match']).toBe('test'); return new Response(null, { status: 304 }); } return new Response(JSON.stringify(count === 1 ? Array.from({ length: 100 }, (_, i) => release(i + 1)) : [release(101)]), { headers: { etag: 'test' } }); }) as unknown as typeof fetch;
    const github = new GitHub(db, request); expect(await github.releases(sub())).toHaveLength(101); expect(await github.releases(sub())).toHaveLength(101);
  });
  it('honors rate-limit backoff without discarding its cache', async () => {
    const { db } = fixture(); const request = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } })) as unknown as typeof fetch;
    const github = new GitHub(db, request); await expect(github.repository('example/project')).rejects.toThrow('rate limit'); await expect(github.repository('example/project')).rejects.toThrow('rate limit'); expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('notification delivery', () => {
  it.each(['timeout', 'destroy'])('survives a real stalled relay handshake during %s', async mode => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/fixtures/stalled-relay.mjs', mode], { timeout: 5000 });
    expect(result.stdout).toContain('survived');
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  });
  const payload = { repository: 'example/project', title: 'Release <script>alert(1)</script>', tag: 'v1', prerelease: false, publishedAt: '2026-11-04', excerpt: '<b>Notes</b>', url: 'https://github.com/example/project/releases/tag/v1' };
  it('creates signed gift wraps independently decryptable with NIP-59', () => {
    const { db } = fixture(); const secret = generateSecretKey(); const npub = nip19.npubEncode(getPublicKey(secret));
    const event = wrapMessage(db, npub, payload); expect(verifyEvent(event)).toBe(true); expect(event.kind).toBe(1059);
    const rumor = nip59.unwrapEvent(event, secret); expect(rumor.kind).toBe(14); expect(rumor.content).toContain('example/project'); expect(event.content).not.toContain('example/project');
  });
  it('sends escaped HTML and plain text with a stable Message-ID to a real SMTP server', async () => {
    let received = ''; const server = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _session, done) { stream.on('data', chunk => received += chunk); stream.on('end', done); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); resources.push(() => new Promise<void>(resolve => server.close(resolve)));
    const port = (server.server.address() as any).port;
    await sendEmail({ host: '127.0.0.1', port, from: 'mailbox@example.com', security: 'plain' }, 'recipient@example.com', 'stable-id@example.com', payload);
    expect(received).toContain('Message-ID: <stable-id@example.com>'); expect(received).toContain('text/plain'); expect(received).toContain('text/html'); expect(received).toContain('&lt;script&gt;'); expect(received.split('Content-Type: text/html')[1]).not.toContain('<script>');
  });
  it('keeps channels independent and retains retryable failures without leaking provider errors', async () => {
    const { db, sub } = fixture(); setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'a@example.com', nostrEnabled: true, nostrRecipient: 'npub-test' })); ingest(db, sub(), [release(1)]);
    const worker = new Notifications(db); vi.spyOn(worker, 'deliverNostr').mockResolvedValue(); await worker.run();
    expect(db.prepare('SELECT channel,state FROM jobs ORDER BY channel').all()).toEqual([{ channel: 'email', state: 'pending' }, { channel: 'nostr', state: 'accepted' }]);
    expect((db.prepare("SELECT error FROM jobs WHERE channel='email'").get() as any).error).toContain('SMTP is not configured');
  });
  it('reads changed runtime SMTP settings and handles disabled configuration', () => {
    const dir = mkdtempSync(`${tmpdir()}/smtp-`); resources.push(() => { delete process.env.RUNTIME_CONFIG; rmSync(dir, { recursive: true, force: true }); });
    process.env.RUNTIME_CONFIG = `${dir}/runtime.json`; writeFileSync(process.env.RUNTIME_CONFIG, JSON.stringify({ smtp: null })); expect(smtpConfig()).toBeNull();
    writeFileSync(process.env.RUNTIME_CONFIG, JSON.stringify({ smtp: { host: 'smtp.example.com', port: 465, from: 'a@example.com', security: 'tls' } })); expect(smtpConfig()?.host).toBe('smtp.example.com');
  });
  it('does not let disabled-channel jobs starve active-channel delivery', async () => {
    const { db, sub } = fixture();
    for (let i = 0; i < 35; i++) db.prepare("INSERT INTO jobs(channel,phase,recipient,payload,message_id) VALUES('nostr','test','unused','{}',?)").run(`paused-${i}`);
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'a@example.com' })); ingest(db, sub(), [release(1)]);
    await new Notifications(db).run();
    expect(db.prepare("SELECT attempts FROM jobs WHERE channel='email'").get()).toEqual({ attempts: 1 });
    expect(db.prepare("SELECT sum(attempts) n FROM jobs WHERE channel='nostr'").get()).toEqual({ n: 0 });
  });
  it('includes app and inbox relays and preserves each copy independently on retry', async () => {
    const { db, sub } = fixture(); const secret = generateSecretKey(); const pubkey = getPublicKey(secret); const npub = nip19.npubEncode(pubkey);
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), nostrEnabled: true, nostrRecipient: npub })); ingest(db, sub(), [release(1)]);
    let acceptSender = false;
    const publish = vi.fn((_relays: string[], event: any) => event.tags.some((t: string[]) => t[0] === 'p' && t[1] === pubkey) || acceptSender ? [Promise.resolve('accepted')] : [Promise.reject(new Error('offline'))]);
    const pool = { querySync: vi.fn(async () => [{ pubkey, tags: [['relay', 'wss://inbox.example']], created_at: 100 }] as any), publish, destroy: vi.fn() };
    const worker = new Notifications(db, () => {}, () => pool as any);
    let job = db.prepare('SELECT * FROM jobs').get() as Job;
    await expect(worker.deliverNostr(job, JSON.parse(job.payload))).rejects.toThrow('sender history copy');
    expect(publish.mock.calls[0][0]).toEqual(['wss://inbox.example', ...settings(db).discoveryRelays]);
    expect(publish.mock.calls[1][0]).toEqual(settings(db).discoveryRelays);
    const first = JSON.parse((db.prepare('SELECT event FROM jobs').get() as any).event);
    expect(first.recipientAccepted).toBe(true); expect(first.senderAccepted).toBe(false);
    const recipientRumor = nip59.unwrapEvent(first.recipient, secret);
    const senderRumor = nip59.unwrapEvent(first.sender, senderSecret(db));
    expect(senderRumor).toEqual(recipientRumor);
    expect(recipientRumor.kind).toBe(14); expect(recipientRumor).not.toHaveProperty('sig');
    expect(recipientRumor.tags).toEqual([['p', pubkey]]);
    expect(verifyEvent(first.recipient)).toBe(true); expect(verifyEvent(first.sender)).toBe(true);
    acceptSender = true; job = db.prepare('SELECT * FROM jobs').get() as Job;
    await worker.deliverNostr(job, JSON.parse(job.payload));
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2][1].id).toBe(first.sender.id);
    expect(pool.destroy).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'unavailable'])('delivers via configured app relays when inbox metadata is %s', async mode => {
    const { db, sub } = fixture();
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), nostrEnabled: true, nostrRecipient: nip19.npubEncode(getPublicKey(generateSecretKey())) })); ingest(db, sub(), [release(1)]);
    const pool = { querySync: vi.fn(async () => { if (mode === 'unavailable') throw new Error('offline'); return []; }), publish: vi.fn(() => [Promise.resolve('accepted')]), destroy: vi.fn() };
    const job = db.prepare('SELECT * FROM jobs').get() as Job;
    await new Notifications(db, () => {}, () => pool as any).deliverNostr(job, JSON.parse(job.payload));
    expect(pool.publish).toHaveBeenCalledTimes(2);
    for (const call of pool.publish.mock.calls as any[]) expect(call[0]).toEqual(settings(db).discoveryRelays);
  });
  it('keeps an existing recipient-only wrap unchanged during upgrade', async () => {
    const { db, sub } = fixture(); const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), nostrEnabled: true, nostrRecipient: npub })); ingest(db, sub(), [release(1)]);
    const event = wrapMessage(db, npub, payload); db.prepare('UPDATE jobs SET event=?').run(JSON.stringify(event));
    const pool = { querySync: vi.fn(async () => []), publish: vi.fn((_relays: string[], _event: any) => [Promise.resolve('accepted')]), destroy: vi.fn() };
    const job = db.prepare('SELECT * FROM jobs').get() as Job;
    await new Notifications(db, () => {}, () => pool as any).deliverNostr(job, JSON.parse(job.payload));
    expect(pool.publish).toHaveBeenCalledTimes(1); expect(pool.publish.mock.calls[0][1].id).toBe(event.id);
  });
  it('rejects authentication errors and refuses SMTP servers without required STARTTLS', async () => {
    const server = new SMTPServer({ disabledCommands: ['STARTTLS'], onAuth(_auth, _session, done) { done(new Error('Invalid credentials')); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); resources.push(() => new Promise<void>(resolve => server.close(resolve)));
    const config = { host: '127.0.0.1', port: (server.server.address() as any).port, from: 'mailbox@example.com', username: 'test', password: 'wrong' };
    await expect(sendEmail({ ...config, security: 'plain' }, 'a@example.com', 'auth-test@example.com', payload)).rejects.toThrow();
    await expect(sendEmail({ ...config, security: 'starttls' }, 'a@example.com', 'tls-test@example.com', payload)).rejects.toThrow();
  });
});

describe('HTTP authentication and mailbox actions', () => {
  it('protects data, checks request origin, sanitizes settings, and updates read state', async () => {
    const { db, sub } = fixture(); setMeta(db, 'password_hash', hashPassword('correct-password')); ingest(db, sub(), [release(1)]);
    const service = createApp(db); const server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve)); resources.push(() => new Promise<void>(resolve => { service.close(); server.close(resolve as () => void); }));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    expect((await fetch(`${base}/api/mailbox`)).status).toBe(401);
    expect((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct-password' }) })).status).toBe(403);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mailbox-Request': '1' }, body: JSON.stringify({ password: 'correct-password' }) });
    expect(login.status).toBe(200); const cookie = login.headers.get('set-cookie')!.split(';')[0]; expect(cookie).toContain('mailbox_session=');
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Mailbox-Request': '1' };
    const list = await (await fetch(`${base}/api/releases`, { headers })).json(); expect(list[0].unread).toBe(1);
    await fetch(`${base}/api/releases/${list[0].id}`, { method: 'PATCH', headers, body: JSON.stringify({ unread: false }) }); expect((db.prepare('SELECT unread FROM releases').get() as any).unread).toBe(0);
    const created = await (await fetch(`${base}/api/categories`, { method: 'POST', headers, body: JSON.stringify({ name: 'Tools' }) })).json();
    db.prepare('UPDATE subscriptions SET category_id=? WHERE id=1').run(created.id);
    await fetch(`${base}/api/categories/${created.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Developer tools' }) });
    expect(db.prepare('SELECT name FROM categories').get()).toEqual({ name: 'Developer tools' });
    await fetch(`${base}/api/categories/${created.id}`, { method: 'DELETE', headers });
    expect(db.prepare('SELECT category_id FROM subscriptions').get()).toEqual({ category_id: null });
    expect(db.prepare('SELECT count(*) n FROM releases').get()).toEqual({ n: 1 });
    expect((await fetch(`${base}/api/read-all`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), githubToken: 'secret-test-token' })); const config = await (await fetch(`${base}/api/settings`, { headers })).json(); expect(config.githubToken).toBe(''); expect(JSON.stringify(config)).not.toContain('secret-test-token'); expect(config.senderNpub).toMatch(/^npub1/);
    setMeta(db, 'github_pause', String(Date.now() + 100000));
    await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ ...config, clearGithubToken: true }) });
    expect(settings(db).githubToken).toBe('');
    await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ ...config, clearGithubToken: false, githubToken: 'new-token' }) });
    expect(settings(db).githubToken).toBe('new-token');
    await fetch(`${base}/api/logout`, { method: 'POST', headers }); expect((await fetch(`${base}/api/mailbox`, { headers })).status).toBe(401);
    expect(checkPassword('wrong-password', hashPassword('correct-password'))).toBe(false);
  });
});
