# Release Mailbox

A self-hosted mailbox for public GitHub releases. React, TypeScript, Tailwind, Node 22, and SQLite. Follow repositories in categories, browse New/Old history, and receive email or encrypted Nostr DMs. The backend checks on the shared schedule configured in Settings, whether or not the browser is open.

## Run locally

Requires Node **22.17 or newer**, npm, and internet access to GitHub. StartOS and Docker are not required for local development.

```sh
npm ci --legacy-peer-deps
cp .env.example .env
# Edit .env and set MAILBOX_PASSWORD to a password of at least 12 characters.
npm run dev
```

Open **http://127.0.0.1:5173** and sign in with your chosen password. This is the complete application: subscriptions, SQLite persistence, polling, and delivery workers all run locally. The fresh mailbox starts empty. Add `owner/repo` or a public GitHub URL. The latest matching release starts unread; older history is imported as read. Opening a release marks it read. Matching stable promotions can alert again. Preference changes apply to future detections.

To explore without GitHub access, stop any running development server and run `npm run demo`. Sign in with **mailbox-demo-local**. This clearly labeled offline demo uses a separate `data/demo.sqlite` database with sample notes; background polling and automatic delivery are disabled. Every demo launch resets its sample data. Normal `npm run dev` uses your original database and settings.

`npm run dev` loads `.env`. Other commands read environment variables from the shell. For a local production build:

```sh
npm run build
# Use the password already stored by the development server, or export MAILBOX_PASSWORD.
npm run serve
```

Open **http://127.0.0.1:3000**. Stop the development server first because both backends use port 3000. The development and production runs use `data/mailbox.sqlite` by default. The UI and database are shared across your devices when you configure access to the server; the theme is stored per browser.

### Local email testing

Start a disposable Mailpit inbox:

```sh
docker compose --profile test-mail up -d mailpit
```

Set these in `.env`, then restart `npm run dev`:

```dotenv
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_FROM=mailbox@localhost
SMTP_SECURITY=plain
```

In app Settings, enable Email and use an address such as `tester@example.com`. Save, then Send test email. View messages at **http://127.0.0.1:8025**. Mailpit captures messages locally; it does not deliver to that address. For a real provider, use its host, port, sender, username and password; use `SMTP_SECURITY=starttls` (usually port 587) or `tls` (usually port 465). Plain SMTP is for the local test inbox.

### Docker

```sh
# Set MAILBOX_PASSWORD in .env first.
docker compose up --build -d mailbox
```

Open **http://127.0.0.1:3000**. Data lives in the `mailbox-data` Docker volume. If using Mailpit from the mailbox container, set `SMTP_HOST=mailpit` in `.env` and start both with `docker compose --profile test-mail up --build -d`. Use `127.0.0.1` for SMTP when running the app directly on your computer.

### Nostr

