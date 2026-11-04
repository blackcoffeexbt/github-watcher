import { openDb } from '../server/db.js';
import { ingest } from '../server/poller.js';
import { spawn } from 'node:child_process';
import type { Subscription, GitHubRelease } from '../server/types.js';
const path = 'data/demo.sqlite';
const db = openDb(path);
db.exec('DELETE FROM jobs; DELETE FROM subscriptions; DELETE FROM categories; DELETE FROM cache;');
const groups = [{ name: 'Bitcoin', repos: ['bitcoin/bitcoin', 'mempool/mempool'] }, { name: 'Lightning', repos: ['lightningnetwork/lnd', 'ElementsProject/lightning', 'ACINQ/phoenix'] }, { name: 'Wallets', repos: ['sparrowwallet/sparrow', 'bluewallet/bluewallet'] }];
let id = 1;
for (const group of groups) {
  const category = Number(db.prepare('INSERT INTO categories(name) VALUES (?)').run(group.name).lastInsertRowid);
  for (const repository of group.repos) {
    const subId = Number(db.prepare('INSERT INTO subscriptions(github_id,full_name,category_id,prerelease) VALUES(?,?,?,1)').run(id++, repository, category).lastInsertRowid);
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId) as Subscription;
    const history: GitHubRelease[] = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: i === 0 ? 'Example stable release' : i === 1 ? 'Example release candidate' : `Example maintenance release ${7 - i}`, tag_name: `demo-${7 - i}`, body: `> Offline demo: these are sample notes, not actual project releases.\n\n## Release notes\n\nThis example shows how release notes look in your mailbox. In normal mode, notes come directly from GitHub.\n\n### What’s new\n\n- Updated the settings interface.\n- Performance improvements and small refinements throughout.\n- Fixed an error when loading a missing configuration file.\n\n### Getting started\n\nRead the [project documentation](https://github.com/${repository}) before updating. Always follow the project’s own upgrade instructions.\n\n\`demo-${7 - i}\` · Published for interface testing.`, html_url: `https://github.com/${repository}/releases`, published_at: new Date(Date.now() - i * 7 * 86400_000).toISOString(), draft: false, prerelease: i === 1, author: { login: 'demo-maintainer' }, assets: [] }));
    ingest(db, sub, history);
  }
}
db.close();
console.log('Offline demo: sample data only. Sign in with mailbox-demo-local at http://127.0.0.1:5173');
const child = spawn(process.execPath, ['scripts/dev.mjs'], { stdio: 'inherit', env: { ...process.env, DEMO_MODE: 'true', DATABASE_PATH: path, MAILBOX_PASSWORD: 'mailbox-demo-local', RUNTIME_CONFIG: '', SMTP_HOST: '' } });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code || 0));
