import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { nextScheduledCheck } from '../server/schedule.js';
import { openDb, settings, setMeta } from '../server/db.js';
import { defaults, type GitHubRelease } from '../server/types.js';
import { GitHub, GitHubError } from '../server/github.js';
import { Poller } from '../server/poller.js';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });
const next = (after: string, overrides = {}) => new Date(nextScheduledCheck({ ...defaults, ...overrides }, Date.parse(after))).toISOString();
describe('clock schedule', () => {
  it('uses the next future slot and resets non-dividing intervals daily', () => {
    expect(next('2026-11-05T10:00:00Z')).toBe('2026-11-05T12:00:00.000Z');
    expect(next('2026-11-05T12:00:00Z')).toBe('2026-11-05T15:00:00.000Z');
    expect(next('2026-11-05T22:00:00Z', { checkEveryHours: 5, checkStartTime: '02:00' })).toBe('2026-11-06T02:00:00.000Z');
    expect(next('2026-11-05T12:59:00Z', { checkEveryHours: 5, checkStartTime: '17:00' })).toBe('2026-11-05T13:00:00.000Z');
    expect(next('2026-11-05T13:00:00Z', { checkEveryHours: 5, checkStartTime: '17:00' })).toBe('2026-11-05T17:00:00.000Z');
  });
  it('skips nonexistent times and uses repeated local times once', () => {
    const config = { checkEveryHours: 24, checkStartTime: '01:30' };
    expect(next('2026-03-29T00:00:00Z', config)).toBe('2026-03-30T00:30:00.000Z');
    expect(next('2026-10-25T00:00:00Z', config)).toBe('2026-10-25T00:30:00.000Z');
    expect(next('2026-10-25T00:45:00Z', config)).toBe('2026-10-26T01:30:00.000Z');
  });
  it('supports other timezones and minute precision', () => {
    expect(next('2026-11-05T10:00:00Z', { checkTimezone: 'America/New_York', checkEveryHours: 24, checkStartTime: '09:15' })).toBe('2026-11-05T14:15:00.000Z');
    expect(next('2026-07-05T10:00:00Z', { checkTimezone: 'America/New_York', checkEveryHours: 24, checkStartTime: '09:15' })).toBe('2026-07-05T13:15:00.000Z');
  });
});

