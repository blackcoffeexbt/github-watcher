import { randomUUID } from 'node:crypto';
import { type Db, settings } from './db.js';
import { GitHub, GitHubError } from './github.js';
import type { GitHubRelease, Release, Subscription, Settings } from './types.js';
import type { ReleasePayload, DigestPayload } from './notifications.js';

export const INTERVAL = 3 * 3600_000;
export function notificationPayload(sub: Subscription, release: GitHubRelease) {
  return { repository: sub.full_name, title: release.name || release.tag_name, tag: release.tag_name, prerelease: release.prerelease, publishedAt: release.published_at, excerpt: (release.body || '').replace(/<[^>]*>/g, '').slice(0, 600), url: release.html_url };
}
interface PollBatch { config: Settings; polledAt: string; email: ReleasePayload[]; nostr: ReleasePayload[] }
function newBatch(db: Db): PollBatch { return { config: settings(db), polledAt: new Date().toISOString(), email: [], nostr: [] }; }
function enqueueBatch(db: Db, batch: PollBatch) {
  batch.polledAt = new Date().toISOString();
  for (const channel of ['email', 'nostr'] as const) {
    if (!batch[channel].length) continue;
    const payload: DigestPayload = { kind: 'release-digest', polledAt: batch.polledAt, releases: batch[channel] };
    db.prepare('INSERT INTO jobs(channel,phase,recipient,payload,message_id) VALUES (?,?,?,?,?)').run(channel, 'poll', channel === 'email' ? batch.config.emailRecipient : batch.config.nostrRecipient, JSON.stringify(payload), `${randomUUID()}@release-mailbox.local`);
  }
}
export function ingest(db: Db, sub: Subscription, releases: GitHubRelease[], batch?: PollBatch) {
  const target = batch || newBatch(db);
  const config = target.config;
  const published = releases.filter(r => !r.draft).sort((a, b) => b.published_at.localeCompare(a.published_at));
  const matches = (r: GitHubRelease) => r.prerelease ? !!sub.prerelease : !!sub.stable;
  const latest = published.find(matches)?.id;
  db.transaction(() => {
    for (const release of published) {
      const old = db.prepare('SELECT * FROM releases WHERE subscription_id=? AND github_id=?').get(sub.id, release.id) as (Release & { alerted_pre: number; alerted_stable: number }) | undefined;
      const phase = release.prerelease ? 'pre' : 'stable';
      const eligible = !sub.initialized ? release.id === latest : !old || (!!old.prerelease && !release.prerelease);
      const alert = matches(release) && eligible && !(phase === 'pre' ? old?.alerted_pre : old?.alerted_stable);
      db.prepare(`INSERT INTO releases(subscription_id,github_id,title,tag,body,url,published_at,author,prerelease,unread,alerted_pre,alerted_stable,assets) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id,github_id) DO UPDATE SET title=excluded.title,tag=excluded.tag,body=excluded.body,url=excluded.url,published_at=excluded.published_at,author=excluded.author,prerelease=excluded.prerelease,unread=MAX(releases.unread,excluded.unread),alerted_pre=MAX(releases.alerted_pre,excluded.alerted_pre),alerted_stable=MAX(releases.alerted_stable,excluded.alerted_stable),assets=excluded.assets`).run(sub.id, release.id, release.name || release.tag_name, release.tag_name, release.body || '', release.html_url, release.published_at, release.author?.login || 'Unknown', +release.prerelease, +alert, +(phase === 'pre'), +(phase === 'stable'), JSON.stringify(release.assets || []));
      if (alert) {
        for (const channel of ['email', 'nostr'] as const) {
          const enabled = channel === 'email' ? sub.email && config.emailEnabled && config.emailRecipient : sub.nostr && config.nostrEnabled && config.nostrRecipient;
          if (!enabled) continue;
          target[channel].push(notificationPayload(sub, release));
        }
      }
    }
    db.prepare('UPDATE subscriptions SET initialized=1,last_checked=?,next_check=?,error=NULL WHERE id=?').run(new Date().toISOString(), Date.now() + INTERVAL, sub.id);
    if (!batch) enqueueBatch(db, target);
  })();
}
export class Poller {
  busy = false;
  constructor(private db: Db, private github = new GitHub(db), private changed = () => {}) {}
  async poll(force = false) {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = newBatch(this.db);
      const fetched: { sub: Subscription; releases: GitHubRelease[] }[] = [];
      const subs = this.db.prepare('SELECT * FROM subscriptions WHERE next_check<=? ORDER BY id').all(force ? Number.MAX_SAFE_INTEGER : Date.now()) as Subscription[];
      for (const sub of subs) {
        try { fetched.push({ sub, releases: await this.github.releases(sub) }); }
        catch (error) { this.db.prepare('UPDATE subscriptions SET error=?,next_check=? WHERE id=?').run(error instanceof Error ? error.message : 'Update failed.', error instanceof GitHubError ? error.retryAt : Date.now() + INTERVAL, sub.id); }
      }
      // Fetch before opening the transaction: no partial poll can be delivered,
      // and a crash before commit leaves releases due for the next run.
      this.db.transaction(() => {
        for (const { sub, releases } of fetched) {
          if (this.db.prepare('SELECT 1 FROM subscriptions WHERE id=?').get(sub.id)) ingest(this.db, sub, releases, batch);
        }
        enqueueBatch(this.db, batch);
      })();
      this.changed();
    } finally { this.busy = false; }
  }
}
