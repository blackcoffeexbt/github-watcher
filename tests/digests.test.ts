import { afterEach, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { generateSecretKey, getPublicKey, nip19, nip59 } from 'nostr-tools';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, setMeta, settings } from '../server/db.js';
import { Poller } from '../server/poller.js';
import { messageText, messageHtml, messageSubject, sendEmail, wrapMessage, type DigestPayload } from '../server/notifications.js';
import type { GitHub } from '../server/github.js';
import type { GitHubRelease, Subscription } from '../server/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const db = openDb(':memory:'); cleanup.push(() => { db.close(); });
  db.prepare("INSERT INTO subscriptions(id,github_id,full_name,initialized) VALUES(1,101,'alpha/project',1),(2,102,'beta/project',1)").run();
  setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'recipient@example.com', nostrEnabled: true, nostrRecipient: nip19.npubEncode(getPublicKey(generateSecretKey())) }));
  const jobs = () => db.prepare('SELECT * FROM jobs ORDER BY id').all() as { id: number; channel: string; recipient: string; payload: string; message_id: string }[];
  return { db, jobs };
}
function release(id: number, prerelease = false): GitHubRelease { return { id, name: `Release ${id}`, tag_name: `v${id}`, body: `Notes ${id}`, html_url: `https://github.com/example/project/releases/tag/v${id}`, published_at: `2026-11-${String(id).padStart(2, '0')}T12:00:00Z`, draft: false, prerelease, author: { login: 'author' }, assets: [] }; }
function client(releases: (sub: Subscription) => Promise<GitHubRelease[]>) { return { releases } as unknown as GitHub; }

describe('poll digests', () => {
  it('queues one message per channel across multiple repositories, and keeps later polls separate', async () => {
    const { db, jobs } = fixture();
    let includeNew = false;
    const poller = new Poller(db, client(async sub => sub.id === 1 ? [release(1), release(2), ...(includeNew ? [release(4)] : [])] : [release(3)]));
    await poller.poll(true);
    expect(jobs().map(j => j.channel)).toEqual(['email', 'nostr']);
    for (const job of jobs()) {
      const digest = JSON.parse(job.payload) as DigestPayload;
      expect(digest.kind).toBe('release-digest');
      expect(digest.releases).toHaveLength(3);
      expect(digest.releases.map(r => r.repository)).toEqual(['alpha/project', 'alpha/project', 'beta/project']);
    }
    await poller.poll(true); expect(jobs()).toHaveLength(2);
    includeNew = true; await poller.poll(true);
    expect(jobs()).toHaveLength(4);
    expect(JSON.parse(jobs()[2].payload).releases).toHaveLength(1);
    expect(jobs()[0].message_id).not.toBe(jobs()[2].message_id);
  });
  it('applies release-type and per-repository channel choices independently', async () => {
    const { db, jobs } = fixture();
    db.prepare('UPDATE subscriptions SET nostr=0 WHERE id=1').run();
    db.prepare('UPDATE subscriptions SET stable=0,prerelease=1,email=0 WHERE id=2').run();
    await new Poller(db, client(async () => [release(1), release(2, true)])).poll(true);
    const email = JSON.parse(jobs().find(j => j.channel === 'email')!.payload) as DigestPayload;
    const nostr = JSON.parse(jobs().find(j => j.channel === 'nostr')!.payload) as DigestPayload;
    expect(email.releases.map(r => [r.repository, r.tag])).toEqual([['alpha/project', 'v1']]);
    expect(nostr.releases.map(r => [r.repository, r.tag])).toEqual([['beta/project', 'v2']]);
    expect(db.prepare('SELECT COUNT(*) n FROM releases').get()).toEqual({ n: 4 });
  });
  it('does not send a summary when nothing matches or a channel is disabled', async () => {
    const { db, jobs } = fixture();
    await new Poller(db, client(async () => [release(1, true)])).poll(true);
    expect(jobs()).toHaveLength(0);
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: false }));
    await new Poller(db, client(async () => [release(1, true), release(2)])).poll(true);
    expect(jobs().map(j => j.channel)).toEqual(['nostr']);
  });
  it('includes successful repositories even when another repository fails', async () => {
    const { db, jobs } = fixture();
    await new Poller(db, client(async sub => { if (sub.id === 2) throw new Error('GitHub unavailable'); return [release(1), release(2)]; })).poll(true);
    expect(jobs()).toHaveLength(2);
    expect(JSON.parse(jobs()[0].payload).releases.map((r: any) => r.repository)).toEqual(['alpha/project', 'alpha/project']);
    expect(db.prepare('SELECT error FROM subscriptions WHERE id=2').get()).toEqual({ error: 'GitHub unavailable' });
  });
  it('does not expose partial summaries and snapshots recipients for the whole poll', async () => {
    const { db, jobs } = fixture();
    let finish!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const poll = new Poller(db, client(async sub => { if (sub.id === 2) { entered(); await gate; } return [release(sub.id)]; })).poll(true);
    await waiting;
    expect(jobs()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM releases').get()).toEqual({ n: 0 });
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailRecipient: 'changed@example.com' }));
    finish(); await poll;
    expect(jobs().find(j => j.channel === 'email')!.recipient).toBe('recipient@example.com');
    expect(JSON.parse(jobs()[0].payload).releases).toHaveLength(2);
  });
  it('rolls release detection back if queueing fails, so a restart can retry without losing alerts', async () => {
    const { db, jobs } = fixture();
    db.exec("CREATE TRIGGER reject_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(FAIL, 'simulated queue failure'); END;");
    const poller = new Poller(db, client(async () => [release(1)]));
    await expect(poller.poll(true)).rejects.toThrow('simulated queue failure');
    expect(jobs()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM releases').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT next_check FROM subscriptions WHERE id=1').get()).toEqual({ next_check: 0 });
    db.exec('DROP TRIGGER reject_jobs');
    await new Poller(db, client(async () => [release(1)])).poll(true);
    expect(jobs()).toHaveLength(2);
    expect(JSON.parse(jobs()[0].payload).releases).toHaveLength(2);
  });
  it('omits a repository unsubscribed while GitHub requests are in progress', async () => {
    const { db, jobs } = fixture();
    await new Poller(db, client(async sub => { if (sub.id === 2) db.prepare('DELETE FROM subscriptions WHERE id=1').run(); return [release(sub.id)]; })).poll(true);
    expect(JSON.parse(jobs()[0].payload).releases.map((r: any) => r.repository)).toEqual(['beta/project']);
  });
  it('preserves a queued summary and message ID across restart without requeueing its releases', async () => {
    const dir = mkdtempSync(`${tmpdir()}/mailbox-digest-`);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let db = openDb(`${dir}/mailbox.sqlite`);
    cleanup.push(() => { db.close(); });
    db.prepare("INSERT INTO subscriptions(github_id,full_name,initialized) VALUES(1,'alpha/project',1)").run();
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'recipient@example.com' }));
    const github = client(async () => [release(1), release(2)]);
    await new Poller(db, github).poll(true);
    const queued = db.prepare('SELECT payload,message_id FROM jobs').get();
    db.close(); db = openDb(`${dir}/mailbox.sqlite`);
    await new Poller(db, github).poll(true);
    expect(db.prepare('SELECT payload,message_id FROM jobs').all()).toEqual([queued]);
  });
});

