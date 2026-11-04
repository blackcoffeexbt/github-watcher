import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { defaults, type Settings } from './types.js';

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
    CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY, github_id INTEGER UNIQUE NOT NULL, full_name TEXT UNIQUE COLLATE NOCASE NOT NULL, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, stable INTEGER NOT NULL DEFAULT 1, prerelease INTEGER NOT NULL DEFAULT 0, email INTEGER NOT NULL DEFAULT 1, nostr INTEGER NOT NULL DEFAULT 1, initialized INTEGER NOT NULL DEFAULT 0, last_checked TEXT, next_check INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, github_id INTEGER NOT NULL, title TEXT NOT NULL, tag TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, published_at TEXT NOT NULL, author TEXT NOT NULL, prerelease INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 0, alerted_pre INTEGER NOT NULL DEFAULT 0, alerted_stable INTEGER NOT NULL DEFAULT 0, assets TEXT NOT NULL, UNIQUE(subscription_id, github_id));
    CREATE TABLE IF NOT EXISTS cache (url TEXT PRIMARY KEY, etag TEXT, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, release_id INTEGER REFERENCES releases(id) ON DELETE CASCADE, channel TEXT NOT NULL, phase TEXT NOT NULL, recipient TEXT NOT NULL, payload TEXT NOT NULL, event TEXT, message_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(release_id,channel,phase));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');`);
  const put = db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)');
  put.run('settings', JSON.stringify(defaults));
  put.run('nostr_secret', Buffer.from(generateSecretKey()).toString('hex'));
  return db;
}
export type Db = ReturnType<typeof openDb>;
export function getMeta(db: Db, key: string) { return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
export function setMeta(db: Db, key: string, value: string) { db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
export function settings(db: Db): Settings { return { ...defaults, ...JSON.parse(getMeta(db, 'settings')!) }; }
export function senderSecret(db: Db) { return Uint8Array.from(Buffer.from(getMeta(db, 'nostr_secret')!, 'hex')); }
export function senderNpub(db: Db) { return nip19.npubEncode(getPublicKey(senderSecret(db))); }
export function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
export function checkPassword(password: string, hash: string) { const [salt, digest] = hash.split(':'); const actual = scryptSync(password, salt, 64); const expected = Buffer.from(digest, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected); }
