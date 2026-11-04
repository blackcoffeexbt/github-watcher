# Updating Release Mailbox

The application and StartOS wrapper are maintained together in this repository. There is no external upstream image to track. The package builds the root Dockerfile for both supported architectures.

Application version: `package.json`. StartOS version and release notes: `startos/versions/current.ts`. SDK pin and dependency versions: `package-lock.json`. The container uses Node 22 Bookworm slim; review and rebuild it for security updates.

After changing dependencies, update the lockfile, run tests, build the browser and server, check the wrapper types, rebuild both packages, and verify install/login, SMTP action changes, polling, restart, and backup/restore on a StartOS 0.4.x device. Add explicit SQLite migrations for schema changes; retain historical StartOS migrations only when they perform work.