function fixture(path = ':memory:') {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
  const db = openDb(path); cleanup.push(() => db.close());
  db.exec("INSERT INTO subscriptions(id,github_id,full_name,initialized,next_check) VALUES(1,1,'alpha/project',1,9999999999999),(2,2,'beta/project',1,0)");
  const releases = vi.fn(async (_sub: any) => [] as GitHubRelease[]);
  const poller = new Poller(db, { releases } as unknown as GitHub);
  return { db, releases, poller };
}
describe('shared polling schedule', () => {
  it('initializes existing mailboxes without an immediate poll, then checks all repositories together', async () => {
    const { db, releases, poller } = fixture();
    await poller.poll(); expect(releases).not.toHaveBeenCalled();
    expect(poller.schedule().nextCheck).toBe(Date.parse('2026-11-05T12:00:00Z'));
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z')); await poller.poll();
    expect(releases).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT next_check FROM subscriptions WHERE id=1').get()).toEqual({ next_check: 0 });
    expect(poller.schedule().nextCheck).toBe(Date.parse('2026-11-05T15:00:00Z'));
    await poller.poll(); expect(releases).toHaveBeenCalledTimes(2);
  });
  it('keeps manual refresh and immediate new imports separate from scheduled checks', async () => {
    const { db, releases, poller } = fixture(); const planned = poller.schedule();
    await poller.poll(true); expect(releases).toHaveBeenCalledTimes(2); expect(poller.schedule()).toEqual(planned);
    db.exec("INSERT INTO subscriptions(id,github_id,full_name) VALUES(3,3,'new/project')");
    await poller.poll(false, 3); expect(releases).toHaveBeenCalledTimes(3); expect(releases.mock.calls[2][0].id).toBe(3);
    expect(poller.schedule()).toEqual(planned);
  });
  it('waits for GitHub backoff even on manual refresh, then catches up once', async () => {
    const { db, releases, poller } = fixture();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    setMeta(db, 'github_pause', String(Date.parse('2026-11-05T12:30:00Z')));
    await poller.poll(true); await poller.poll(); expect(releases).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-11-05T12:30:00Z')); await poller.poll();
    expect(releases).toHaveBeenCalledTimes(2); expect(poller.schedule().nextCheck).toBe(Date.parse('2026-11-05T15:00:00Z'));
  });
  it('retries failed repositories without repeating successful checks', async () => {
    const { releases, poller } = fixture(); let fail = true;
    releases.mockImplementation(async sub => { if (sub.id === 2 && fail) throw new GitHubError('GitHub temporarily unavailable', Date.parse('2026-11-05T12:20:00Z')); return []; });
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z')); await poller.poll();
    vi.setSystemTime(new Date('2026-11-05T12:10:00Z')); await poller.poll(); expect(releases).toHaveBeenCalledTimes(2);
    fail = false; vi.setSystemTime(new Date('2026-11-05T12:20:00Z')); await poller.poll();
    expect(releases).toHaveBeenCalledTimes(3); expect(releases.mock.calls[2][0].id).toBe(2);
    expect(poller.schedule().nextCheck).toBe(Date.parse('2026-11-05T15:00:00Z'));
  });
  it('does not overwrite schedule changes made during a running poll or overlap polls', async () => {
    const { db, releases, poller } = fixture(); let finish!: () => void;
    releases.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z')); const running = poller.poll();
    await poller.poll(); expect(releases).toHaveBeenCalledTimes(1);
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), checkEveryHours: 5, checkStartTime: '02:00' }));
    const updated = poller.schedule(); finish(); await running;
    expect(poller.schedule()).toEqual(updated); expect(updated.nextCheck).toBe(Date.parse('2026-11-05T17:00:00Z'));
  });
  it('commits the scheduled slot, releases, and combined notifications together', async () => {
    const { db, releases, poller } = fixture();
    setMeta(db, 'settings', JSON.stringify({ ...settings(db), emailEnabled: true, emailRecipient: 'test@example.com', nostrEnabled: true, nostrRecipient: 'test-only' }));
    releases.mockImplementation(async sub => [{ id: sub.id, name: 'New release', tag_name: 'v1', body: '', html_url: 'https://github.com/example/project', published_at: '2026-11-05T11:00:00Z', draft: false, prerelease: false, author: { login: 'test' }, assets: [] }]);
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    db.exec("CREATE TRIGGER reject_queue BEFORE INSERT ON jobs BEGIN SELECT RAISE(FAIL, 'queue unavailable'); END;");
    await expect(poller.poll()).rejects.toThrow('queue unavailable');
    expect(poller.schedule().nextCheck).toBe(Date.parse('2026-11-05T12:00:00Z'));
    expect(db.prepare('SELECT COUNT(*) n FROM releases').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER reject_queue'); await poller.poll();
    const jobs = db.prepare('SELECT channel,payload FROM jobs ORDER BY channel').all() as { channel: string; payload: string }[];
    expect(jobs.map(job => job.channel)).toEqual(['email', 'nostr']);
    for (const job of jobs) expect(JSON.parse(job.payload).releases).toHaveLength(2);
    expect(poller.schedule().nextCheck).toBe(Date.parse('2026-11-05T15:00:00Z'));
  });
  it('persists overdue slots across restart and runs just one catch-up poll', async () => {
    const dir = mkdtempSync(`${tmpdir()}/mailbox-schedule-`); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { db, poller } = fixture(`${dir}/mailbox.sqlite`); const stored = poller.schedule(); db.close(); cleanup.pop();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
    const restored = openDb(`${dir}/mailbox.sqlite`); cleanup.push(() => restored.close());
    const releases = vi.fn(async () => []); const restarted = new Poller(restored, { releases } as unknown as GitHub);
    expect(restarted.schedule()).toEqual(stored); await restarted.poll(); await restarted.poll();
    expect(releases).toHaveBeenCalledTimes(2); expect(restarted.schedule().nextCheck).toBe(Date.parse('2026-11-07T12:00:00Z'));
  });
});
