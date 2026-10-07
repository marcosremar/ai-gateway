#!/usr/bin/env bun
/**
 * Development server with hot-reload.
 *
 * Watches src/ for changes and restarts the proxy server automatically.
 * Uses Bun's native file watching for fast restarts (<1s).
 *
 * Usage:
 *   bun run dev
 *   bun run scripts/dev.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import { watch } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../src/logger';

const log = createLogger('dev');

// The live gateway entry point (the legacy server/ws-server.ts was removed with the rest of the old server).
const SERVER_FILE = resolve(process.cwd(), 'serve.ts');
const WATCH_DIRS = [
  resolve(process.cwd(), 'src'),
  resolve(process.cwd(), 'server'),
];

let child: ChildProcess | null = null;
// debounce timer — coalesces rapid saves into one restart
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// true while we're killing + waiting for exit
let killing = false;

/**
 * Spawn the server. Must only be called when child is null.
 */
function startServer(): void {
  log.log({}, `Starting server...`);

  child = spawn('bun', [SERVER_FILE], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });

  log.log({}, `Server pid=${child.pid}`);

  child.on('exit', (code) => {
    child = null;
    killing = false;
    if (code !== null && code > 0 && code !== 143) {
      log.log({ code }, 'Server exited with error — waiting for next save to restart');
    }
  });
}

/**
 * Kill current child (if any) then start fresh.
 * Waits for the exit event so ports are fully released before rebinding.
 */
function restartServer(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (killing) return; // already mid-kill, exit handler will start fresh

  if (child) {
    killing = true;
    log.log({}, 'File changed — restarting...');
    // Start new server only after old one fully exits (port released)
    child.once('exit', () => {
      child = null;
      killing = false;
      startServer();
    });
    child.kill('SIGTERM');
  } else {
    startServer();
  }
}

/**
 * Debounced file-change handler (50 ms window coalesces burst saves).
 */
function onFileChange(filename: string | null): void {
  if (!filename?.endsWith('.ts')) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    log.log({ file: filename }, `changed`);
    restartServer();
  }, 50);
}

/**
 * Watch server/ and src/ for TypeScript changes.
 */
function watchForChanges(): void {
  for (const dir of WATCH_DIRS) {
    log.log({ path: dir }, 'Watching...');
    watch(dir, { recursive: true }, (_eventType, filename) => onFileChange(filename));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

log.log({}, '🚀 AI Gateway Dev Server');
log.log({}, '═══════════════════════════════════════');
log.log({}, '  Hot-reload enabled');
log.log({}, '  Press Ctrl+C to stop');
log.log({}, '═══════════════════════════════════════');

startServer();
watchForChanges();

// Handle Ctrl+C
process.on('SIGINT', () => {
  log.log({}, '\nStopping dev server...');
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.log({}, '\nStopping dev server...');
  if (child) child.kill('SIGTERM');
  process.exit(0);
});