Settings shows the automatically generated service sender npub. Enable Nostr, set your recipient npub, and save. Messages follow [Anagram’s private DM format](https://git.atitlan.io/aiolabs/anagram/src/branch/main/docs/direct-messages.md): an unsigned kind-14 rumor, NIP-44-encrypted kind-13 seals, and kind-1059 gift wraps. Recipient and sender-history copies contain the same rumor and are separately encrypted. Set App and discovery relays to the relays used in Anagram; these are always included alongside each identity's published kind-10050 inbox relays. Missing inbox metadata does not block delivery. Retries preserve both wrap IDs and track acceptance independently, so an accepted copy is not resent when the other fails. Previously persisted recipient-only wraps keep their IDs. The recipient needs a compatible client and may need to accept the sender's message request. No legacy NIP-04 fallback is used.

### Verification

```sh
npm test
npm run build
npm run check:startos
```

Tests use isolated databases, mocked GitHub responses, Nostr cryptographic round trips, and real local HTTP/SMTP listeners. Subprocess tests also reproduce stalled relay TLS handshakes and connection cleanup, verifying that these failures do not terminate the app. They do not send external messages. Live relay delivery and StartOS lifecycle testing require your configured recipient and StartOS device.

## StartOS 0.4.x package

The `startos/` wrapper is based on the official CLI scaffold and pinned Start SDK. It builds this repository's Dockerfile for ARM64 and x86-64. Install the current `start-cli`, Docker with an OCI-capable Buildx builder, GNU Make, and jq. See the [official setup guide](https://docs.start9.com/packaging/0.4.0.x/environment-setup.html).

```sh
# If needed, create a container-backed builder; this does not replace your default builder.
docker buildx create --name release-mailbox --driver docker-container
BUILDX_BUILDER=release-mailbox npm run package:startos -- arm
BUILDX_BUILDER=release-mailbox npm run package:startos -- x86
```

The helper initializes a packaging workspace under `/tmp/release-mailbox-startos-workspace` and stages only source files. Set `STARTOS_WORKSPACE` to keep it elsewhere. Protect and retain that workspace's `.startos/build.key.pem` if distributing future versions under the same signing identity. Packages are copied into `artifacts/`. Use `universal` instead of `arm` or `x86` for one multi-architecture package. Source metadata points to [blackcoffeexbt/github-watcher](https://github.com/blackcoffeexbt/github-watcher).

Sideload the matching package on a StartOS 0.4.x device. Run **Set service password**, open the Web Interface, and sign in. The same action rotates the password and signs out old sessions after the service applies its updated configuration.

### StartOS SMTP

Use **Actions → Configure SMTP**. The SDK's standard form offers Disabled (default), System (uses StartOS SMTP), or Custom. Then enable Email and configure the recipient in the web app. System SMTP changes and action saves are read reactively by the wrapper; the backend receives resolved credentials through its generated runtime configuration. No SMTP credentials are exposed by the web API.

### Runtime, storage, and backups

- One `mailbox` daemon serves port 3000 and runs the scheduler and notification worker. The web interface's addresses are controlled in StartOS Interfaces.
- The `main` volume mounts at `/data` without an extra ID mapping. A `prepare-data` startup step sets its ownership to application UID/GID 1000 before the mailbox daemon starts. It holds SQLite, read state, subscriptions, sessions, GitHub token, Nostr sender key, and delivery jobs.
- The unmounted `startos` volume contains `store.json` with the service password and SMTP selection. Generated `/app/runtime.json` is ephemeral and recreated from the store and system SMTP configuration.
- Both volumes are backed up with StartOS's stopped-service volume backup. Protect backups because they contain credentials. Restore preserves the Nostr identity and pending jobs.
- `/health` verifies database access. The daemon's StartOS health check probes it. GitHub and notification problems appear in the app without taking the mailbox offline.
- SQLite schema version 1 is created idempotently on startup. Later schema changes must add an explicit migration before increasing the version. `startos/versions/current.ts` contains the package version and release notes.

For manual local backups, stop the service and copy the entire `data/` directory, including SQLite sidecar files. Restore it before starting again. Do not run two service processes against the same database.

### Update schedule

Settings provides Check every (1–24 whole hours), Starting at, Timezone, and the next scheduled check. Defaults are every 3 hours starting at 00:00 in Europe/London. Slots reset at the chosen start time each day: every 5 hours from 02:00 runs at 02:00, 07:00, 12:00, 17:00, and 22:00. Clock times follow the selected timezone; nonexistent daylight-saving times are skipped and repeated times run once. Checks start within the scheduler's 30-second tick.

Manual refresh and initial imports do not move the scheduled slots. Failed repositories retry after their backoff without rechecking successful repositories. After downtime, one catch-up poll covers missed slots. Saving a changed schedule chooses its next future slot, and a poll already in progress finishes normally. On upgrade, existing mailboxes initialize to the next future default slot; subscriptions and notification preferences are preserved.

### Operations and troubleshooting

An optional GitHub token in Settings raises API limits; only public repositories are accepted. Drafts and standalone Git tags are excluded. Deleted upstream releases remain in local history. Unsubscribing removes that repository's local history. Already queued summaries retain their contents and recipient.

Each completed poll queues one email and one Nostr DM for the enabled channels, containing all newly matching releases grouped by repository, newest first within each group. Each channel respects the subscription's release-type and channel preferences. Empty summaries are not sent. Successful repositories are included even if another repository cannot be checked. Detections and summaries commit together; recipients and preferences are captured when the poll starts. Email and DM bodies use “New releases from your watch list” followed by one bullet per release: repository, tag, and publication time in Europe/London, formatted as HH:mm:ss D/M/YYYY. Notes, titles, URLs, and poll timestamps are omitted. Already encrypted Nostr retries retain their original event and contents.

Email and Nostr jobs are independent. Transient failures retry with exponential backoff, eventually becoming Failed; recent jobs show a Retry button. Disabled channels pause pending jobs. Changing recipients affects new jobs; already queued jobs retain their original recipient. Enabling a channel does not replay release history. Accepted means SMTP or at least one inbox relay accepted the message, not that the recipient read it. SMTP retries after ambiguous failures can produce duplicates; stable Message-IDs help recipients deduplicate.

If login fails, check that the password has at least 12 characters. The supplied environment/runtime password is authoritative on startup when it changes. To reset a standalone local password without command-line exposure, supply it over stdin to `npm run password` (for example using your password manager's CLI). Restart with the same environment password or update that value too. Set `COOKIE_SECURE=true` behind an HTTPS-only proxy. Development allows only the two explicit localhost Vite origins; reverse-proxy deployments can set a comma-separated `APP_ORIGINS` list if needed.

Release HTML is not executed; Markdown is rendered safely and remote images are represented as text. Tokens, Nostr secrets, passwords, and provider error bodies are not returned to the browser. Logs omit credentials and release contents.

## HTTP interface

Cookie-authenticated JSON API under `/api`. Mutations require `X-Mailbox-Request: 1` and a valid request origin. Login: `POST /login`; logout: `POST /logout`; mailbox: `GET /mailbox`; category CRUD: `/categories`; subscription CRUD: `/subscriptions`; release history: `GET /releases?subscription=ID&search=TEXT&offset=N`; read state: `PATCH /releases/:id`; bulk read: `POST /read-all`; refresh: `POST /refresh`; settings: `GET/PUT /settings`; notification jobs: `GET /jobs`, `POST /jobs/:id/retry`; tests: `POST /test/email` or `/test/nostr`. `/events` emits `changed` server-sent events. Health is available at `/health` without authentication.
