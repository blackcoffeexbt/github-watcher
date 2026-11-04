import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = resolve(process.env.STARTOS_WORKSPACE || '/tmp/release-mailbox-startos-workspace');
const target = process.argv[2] || 'universal';
if (!['arm', 'x86', 'all', 'universal'].includes(target)) throw new Error('Choose arm, x86, all, or universal.');
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env }); if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status || 1); }
if (!existsSync(join(workspace, '.startos'))) run('start-cli', ['s9pk', 'init-workspace', workspace], root);
const destination = join(workspace, 'release-mailbox-startos');
if (!existsSync(destination)) run('start-cli', ['s9pk', 'init-package', 'Release Mailbox'], workspace);
// Explicit allowlist: never copy runtime data, .env, sessions, or signing keys.
for (const file of ['src', 'server', 'public', 'scripts', 'tests', 'startos', 'Dockerfile', '.dockerignore', '.npmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.startos.json', 'vite.config.ts', 'index.html', 'icon.svg', 'LICENSE', 'Makefile', 'README.md', 'instructions.md', 'UPDATING.md']) cpSync(join(root, file), join(destination, file), { recursive: true });
// Use this checkout's verified dependencies; Docker installs its own Linux dependencies.
run('npm', ['ci', '--legacy-peer-deps'], destination);
run('make', [target], destination);
mkdirSync(join(root, 'artifacts'), { recursive: true });
for (const file of readdirSync(destination).filter(name => name.endsWith('.s9pk'))) cpSync(join(destination, file), join(root, 'artifacts', file));
console.log('StartOS packages are in artifacts/.');
