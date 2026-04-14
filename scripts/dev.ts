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
import { join, resolve } from 'path';
import { createLogger } from '../src/logger';

const log = createLogger('dev');

const SRC_DIR = resolve(process.cwd(), 'src');
const SERVER_FILE = resolve(process.cwd(), 'serve.ts');

let child: ChildProcess | null = null;
let restarting = false;
let pendingRestart = false;

/**
 * Start the proxy server as a child process.
 */
function startServer(): void {
  if (child) {
    child.kill('SIGTERM');
    child = null;
  }

  log.log({}, `Starting server (pid: ${process.pid})...`);

  child = spawn('bun', ['run', SERVER_FILE], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });

  child.on('exit', (code) => {
    if (code !== null && code > 0) {
      log.log({ code }, 'Server exited with error');
    }
    child = null;

    // If there's a pending restart, do it now
    if (pendingRestart) {
      pendingRestart = false;
      setTimeout(() => startServer(), 100);
    }
  });

  log.log({}, `Server started (child pid: ${child.pid})`);
}

/**
 * Restart the server with debounce.
 */
function restartServer(): void {
  if (restarting) {
    pendingRestart = true;
    return;
  }

  restarting = true;
  log.log({}, 'File changed — restarting...');

  if (child) {
    child.kill('SIGTERM');
    child = null;
  }

  // Small delay to ensure file is fully written
  setTimeout(() => {
    startServer();
    restarting = false;

    if (pendingRestart) {
      pendingRestart = false;
      restartServer();
    }
  }, 200);
}

/**
 * Watch src/ directory for changes.
 */
function watchForChanges(): void {
  log.log({ path: SRC_DIR }, 'Watching for changes...');

  watch(
    SRC_DIR,
    { recursive: true },
    (eventType, filename) => {
      if (filename && filename.endsWith('.ts')) {
        log.log({ file: filename }, `${eventType}: ${filename}`);
        restartServer();
      }
    },
  );
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
