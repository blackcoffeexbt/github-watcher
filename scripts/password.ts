import { openDb, setMeta, hashPassword } from '../server/db.js';
import { readFileSync } from 'node:fs';
const password = readFileSync(0, 'utf8').trim();
if (password.length < 12) throw new Error('Supply a password of at least 12 characters over stdin.');
const db = openDb(process.env.DATABASE_PATH || 'data/mailbox.sqlite');
setMeta(db, 'password_hash', hashPassword(password)); setMeta(db, 'password_source', 'manual'); db.prepare('DELETE FROM sessions').run(); db.close();
console.log('Mailbox password updated; existing sessions signed out.');