describe('digest messages', () => {
  const item = { repository: 'beta/project', title: 'Release <script>bad</script>', tag: 'v1', prerelease: false, publishedAt: '2026-11-01', excerpt: '<img src=x>', url: 'https://github.com/example/project/releases/tag/v1' };
  const digest: DigestPayload = { kind: 'release-digest', polledAt: '2026-11-04T12:00:00Z', releases: [item, { ...item, repository: 'alpha/project', title: 'Older', tag: 'v2' }, { ...item, repository: 'alpha/project', title: 'Newest', tag: 'v3', publishedAt: '2026-11-03', prerelease: true }] };
  it('uses only the requested heading and release lines in repository order', () => {
    const text = messageText(digest); const html = messageHtml(digest);
    expect(text).toBe('New releases from your watch list\n\n- alpha/project v3 available 00:00:00 3/11/2026\n- alpha/project v2 available 00:00:00 1/11/2026\n- beta/project v1 available 00:00:00 1/11/2026');
    expect(html.match(/<li>/g)).toHaveLength(3);
    for (const content of [text, html]) {
      for (const excluded of ['Poll completed', 'Newest', 'Older', '<script>', '<img', 'https://', 'Pre-release']) expect(content).not.toContain(excluded);
    }
    expect(messageSubject(digest)).toBe('New releases from your watch list');
  });
  it('formats local publication time and escapes repository and tag text in HTML', () => {
    const payload = { ...item, repository: 'Start9Labs/StartOS', tag: 'v1.2.3', publishedAt: '2026-11-05T02:02:01Z' };
    expect(messageText(payload)).toBe('New releases from your watch list\n\n- Start9Labs/StartOS v1.2.3 available 02:02:01 5/11/2026');
    expect(messageText({ ...payload, publishedAt: '2026-07-05T02:02:01Z' })).toContain('03:02:01 5/7/2026');
    expect(messageHtml({ ...payload, tag: '<img src=x>' })).toContain('&lt;img src=x&gt;');
    expect(messageHtml({ ...payload, tag: '<img src=x>' })).not.toContain('<img');
  });
  it('puts all repositories in a single encrypted DM', () => {
    const db = openDb(':memory:'); cleanup.push(() => { db.close(); });
    const recipient = generateSecretKey();
    const wrap = wrapMessage(db, nip19.npubEncode(getPublicKey(recipient)), digest);
    expect(nip59.unwrapEvent(wrap, recipient).content).toBe(messageText(digest));
  });
  it('sends the whole digest in one SMTP message with a stable ID', async () => {
    let messages = 0; let raw = '';
    const server = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _session, done) { messages++; stream.on('data', chunk => raw += chunk); stream.on('end', done); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(resolve)));
    await sendEmail({ host: '127.0.0.1', port: (server.server.address() as any).port, from: 'mailbox@example.com', security: 'plain' }, 'recipient@example.com', 'digest@example.com', digest);
    expect(messages).toBe(1); expect(raw).toContain('Message-ID: <digest@example.com>');
    expect(raw).toContain('New releases from your watch list'); expect(raw).toContain('alpha/project'); expect(raw).toContain('beta/project');
    expect(raw).toContain('text/plain'); expect(raw).toContain('text/html');
  });
});
