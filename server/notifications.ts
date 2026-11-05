import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import WebSocket from 'ws';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { nip19, nip17, nip59, getPublicKey, finalizeEvent, type NostrEvent } from 'nostr-tools';
import { type Db, settings, senderSecret } from './db.js';

class RelayWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url);
    // nostr-tools clears its DOM onerror handler before closing sockets. Node's
    // ws emits a later error when that close interrupts the opening handshake.
    // Keep a Node listener for the socket's lifetime; the pool still rejects the
    // operation normally, so the notification worker records and retries it.
    this.on('error', () => {});
  }
}
useWebSocketImplementation(RelayWebSocket);
export interface Smtp { host: string; port: number; from: string; username?: string | null; password?: string | null; security: 'tls' | 'starttls' | 'plain' }
export function smtpConfig(): Smtp | null {
  if (process.env.RUNTIME_CONFIG) {
    try { return JSON.parse(readFileSync(process.env.RUNTIME_CONFIG, 'utf8')).smtp || null; } catch { return null; }
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return null;
  return { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), from: process.env.SMTP_FROM, username: process.env.SMTP_USER, password: process.env.SMTP_PASSWORD, security: (process.env.SMTP_SECURITY || 'starttls') as Smtp['security'] };
}
export function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
export interface ReleasePayload { repository: string; title: string; tag: string; prerelease: boolean; publishedAt: string; excerpt: string; url: string }
export interface DigestPayload { kind: 'release-digest'; polledAt: string; releases: ReleasePayload[] }
export type Payload = ReleasePayload | DigestPayload;
export function groupedReleases(payload: DigestPayload): [string, ReleasePayload[]][] {
  const groups = new Map<string, ReleasePayload[]>();
  for (const release of payload.releases) { const list = groups.get(release.repository) || []; list.push(release); groups.set(release.repository, list); }
  return [...groups].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([repository, releases]) => [repository, releases.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.tag.localeCompare(b.tag, 'en'))]);
}
const notificationHeading = 'New releases from your watch list';
const releaseDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'numeric', year: 'numeric' });
function releaseLine(p: ReleasePayload) {
  const date = new Date(p.publishedAt);
  const parts = Object.fromEntries(releaseDate.formatToParts(date).map(part => [part.type, part.value]));
  return `${p.repository} ${p.tag} available ${parts.hour}:${parts.minute}:${parts.second} ${Number(parts.day)}/${Number(parts.month)}/${parts.year}`;
}
function notificationReleases(p: Payload) { return 'releases' in p ? groupedReleases(p).flatMap(([, releases]) => releases) : [p]; }
export function messageText(p: Payload): string {
  return `${notificationHeading}\n\n${notificationReleases(p).map(release => `- ${releaseLine(release)}`).join('\n')}`;
}
export function messageHtml(p: Payload): string {
  return `<div style="font:16px/1.6 system-ui,sans-serif"><p>${notificationHeading}</p><ul>${notificationReleases(p).map(release => `<li>${escapeHtml(releaseLine(release))}</li>`).join('')}</ul></div>`;
}
export function messageSubject(_p: Payload) { return notificationHeading; }
export async function sendEmail(config: Smtp, recipient: string, messageId: string, payload: Payload) {
  const transport = nodemailer.createTransport({ name: 'release-mailbox.local', host: config.host, port: config.port, secure: config.security === 'tls', requireTLS: config.security === 'starttls', ignoreTLS: config.security === 'plain', auth: config.username ? { user: config.username, pass: config.password || '' } : undefined, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  try { await transport.sendMail({ from: config.from, to: recipient, subject: messageSubject(payload), messageId: `<${messageId}>`, text: messageText(payload), html: messageHtml(payload) }); } finally { transport.close(); }
}
export function recipientKey(npub: string) { try { const decoded = nip19.decode(npub); if (decoded.type === 'npub') return decoded.data; } catch {} throw new Error('Enter a valid recipient npub.'); }
export function wrapMessage(db: Db, recipient: string, payload: Payload) { return nip17.wrapEvent(senderSecret(db), { publicKey: recipientKey(recipient) }, messageText(payload)); }
export function wrapMessageCopies(db: Db, recipient: string, payload: Payload) {
  const secret = senderSecret(db);
  const pubkey = recipientKey(recipient);
  const rumor = nip59.createRumor({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', pubkey]], content: messageText(payload) }, secret);
  const wrap = (key: string) => nip59.createWrap(nip59.createSeal(rumor, secret, key), key);
  return { recipient: wrap(pubkey), sender: wrap(getPublicKey(secret)), recipientAccepted: false, senderAccepted: false };
}
export function validRelay(url: string) { try { const parsed = new URL(url); return parsed.protocol === 'wss:' && !parsed.username && !parsed.password; } catch { return false; } }
export interface Job { id: number; channel: 'email' | 'nostr'; recipient: string; payload: string; event: string | null; message_id: string; attempts: number }
export class Notifications {
  busy = false;
  constructor(private db: Db, private changed = () => {}, private createPool: () => Pick<SimplePool, 'querySync' | 'publish' | 'destroy'> = () => new SimplePool()) {}
  async deliverNostr(job: Job, payload: Payload) {
    const pool = this.createPool();
    try {
      const pubkey = recipientKey(job.recipient);
      const sender = getPublicKey(senderSecret(this.db));
      const configured = settings(this.db).discoveryRelays.filter(validRelay);
      // Anagram includes app relays even when inbox metadata is unavailable.
      const events = await pool.querySync(configured, { kinds: [10050], authors: [pubkey, sender] }, { maxWait: 8000 }).catch(() => []);
      const relaysFor = (key: string) => {
        const inbox = events.filter(e => e.pubkey === key).sort((a, b) => b.created_at - a.created_at)[0];
        return [...new Set([...(inbox?.tags.filter(t => t[0] === 'relay' && validRelay(t[1])).map(t => t[1]) || []), ...configured])].slice(0, 20);
      };
      const stored = job.event ? JSON.parse(job.event) : wrapMessageCopies(this.db, job.recipient, payload);
      // Preserve previously persisted recipient wraps and their IDs on upgrade.
      const copies = 'kind' in stored ? { recipient: stored as NostrEvent, sender: null, recipientAccepted: false, senderAccepted: true } : stored as ReturnType<typeof wrapMessageCopies>;
      const save = () => this.db.prepare('UPDATE jobs SET event=? WHERE id=?').run(JSON.stringify(copies), job.id);
      save();
      for (const role of ['recipient', 'sender'] as const) {
        const accepted = role === 'recipient' ? 'recipientAccepted' : 'senderAccepted';
        if (copies[accepted] || !copies[role]) continue;
        const results = await Promise.allSettled(pool.publish(relaysFor(role === 'recipient' ? pubkey : sender), copies[role]!, { onauth: async event => finalizeEvent(event, senderSecret(this.db)) }).map(p => Promise.race([p, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('Relay timed out.')), 15_000); t.unref(); })])));
        if (results.some(r => r.status === 'fulfilled')) { copies[accepted] = true; save(); }
      }
      if (!copies.recipientAccepted || !copies.senderAccepted) throw new Error('No recipient relay accepted the message or sender history copy. Check relay access and retry.');
    } finally { pool.destroy(); }
  }
  async run() {
    if (this.busy) return; this.busy = true;
    try {
      const enabled = settings(this.db);
      const jobs = this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND next_attempt<=? AND ((channel='email' AND ?=1) OR (channel='nostr' AND ?=1)) ORDER BY id LIMIT 30").all(Date.now(), +enabled.emailEnabled, +enabled.nostrEnabled) as Job[];
      for (const job of jobs) {
        const config = settings(this.db);
        if (job.channel === 'email' ? !config.emailEnabled : !config.nostrEnabled) continue;
        try {
          const payload = JSON.parse(job.payload);
          if (job.channel === 'email') { const smtp = smtpConfig(); if (!smtp) throw new Error('SMTP is not configured. Use Configure SMTP in StartOS.'); await sendEmail(smtp, job.recipient, job.message_id, payload); }
          else await this.deliverNostr(job, payload);
          this.db.prepare("UPDATE jobs SET state='accepted',attempts=attempts+1,error=NULL WHERE id=?").run(job.id);
        } catch (error) {
          // Provider errors can contain credentials or message content; expose only known, safe diagnostics.
          const known = error instanceof Error && /^(SMTP is not|Recipient has no|No recipient relay|Enter a valid)/.test(error.message);
          const diagnostic = known ? (error as Error).message : `${job.channel === 'email' ? 'SMTP' : 'Nostr'} delivery failed. Check connection, authentication, and recipient settings.`;
          const attempts = job.attempts + 1;
          const smtpCode = (error as { responseCode?: number }).responseCode || 0;
          const permanent = job.channel === 'email' && smtpCode >= 500 && smtpCode < 600;
          this.db.prepare('UPDATE jobs SET state=?,attempts=?,next_attempt=?,error=? WHERE id=?').run(attempts >= 8 || permanent ? 'failed' : 'pending', attempts, Date.now() + Math.min(3600_000 * 3, 60_000 * 2 ** attempts), diagnostic, job.id);
        }
        this.changed();
      }
    } finally { this.busy = false; }
  }
}
