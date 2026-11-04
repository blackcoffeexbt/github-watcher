import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
// Load local settings without placing secrets in command-line arguments.
try { for (const line of readFileSync('.env', 'utf8').split('\n')) { const match = line.match(/^([A-Z_]+)=(.*)$/); if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch {}
const env = { ...process.env, APP_ORIGINS: process.env.APP_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173' };
const children = [spawn('node', ['--import', 'tsx', '--watch', 'server/index.ts'], { stdio: 'inherit', env }), spawn('node', ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env })];
let closing = false;
function stop(code = 0) { if (closing) return; closing = true; for (const child of children) child.kill('SIGTERM'); setTimeout(() => process.exit(code), 300).unref(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) child.on('exit', code => stop(code || 0));
