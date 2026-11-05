import { type Db, getMeta, setMeta, settings } from './db.js';
import type { GitHubRelease, Subscription } from './types.js';

export function parseRepository(input: string) {
  let name = input.trim().replace(/\/$/, '').replace(/\.git$/, '');
  if (name.startsWith('https://')) { const url = new URL(name); if (url.hostname !== 'github.com' || url.search || url.hash || url.username || url.password) throw new Error('Use a public github.com repository URL.'); name = url.pathname.slice(1); }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(name) || name.split('/')[1] === '..') throw new Error('Enter owner/repo or a GitHub repository URL.');
  return name;
}
export class GitHubError extends Error { constructor(message: string, public retryAt = Date.now() + 3 * 3600_000) { super(message); } }
export class GitHub {
  private queue: Promise<void> = Promise.resolve();
  constructor(private db: Db, private request: typeof fetch = fetch) {}
  get(path: string): Promise<any> {
    const result = this.queue.then(() => this.getNow(path));
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private async getNow(path: string) {
    const pause = Number(getMeta(this.db, 'github_pause') || 0);
    if (pause > Date.now()) throw new GitHubError(`GitHub rate limit reached. Retry after ${new Date(pause).toISOString()}.`, pause);
    const url = path.startsWith('https://') ? new URL(path) : new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com') throw new Error('Unexpected GitHub API destination.');
    const cache = this.db.prepare('SELECT * FROM cache WHERE url=?').get(url.href) as { etag: string; body: string } | undefined;
    const token = settings(this.db).githubToken;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-release-mailbox' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cache?.etag) headers['If-None-Match'] = cache.etag;
    const response = await this.request(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 304 && cache) { setMeta(this.db, 'github_backoff', '0'); return JSON.parse(cache.body); }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const message = typeof errorBody?.message === 'string' ? errorBody.message : '';
      const limited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit exceeded|secondary rate limit|abuse detection/i.test(message)));
      if (limited) {
        const retry = response.headers.get('retry-after');
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const failures = Number(getMeta(this.db, 'github_backoff') || 0) + 1;
        setMeta(this.db, 'github_backoff', String(failures));
        const delay = Math.min(3 * 3600_000, 60_000 * 2 ** Math.min(failures - 1, 8));
        const retryDelay = retry ? Number(retry) * 1000 : NaN;
        const until = Number.isFinite(retryDelay) && retryDelay >= 0 ? Date.now() + retryDelay : response.headers.get('x-ratelimit-remaining') === '0' ? Math.max(Date.now() + delay, reset || 0) : Date.now() + delay;
        setMeta(this.db, 'github_pause', String(until));
        throw new GitHubError(`GitHub rate limit reached. Retry after ${new Date(until).toISOString()}.`, until);
      }
      if (response.status === 401) throw new GitHubError('GitHub rejected the token. Check whether it has expired or been revoked.');
      if (response.status === 403) throw new GitHubError(/token.*lifetime|lifetime.*token/i.test(message) ? 'This organization rejects the GitHub token lifetime. Shorten its expiry in GitHub token settings to meet the organization policy, then retry.' : 'GitHub denied access to this repository. Check token permissions and organization access policies.');
      throw new GitHubError(response.status === 404 ? 'Repository unavailable. Check its name and public visibility.' : `GitHub request failed (${response.status}).`, Date.now() + (response.status === 404 ? 24 : 3) * 3600_000);
    }
    setMeta(this.db, 'github_backoff', '0');
    const body = await response.json();
    this.db.prepare('INSERT INTO cache VALUES (?,?,?) ON CONFLICT(url) DO UPDATE SET etag=excluded.etag,body=excluded.body').run(url.href, response.headers.get('etag'), JSON.stringify(body));
    return body;
  }
  async repository(name: string) { const repo = await this.get(`/repos/${parseRepository(name)}`); if (repo.private) throw new Error('Only public repositories are supported.'); return repo as { id: number; full_name: string }; }
  async releases(sub: Subscription): Promise<GitHubRelease[]> {
    const releases: GitHubRelease[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.get(`/repos/${sub.full_name}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub response.');
      releases.push(...batch.filter((r: GitHubRelease) => !r.draft));
      if (batch.length < 100) return releases;
    }
  }
}
