#!/usr/bin/env bun
/**
 * ai-gateway CLI — command-line interface for the Parle AI Gateway.
 *
 * Install: bun link (from repo root) → creates global `ai-gateway` command
 * Or: chmod +x bin/ai-gateway.ts && ln -s $(pwd)/bin/ai-gateway.ts /usr/local/bin/ai-gateway
 *
 * Usage:
 *   ai-gateway health
 *   ai-gateway chat "What is 2+2?"
 *   ai-gateway transcribe audio.wav
 *   ai-gateway tts "Hello world" -o output.wav
 *   ai-gateway gpu status
 *   ai-gateway gpu deploy
 *   ai-gateway models
 *   ai-gateway metrics
 */

import { readFileSync, writeFileSync, existsSync, createWriteStream, createReadStream, mkdirSync, statSync, readdirSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';

// ── Colors (minimal, no deps) ────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

const VERSION = '0.1.0';

// ── Config ────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'http://localhost:4000';

/**
 * Load `.env` from the current working directory (and walk up to git root) so
 * an app's per-project `AIGW_APP_KEY` is picked up automatically without the
 * operator having to source it manually. Idempotent — safe to call repeatedly.
 *
 * Only sets vars NOT already in the parent env so an explicit
 * `AIGW_APP_KEY=... ai-gateway gpu list` always wins.
 */
let _envLoaded = false;
function loadCwdEnv(): void {
  if (_envLoaded) return;
  _envLoaded = true;
  try {
    const fs = require('fs');
    const path = require('path');
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth++) {
      const envPath = path.join(dir, '.env');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8') as string;
        for (const line of content.split('\n')) {
          const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
          if (!m) continue;
          const k = m[1];
          let v = m[2];
          // Strip surrounding quotes; Bun's auto-loader does the same.
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (process.env[k] === undefined) process.env[k] = v;
        }
        return;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  } catch {
    // Best effort — never let env loading crash the CLI.
  }
}

function getConfig(): { url: string; key: string } {
  loadCwdEnv();
  const url = process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || DEFAULT_URL;
  // AIGW_APP_KEY is the per-app credential (preferred); the older names
  // remain accepted for back-compat with shared "operator" keys.
  // GATEWAY_API_KEYS is the multi-key format "key:name,key:name" — extract the first key.
  const multiKeys = process.env.GATEWAY_API_KEYS;
  const firstMultiKey = multiKeys ? multiKeys.split(',')[0]?.split(':')[0]?.trim() : '';
  const key = process.env.AIGW_APP_KEY
    || process.env.AI_GATEWAY_KEY
    || process.env.GATEWAY_API_KEY
    || firstMultiKey
    || '';
  return { url, key };
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch { return false; }
}

/**
 * Auto-start the local dev server if:
 *   1. URL points to localhost (never auto-start for remote/production)
 *   2. Server is not already running (health check fails)
 *   3. serve.ts exists in the repo
 *
 * The server runs in the background as a detached process. Its PID is
 * written to ~/.babelcast/gateway-cli.pid so we can track it.
 * The process is NOT killed when the CLI exits — it stays running for
 * subsequent CLI commands. Use `ai-gateway server stop` to kill it.
 */
async function ensureLocalServer(): Promise<void> {
  const { url } = getConfig();
  if (!isLocalUrl(url)) return; // production URL — never auto-start

  // Check if already running
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return; // already running
  } catch {
    // Not running — start it
  }

  // Find server entry point — prefer ws-server.ts (full GPU management) over serve.ts (proxy only)
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const wsServerPath = resolve(repoRoot, 'server/ws-server.ts');
  const servePath = resolve(repoRoot, 'serve.ts');
  const entryPath = existsSync(wsServerPath) ? wsServerPath : servePath;
  if (!existsSync(entryPath)) {
    console.error(`Cannot auto-start: neither server/ws-server.ts nor serve.ts found`);
    console.error('Start the server manually: bun run server/ws-server.ts');
    process.exit(1);
  }

  const port = new URL(url).port || '4000';
  console.log(`Starting local gateway on port ${port}...`);

  const child: ChildProcess = spawn('bun', ['run', entryPath], {
    env: { ...process.env, PORT: port },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  // Write PID for tracking
  const pidDir = resolve(process.env.HOME || '/tmp', '.babelcast');
  try {
    if (!existsSync(pidDir)) require('fs').mkdirSync(pidDir, { recursive: true });
    writeFileSync(resolve(pidDir, 'gateway-cli.pid'), String(child.pid));
  } catch { /* best effort */ }

  // Wait for server to be ready (up to 10s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log(`Gateway started (pid ${child.pid})\n`);
        return;
      }
    } catch { /* not ready yet */ }
  }
  console.error('Gateway failed to start within 10 seconds.');
  console.error('Check logs or start manually: bun run serve.ts');
  // Non-fatal: commands that don't need HTTP gateway (gpu finetune, gpu jobs) continue.
}

async function cmdServerStop() {
  const pidPath = resolve(process.env.HOME || '/tmp', '.babelcast', 'gateway-cli.pid');
  if (!existsSync(pidPath)) {
    console.log('No auto-started server found (no PID file).');
    return;
  }
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.log('PID file is malformed; removing.');
    try { require('fs').unlinkSync(pidPath); } catch { /* no-op */ }
    return;
  }
  // Verify the PID actually owns the gateway port. After process exit the OS
  // recycles PIDs; without this check `cmdServerStop` could SIGTERM an
  // unrelated process that happens to occupy the same PID slot. We probe
  // /health (cheap, gateway-specific) before signalling.
  try {
    const { url } = getConfig();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${url}/health`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    if (!res || !res.ok) {
      console.log(`Gateway (pid ${pid}) does not respond on ${url}/health — refusing to SIGTERM unverified PID. Removing stale PID file.`);
      try { require('fs').unlinkSync(pidPath); } catch { /* no-op */ }
      return;
    }
  } catch { /* fall through to SIGTERM with caution */ }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to gateway (pid ${pid}).`);
    require('fs').unlinkSync(pidPath);
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      console.log(`Gateway (pid ${pid}) is not running.`);
      require('fs').unlinkSync(pidPath);
    } else {
      console.error(`Failed to stop: ${err.message}`);
    }
  }
}

async function cmdServerStatus() {
  const { url } = getConfig();
  const pidPath = resolve(process.env.HOME || '/tmp', '.babelcast', 'gateway-cli.pid');
  const hasPid = existsSync(pidPath);
  const pid = hasPid ? parseInt(readFileSync(pidPath, 'utf8').trim(), 10) : null;
  let running = false;
  if (pid) {
    try { process.kill(pid, 0); running = true; } catch { /* not running */ }
  }
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`Server:    running at ${url}`);
      if (pid && running) console.log(`PID:       ${pid} (auto-started)`);
      console.log(`Status:    ${data.status}`);
      if (data.connections) console.log(`Conns:     active=${data.connections.active}, peak=${data.connections.peak}`);
      return;
    }
  } catch { /* not reachable */ }
  console.log(`Server:    not running at ${url}`);
  if (pid && !running) console.log(`PID:       ${pid} (stale — process exited)`);
  if (isLocalUrl(url)) console.log('Tip:       run any command and the server will auto-start');
}

function headers(key: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) h['Authorization'] = `Bearer ${key}`;
  return h;
}

async function fetchJSON(url: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    try {
      const err = JSON.parse(text);
      console.error(`Error ${res.status}: ${err.error?.message || text.slice(0, 200)}`);
    } catch {
      console.error(`Error ${res.status}: ${text.slice(0, 200)}`);
    }
    process.exit(1);
  }
  try { return JSON.parse(text); }
  catch { return text; }
}

// ── Commands ──────────────────────────────────────────────────────────────

/** Read stdin if piped (for: echo "hello" | ai-gateway chat) */
async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text || null;
}

/** Format duration nicely */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Spinner for long operations */
function spinner(text: string): { stop: (msg?: string) => void } {
  if (!isTTY) return { stop: () => {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r${c.cyan}${frames[i++ % frames.length]}${c.reset} ${text}`);
  }, 80);
  return {
    stop: (msg?: string) => {
      clearInterval(interval);
      process.stderr.write(`\r${' '.repeat(text.length + 4)}\r`);
      if (msg) process.stderr.write(`${msg}\n`);
    },
  };
}

async function cmdVersion() {
  console.log(`ai-gateway CLI v${VERSION}`);
  const { url } = getConfig();
  console.log(`Gateway: ${url}`);
}

async function cmdHealth() {
  const { url, key } = getConfig();
  const data = await fetchJSON(`${url}/health`);
  console.log(`${c.green}●${c.reset} Status: ${c.bold}${data.status}${c.reset}`);
  if (data.connections) {
    console.log(`  Connections: active=${data.connections.active}, peak=${data.connections.peak}`);
  }
}

async function cmdModels() {
  const { url, key } = getConfig();
  const data = await fetchJSON(`${url}/v1/models`, { headers: headers(key) });
  console.log(`${data.data.length} models:\n`);
  for (const m of data.data) {
    console.log(`  ${m.id}`);
  }
}

async function cmdDetectLanguage(text: string) {
  const { url, key } = getConfig();
  // Use LLM to detect language — lightweight approach without a dedicated endpoint
  const body = {
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'Detect the language of the following text. Reply with ONLY the ISO 639-1 code (e.g. en, fr, pt, es, de, ja, zh). Nothing else.' },
      { role: 'user', content: text },
    ],
    max_tokens: 5,
    temperature: 0,
  };
  const data = await fetchJSON(`${url}/v1/chat/completions`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  const lang = data.choices[0].message.content.trim().toLowerCase().slice(0, 5);
  console.log(lang);
}

async function cmdLogs(opts: { limit?: number; format?: string }) {
  const { url, key } = getConfig();
  const limit = opts.limit || 20;
  const res = await fetch(`${url}/v1/requests/log?limit=${limit}`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('Request log not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const entries = data.entries || [];
  if (entries.length === 0) { console.log('No requests logged.'); return; }
  console.log(`Last ${entries.length} requests:\n`);
  console.log(`  ${'Time'.padEnd(12)} ${'Stage'.padEnd(6)} ${'Provider'.padEnd(10)} ${'Model'.padEnd(20)} ${'Ms'.padStart(6)} ${'OK'.padStart(4)}`);
  console.log(`  ${'─'.repeat(12)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(20)} ${'─'.repeat(6)} ${'─'.repeat(4)}`);
  for (const e of entries) {
    const time = new Date(e.timestamp).toISOString().slice(11, 23);
    const stage = (e.stage || '?').slice(0, 6);
    const prov = (e.provider || '?').slice(0, 10);
    const model = (e.model || '?').slice(0, 20);
    const ms = e.latencyMs != null ? String(e.latencyMs) : '?';
    const ok = e.success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${time.padEnd(12)} ${stage.padEnd(6)} ${prov.padEnd(10)} ${model.padEnd(20)} ${ms.padStart(6)} ${ok.padStart(4)}`);
  }
  if (data.stats) {
    console.log(`\n  Total: ${data.stats.totalRequests} requests, avg ${data.stats.avgLatencyMs}ms`);
  }
}

async function cmdApps(sub?: string) {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/config/providers`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('Config endpoint not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  const apps = data.apps || data.profiles || [];
  const active = data.activeAppId || data.activeProfileId;

  console.log(`${apps.length} apps:\n`);
  for (const a of apps) {
    const isActive = a.id === active;
    const marker = isActive ? `${c.green}● active${c.reset}` : `${c.dim}○${c.reset}`;
    const name = isActive ? `${c.bold}${a.name}${c.reset}` : a.name;
    console.log(`  ${marker}  ${name} ${c.dim}(${a.id})${c.reset}`);
    if (a.latencyTargetsMs) {
      const t = a.latencyTargetsMs;
      console.log(`         ${c.dim}targets: STT=${t.stt || '-'}ms LLM=${t.llm || '-'}ms TTS=${t.tts || '-'}ms${c.reset}`);
    }
    if (a.gpuDeploy) {
      console.log(`         ${c.dim}image: ${a.gpuDeploy.dockerImage || '-'}${c.reset}`);
    }
  }
}

async function cmdBalance() {
  const { url, key } = getConfig();
  const s = spinner('Checking balances...');
  const res = await fetch(`${url}/health`, { headers: headers(key), signal: AbortSignal.timeout(10000) });
  s.stop();
  if (!res.ok) { console.error('Gateway unreachable'); process.exit(1); }
  const data = await res.json();
  const balances = data.providerBalances || [];
  if (balances.length === 0) {
    console.log('No provider balances available (proxy-only mode or no keys configured).');
    return;
  }
  console.log(`${c.bold}Provider Balances${c.reset}\n`);
  for (const b of balances) {
    const name = (b.provider || b.name || '?').padEnd(14);
    const bal = b.balance != null ? `$${Number(b.balance).toFixed(2)}` : 'N/A';
    const icon = b.low ? `${c.red}▲${c.reset}` : b.balance != null ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
    const warn = b.low ? ` ${c.red}LOW${c.reset}` : '';
    console.log(`  ${icon} ${name} ${bal}${warn}`);
  }
  // Budget
  if (data.budget) {
    const b = data.budget;
    const limit = b.dailyLimitUsd != null ? ` / $${b.dailyLimitUsd}` : '';
    const warn = b.exceeded ? ` ${c.red}EXCEEDED${c.reset}` : '';
    console.log(`\n${c.bold}Daily GPU Spend${c.reset}  $${b.dailySpendUsd}${limit}${warn}`);
  }
}

async function cmdChat(message: string, opts: { model?: string; stream?: boolean; maxTokens?: number; imagePaths?: string[] }) {
  const { url, key } = getConfig();
  const model = opts.model || '@app/llm';
  const content = opts.imagePaths?.length
    ? [
        { type: 'text', text: message },
        ...opts.imagePaths.map((path) => ({
          type: 'image_url',
          image_url: { url: imageDataUrl(path) },
        })),
      ]
    : message;
  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: opts.maxTokens || 1024,
    stream: opts.stream ?? true,
  };

  if (body.stream) {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Error ${res.status}: ${err.slice(0, 200)}`);
      process.exit(1);
    }

    // Detect whether the server returned SSE or a single JSON body.
    // Some gateway endpoints ignore `stream:true` and return the full response.
    const contentType = res.headers.get('content-type') || '';
    const isSSE = contentType.includes('text/event-stream');

    if (!isSSE) {
      // Server returned a non-streamed JSON response despite stream:true
      const data = await res.json();
      console.log(data.choices?.[0]?.message?.content ?? '');
      if (data.usage) {
        console.log(`\n[tokens: ${data.usage.prompt_tokens}+${data.usage.completion_tokens}=${data.usage.total_tokens}]`);
      }
      return;
    }

    // Stream SSE chunks
    const reader = res.body?.getReader();
    if (!reader) { console.error('No response body'); process.exit(1); }
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') { process.stdout.write('\n'); continue; }
        try {
          const chunk = JSON.parse(data);
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) process.stdout.write(content);
          if (chunk.usage) {
            process.stdout.write(`\n\n[tokens: ${chunk.usage.prompt_tokens}+${chunk.usage.completion_tokens}=${chunk.usage.total_tokens}]`);
          }
        } catch { /* skip malformed */ }
      }
    }
    console.log();
  } else {
    const data = await fetchJSON(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
    });
    console.log(data.choices[0].message.content);
    if (data.usage) {
      console.log(`\n[tokens: ${data.usage.prompt_tokens}+${data.usage.completion_tokens}=${data.usage.total_tokens}]`);
    }
  }
}

function imageDataUrl(path: string): string {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    console.error(`Image file not found: ${absPath}`);
    process.exit(1);
  }
  const bytes = readFileSync(absPath);
  const maxImageBytes = 20 * 1024 * 1024;
  if (bytes.length > maxImageBytes) {
    console.error(`Image file too large: ${absPath} (${(bytes.length / 1024 / 1024).toFixed(1)}MB, max 20MB)`);
    process.exit(1);
  }
  return `data:${imageMimeType(absPath)};base64,${bytes.toString('base64')}`;
}

function imageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  console.error(`Unsupported image type: ${path}. Use PNG, JPG, JPEG, or WEBP.`);
  process.exit(1);
}

async function cmdTranscribe(filePath: string, opts: { model?: string; language?: string; prompt?: string }) {
  const { url, key } = getConfig();
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }
  const audioData = readFileSync(absPath);
  const form = new FormData();
  form.append('file', new Blob([audioData]), filePath);
  form.append('model', opts.model || 'whisper-large-v3-turbo');
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt);

  const h: Record<string, string> = {};
  if (getConfig().key) h['Authorization'] = `Bearer ${getConfig().key}`;

  const res = await fetch(`${url}/v1/audio/transcriptions`, {
    method: 'POST', headers: h, body: form,
  });
  const text = await res.text();
  if (!res.ok) { console.error(`Error ${res.status}: ${text.slice(0, 200)}`); process.exit(1); }
  const data = JSON.parse(text);
  console.log(data.text);
}

async function cmdSpeech(filePath: string, opts: { source?: string; target?: string; speaker?: string; prompt?: string; refText?: string; referenceAudio?: string; output?: string; json?: boolean }) {
  const { url, key } = getConfig();
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }
  const audioData = readFileSync(absPath);
  const params = new URLSearchParams();
  if (opts.source) params.set('source', opts.source);
  if (opts.target) params.set('target', opts.target);
  if (opts.speaker) params.set('speaker', opts.speaker);
  if (opts.prompt) params.set('prompt', opts.prompt);
  if (opts.refText) params.set('ref_text', opts.refText);
  const h: Record<string, string> = { 'Content-Type': 'audio/wav' };
  if (key) h['Authorization'] = `Bearer ${key}`;
  if (opts.referenceAudio) h['X-Reference-Audio'] = Buffer.from(readFileSync(resolve(opts.referenceAudio))).toString('base64');

  const endpoint = `${url}/v1/speech${params.toString() ? `?${params}` : ''}`;
  const res = await fetch(endpoint, { method: 'POST', headers: h, body: audioData });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    const err = await res.text();
    console.error(`Error ${res.status}: ${err.slice(0, 300)}`);
    process.exit(1);
  }
  if (contentType.includes('audio/')) {
    const outPath = opts.output || 'speech-output.wav';
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, audioBuffer);
    console.log(`${c.green}✓${c.reset} Audio saved to ${c.bold}${outPath}${c.reset} (${(audioBuffer.length / 1024).toFixed(0)} KB)`);
    return;
  }
  const data = await res.json();
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.transcription) console.log(`transcription: ${data.transcription}`);
  if (data.response) console.log(`response: ${data.response}`);
  if (data.audio_base64 && opts.output) {
    const audioBuffer = Buffer.from(data.audio_base64, 'base64');
    writeFileSync(opts.output, audioBuffer);
    console.log(`${c.green}✓${c.reset} Audio saved to ${c.bold}${opts.output}${c.reset} (${(audioBuffer.length / 1024).toFixed(0)} KB)`);
  }
}

async function cmdMediaTest(opts: { image?: string; audio?: string; model?: string }) {
  let ok = true;
  if (opts.image) {
    try {
      await cmdChat('What is shown? Answer in 5 words max.', {
        model: opts.model || 'openrouter/google/gemini-2.5-flash',
        stream: false,
        maxTokens: 30,
        imagePaths: [opts.image],
      });
      console.log(`${c.green}✓${c.reset} image+text OK`);
    } catch (err) {
      ok = false;
      console.error(`${c.red}✗${c.reset} image+text failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (opts.audio) {
    try {
      await cmdTranscribe(opts.audio, { language: 'en', prompt: 'Short media smoke test.' });
      console.log(`${c.green}✓${c.reset} audio transcription OK`);
    } catch (err) {
      ok = false;
      console.error(`${c.red}✗${c.reset} audio transcription failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!opts.image && !opts.audio) {
    console.error('Usage: ai-gateway media test --image <path> --audio <path>');
    process.exit(1);
  }
  if (!ok) process.exit(1);
}

async function cmdTTS(text: string, opts: { model?: string; voice?: string; output?: string }) {
  const { url, key } = getConfig();
  const body = {
    model: opts.model || 'canopylabs/orpheus-v1-english',
    input: text,
    voice: opts.voice || 'autumn',
  };
  const s = spinner('Generating audio...');
  const res = await fetch(`${url}/v1/audio/speech`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  s.stop();
  if (!res.ok) {
    const err = await res.text();
    console.error(`${c.red}Error ${res.status}${c.reset}: ${err.slice(0, 200)}`);
    process.exit(1);
  }
  const audioBuffer = Buffer.from(await res.arrayBuffer());
  const outPath = opts.output || 'output.wav';
  writeFileSync(outPath, audioBuffer);
  console.log(`${c.green}✓${c.reset} Audio saved to ${c.bold}${outPath}${c.reset} (${(audioBuffer.length / 1024).toFixed(0)} KB)`);
}

async function cmdGpuStatus() {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/gpu/status`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('GPU endpoints not available on this gateway (proxy-only mode).');
    console.log('GPU management requires the full server (server/ws-server.ts).');
    return;
  }
  const data = await res.json();
  if (data.error) { console.error(data.error.message); process.exit(1); }
  console.log('GPU Status:');
  console.log(`  status:    ${data.status}`);
  if (data.devMode) console.log(`  mode:      ${c.cyan}dev${c.reset} (auto-destroy disabled)`);
  if (data.deployId) console.log(`  deployId:  ${data.deployId}`);
  if (data.podId) console.log(`  podId:     ${data.podId}`);
  if (data.endpoint) console.log(`  endpoint:  ${data.endpoint}`);
  if (data.gpuType) console.log(`  gpuType:   ${data.gpuType}`);
  if (data.provider) console.log(`  provider:  ${data.provider}`);
  if (data.costPerHr) console.log(`  cost/hr:   $${data.costPerHr.toFixed(2)}`);
  if (data.gpuHealthy !== undefined) console.log(`  healthy:   ${data.gpuHealthy}`);
}

/**
 * Owner identity for label-based ownership guard. Auto-prefixes deploy labels
 * and authorizes terminates. Override with AIGW_OWNER if running under a
 * shared automation account (autopilot, CI). Format kept short so it doesn't
 * dominate `gpu list` output.
 */
function currentOwner(): string {
  // Order of precedence — must align with the server's resolved userId
  // (set in GATEWAY_API_KEYS as "key:userId") so the CLI auto-prefix and
  // the server-side per-app filter agree on the owner namespace:
  //   1. Explicit AIGW_OWNER (escape hatch for testing)
  //   2. AIGW_APP_NAME from cwd .env (= the userId registered in GATEWAY_API_KEYS)
  //   3. $USER (legacy fallback for unauthenticated/loopback dev)
  loadCwdEnv();
  if (process.env.AIGW_OWNER) return process.env.AIGW_OWNER;
  if (process.env.AIGW_APP_NAME) return process.env.AIGW_APP_NAME;
  return process.env.USER || process.env.LOGNAME || 'unknown';
}

/** `ai-gateway app <subcmd>` dispatcher — per-app API key management. */
async function cmdAppDispatch(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case 'init': {
      const name = args[0];
      if (!name || name.startsWith('-')) {
        console.error('Usage: ai-gateway app init <app-name>');
        console.error('       app-name must match [a-zA-Z0-9_-]+ and is what the gateway will return as your userId.');
        process.exit(1);
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        console.error(`Invalid app-name "${name}" — must match [a-zA-Z0-9_-]+`);
        process.exit(1);
      }
      const fs = require('fs');
      const path = require('path');
      const crypto = require('crypto');
      // Embed the app name in the key itself so a leaked Bearer is
      // self-identifying (operator can grep logs/.env files by appName
      // without needing the registry mapping). Format: aigw_<name>_<rand>.
      const key = `aigw_${name}_${crypto.randomBytes(24).toString('base64url')}`;
      const envPath = path.join(process.cwd(), '.env');
      let existing = '';
      try { existing = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
      // Replace any existing AIGW_APP_KEY line so re-running init upgrades cleanly.
      const stripped = existing
        .split('\n')
        .filter((l: string) => !l.match(/^\s*AIGW_APP_KEY\s*=/) && !l.match(/^\s*AIGW_APP_NAME\s*=/))
        .join('\n');
      const updated = (stripped && !stripped.endsWith('\n') ? stripped + '\n' : stripped)
        + `AIGW_APP_NAME=${name}\nAIGW_APP_KEY=${key}\n`;
      fs.writeFileSync(envPath, updated, { mode: 0o600 });
      console.log(`Wrote ${envPath} (mode 0600) with AIGW_APP_NAME=${name} and a new AIGW_APP_KEY.`);
      console.log('');
      console.log('Next: register this key with the gateway by appending to its .env');
      console.log(`(${'~/projects/ai-gateway/.env'} or wherever GATEWAY_API_KEYS is set):`);
      console.log('');
      console.log(`    GATEWAY_API_KEYS="$GATEWAY_API_KEYS,${key}:${name}"`);
      console.log('');
      console.log('then restart the ws-server (scripts/start-ws-server.sh --detach).');
      console.log(`Verify with: ai-gateway app whoami`);
      return;
    }
    case 'whoami': {
      const { url, key } = getConfig();
      if (!key) { console.log('Not authenticated (no AIGW_APP_KEY in env)'); process.exit(2); }
      try {
        const res = await fetch(`${url}/v1/gpu/list`, { headers: headers(key) });
        if (res.status === 401) {
          console.error(`Unauthenticated: gateway rejected the key. Is it registered in GATEWAY_API_KEYS?`);
          process.exit(2);
        }
        const data = await res.json() as { scopedTo?: string; totalAcrossApps?: number; instances?: unknown[] };
        if (data.scopedTo) {
          console.log(`Authenticated as: ${data.scopedTo}`);
          console.log(`Visible instances: ${data.instances?.length ?? 0} (of ${data.totalAcrossApps ?? '?'} total across all apps)`);
        } else {
          console.log('Authenticated as: admin (no per-app scope)');
          console.log(`Visible instances: ${data.instances?.length ?? 0}`);
        }
      } catch (e) {
        console.error(`whoami failed: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
      return;
    }
    case 'key': {
      loadCwdEnv();
      const k = process.env.AIGW_APP_KEY || process.env.AI_GATEWAY_KEY || process.env.GATEWAY_API_KEY || '';
      if (!k) { console.log('(no key configured)'); return; }
      const reveal = args.includes('--reveal');
      console.log(reveal ? k : `${k.slice(0, 8)}…${k.slice(-4)}`);
      return;
    }
    default:
      console.error(`Unknown app subcommand: ${sub}. Try: app help`);
      process.exit(1);
  }
}

async function cmdGpuDeploy(opts: {
  image?: string; gpuTypes?: string; onstart?: string; storageGb?: number;
  env?: string; numGpus?: number; devMode?: boolean; readinessProbe?: string;
  label?: string; strictFastBoot?: boolean; searchMode?: string; allowUnverified?: boolean;
  provider?: string;
}) {
  const { url, key } = getConfig();
  const body: Record<string, unknown> = {};
  if (opts.image) body.dockerImage = opts.image;
  if (opts.gpuTypes) body.gpuTypes = opts.gpuTypes.split(',');
  if (opts.onstart) body.onstart = opts.onstart;
  if (opts.storageGb) body.storageGb = opts.storageGb;
  if (opts.numGpus) body.gpuCount = opts.numGpus;
  if (opts.devMode) body.devMode = true;
  if (opts.readinessProbe === 'ssh' || opts.readinessProbe === 'health') body.readinessProbe = opts.readinessProbe;
  if (opts.provider) body.provider = opts.provider;
  // --label and --strict-fast-boot threading. Label is required by the
  // server unless AIGW_LABEL_OPTIONAL=1 — surface a friendlier CLI error
  // before the HTTP round-trip so the user sees it immediately.
  // Auto-prefix labels with the current owner ("$USER/...") when missing
  // a slash, so `gpu list` and the terminate guard can identify owner
  // without operators having to remember the convention. Bypass with a
  // label that already contains a slash (treated as opt-in explicit owner).
  if (opts.label !== undefined) {
    const owner = currentOwner();
    body.label = opts.label.includes('/') ? opts.label : `${owner}/${opts.label}`;
  }
  if (opts.strictFastBoot === false) body.strictFastBoot = false;
  if (opts.searchMode !== undefined) {
    const mode = opts.searchMode.trim().toLowerCase();
    if (mode !== 'high_quality' && mode !== 'full') {
      console.error('Error: --search-mode must be one of: high_quality, full');
      process.exit(2);
    }
    body.searchMode = mode;
  }
  if (opts.allowUnverified === true) body.allowUnverified = true;
  if (!opts.label && !process.env.AIGW_LABEL_OPTIONAL) {
    console.error('Error: --label is required. Pass --label "<task-name>" describing what this GPU is for.');
    console.error('       Bypass with AIGW_LABEL_OPTIONAL=1 (legacy/CI only — discouraged).');
    process.exit(2);
  }
  if (opts.env) {
    const envMap: Record<string, string> = {};
    for (const pair of opts.env.split(',')) {
      const [k, ...v] = pair.split('=');
      if (k) envMap[k.trim()] = v.join('=').trim();
    }
    body.env = envMap;
  }
  const data = await fetchJSON(`${url}/v1/gpu/deploy`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  console.log('Deploy started:');
  if (data.deployId) console.log(`  deployId: ${data.deployId}`);
  console.log(JSON.stringify(data, null, 2));

  // Poll /v1/gpu/status every 3s and show progress until ready, error, or timeout (~10 min)
  console.log('\nMonitoring progress...\n');
  let lastPhase = '';
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const status = await fetchJSON(`${url}/v1/gpu/status`, { headers: headers(key) });
      const phase = status.step || status.status || '?';
      const msg = status.message || '';
      const gpu = status.gpuType || '';
      const line = `  ${phase} ${gpu} ${msg}`.padEnd(80);
      // Print a new line when phase changes, otherwise overwrite
      if (phase !== lastPhase) {
        if (lastPhase) process.stderr.write('\n');
        process.stderr.write(line);
        lastPhase = phase;
      } else {
        process.stderr.write(`\r${line}`);
      }
      if (status.status === 'ready') {
        console.log('\n\nGPU ready: ' + (status.endpoint || '(no endpoint)'));
        break;
      }
      if (status.status === 'error') {
        console.log('\n\nDeploy error: ' + (status.message || 'unknown'));
        break;
      }
      if (status.status === 'idle' && i > 2) {
        console.log('\n\nDeploy stopped.');
        break;
      }
    } catch {
      // Server unreachable or non-JSON response — stop polling
      console.log('\n\nLost connection to server.');
      break;
    }
  }
}

async function cmdGpuStop(opts?: { deployId?: string }) {
  const { url, key } = getConfig();
  const body: Record<string, unknown> = {};
  if (opts?.deployId) body.deployId = opts.deployId;
  await fetchJSON(`${url}/v1/gpu/stop`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
  console.log('GPU stopped.');
}

async function cmdGpuLogs() {
  const { url, key } = getConfig();
  const data = await fetchJSON(`${url}/v1/gpu/logs`, { headers: headers(key) });
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

// Probe utilities live in src/gateway/providers/gpu/livenessProbe.ts so
// they can be unit-tested without spinning up the whole CLI. Re-imported
// here so call-sites below stay unchanged.
import {
  tcpProbe,
  pickProbeTarget,
} from '../src/modules/gateway/providers/gpu/livenessProbe';

// Finetune module — GPU finetune orchestration with DI + SOLID principles.
import {
  validateSpec,
  estimateCost,
  FinetuneGateway,
  FileFinetuneState,
  EnvHfTokenResolver,
  buildProbeCommand,
  parseProbeOutput,
  buildStatusResult,
  loadPreset,
  listPresets,
  runNumericChecks,
  runCompare,
  preflightChecks,
  BUNDLED_PLUGINS,
} from '../src/modules/gpu-finetune';
import type { PreflightResult } from '../src/modules/gpu-finetune';
import type {
  GpuJobRunner,
  FinetuneProbe,
  FinetuneOpts,
} from '../src/modules/gpu-finetune';
import {
  isEvictionError,
  attemptSpendUsd,
  addAttempt,
  emptyBudget,
  decideRetry,
  deriveJobId,
  type JobBudget,
} from '../src/modules/gpu-finetune/spot-resume';

async function cmdGpuList(opts: { probe?: boolean; json?: boolean; mine?: boolean; label?: string } = {}) {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/gpu/list`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('GPU endpoints not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  let instances: Record<string, unknown>[] = Array.isArray(data) ? data : (data.instances || []);

  // --mine / --label filter happens client-side because the server's
  // /v1/gpu/list doesn't yet accept query params. When the filter
  // matches zero instances we still print the count so the operator
  // knows the filter was applied (vs an actually-empty pool).
  const totalBeforeFilter = instances.length;
  // The server projects the provider's instance label as `instanceName`
  // (vast.ai's `inst.label` field). Treat that as the source of truth
  // for ownership; fall back to a separate `label` field if the server
  // ever exposes one for the deployState branch.
  const labelOf = (inst: Record<string, unknown>): string => {
    const lbl = (inst as { label?: string; instanceName?: string }).label
      ?? (inst as { instanceName?: string }).instanceName
      ?? '';
    // Skip placeholder labels that just echo the instanceId — they
    // carry no ownership signal and would falsely match nothing.
    if (lbl === inst.instanceId || lbl === inst.podId) return '';
    return lbl;
  };
  if (opts.mine || opts.label) {
    const owner = currentOwner();
    const wantLabel = opts.label;
    instances = instances.filter((inst) => {
      const label = labelOf(inst);
      if (opts.mine && !label.startsWith(`${owner}/`)) return false;
      if (wantLabel) {
        try {
          if (!new RegExp(wantLabel).test(label)) return false;
        } catch {
          if (!label.includes(wantLabel)) return false;
        }
      }
      return true;
    });
  }
  if (instances.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ instances: [] }));
    } else {
      const filterDesc = opts.mine || opts.label
        ? ` matching filter (${totalBeforeFilter} total in pool)`
        : '';
      console.log(`No active GPU instances${filterDesc}.`);
    }
    return;
  }

  // Default: probe when there are <= 5 instances (cheap + most useful)
  // and we are not in --json mode. --probe forces it; --no-probe disables.
  const shouldProbe = opts.probe !== false && instances.length <= 10;
  if (shouldProbe) {
    await Promise.all(instances.map(async (inst) => {
      const target = pickProbeTarget(inst);
      if (!target) { (inst as { liveness?: string }).liveness = 'unknown'; return; }
      const t0 = Date.now();
      const alive = await tcpProbe(target.host, target.port, 3000);
      const dt = Date.now() - t0;
      (inst as { liveness?: string }).liveness = alive ? `alive (${dt}ms)` : 'unreachable';
    }));
  }

  if (opts.json) {
    console.log(JSON.stringify({ instances }, null, 2));
    return;
  }

  const filterNote = (opts.mine || opts.label)
    ? ` (filtered from ${totalBeforeFilter})`
    : '';
  console.log(`${instances.length} active instance(s)${filterNote}:\n`);
  for (const inst of instances) {
    console.log(`  ${inst.instanceId || inst.podId || '?'}`);
    if (inst.deployId) console.log(`    deployId:  ${inst.deployId}`);
    // Label = ownership marker. Print prominently so cross-project terminates
    // can be spotted before they happen.
    {
      const lbl = labelOf(inst);
      if (lbl) console.log(`    label:     ${lbl}`);
    }
    if (inst.provider) console.log(`    provider:  ${inst.provider}`);
    if (inst.gpuType || inst.gpuName) console.log(`    gpu:       ${inst.gpuType || inst.gpuName}`);
    if (inst.status) console.log(`    status:    ${inst.status}`);
    // liveness is the actual TCP-probe result; status is the provider's
    // claim. They diverge for zombie pods — flag the divergence loudly.
    if ((inst as { liveness?: string }).liveness) {
      const liv = (inst as { liveness?: string }).liveness!;
      const flag = liv === 'unreachable' && inst.status === 'running' ? '  ⚠ ZOMBIE' : '';
      console.log(`    liveness:  ${liv}${flag}`);
    }
    if (inst.endpoint) console.log(`    endpoint:  ${inst.endpoint}`);
    if (inst.costPerHr) console.log(`    cost/hr:   $${Number(inst.costPerHr).toFixed(2)}`);
    if (inst.dockerImage) console.log(`    image:     ${inst.dockerImage}`);
    console.log('');
  }
}

/**
 * `ai-gateway gpu doctor [--instance ID]` — full diagnostic dump for one
 * (or all) instances. Distinct from `gpu list --probe` because:
 *
 *   - Probes SSH (port 22 via the proxy hostname) AND the HTTP endpoint
 *     separately — `running` pods can have working HTTP but dead SSH
 *     when the SSH-proxy node falls off the network (we hit this twice).
 *   - Tries an actual SSH `echo` round-trip when --instance is given,
 *     because TCP-open is necessary but not sufficient.
 *   - Reports liveness in machine-readable form so scripts can branch:
 *     `if ai-gateway gpu doctor --instance X --json | jq -e '.alive'`.
 */
async function cmdGpuDoctor(opts: { instance?: string; json?: boolean }) {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/gpu/list`, { headers: headers(key) });
  const data = await res.json();
  const instances: Record<string, unknown>[] = Array.isArray(data) ? data : (data.instances || []);
  const targets = opts.instance
    ? instances.filter(i => i.instanceId === opts.instance || i.podId === opts.instance)
    : instances;
  if (targets.length === 0) {
    if (opts.json) console.log(JSON.stringify({ instances: [] }));
    else console.log(opts.instance ? `No instance "${opts.instance}".` : 'No active GPU instances.');
    return;
  }

  const reports: Record<string, unknown>[] = [];
  for (const inst of targets) {
    const id = String(inst.instanceId || inst.podId || '?');
    const report: Record<string, unknown> = {
      instanceId: id,
      provider: inst.provider,
      gpuType: inst.gpuType || inst.gpuName,
      status: inst.status,
      endpoint: inst.endpoint,
      sshHost: inst.sshHost,
      sshPort: inst.sshPort,
      checks: {} as Record<string, unknown>,
    };
    const checks = report.checks as Record<string, unknown>;

    // HTTP probe
    if (inst.endpoint && typeof inst.endpoint === 'string' && /^https?:\/\//.test(inst.endpoint)) {
      try {
        const u = new URL(inst.endpoint);
        const t0 = Date.now();
        const alive = await tcpProbe(u.hostname, u.port ? parseInt(u.port, 10) : 80, 3000);
        checks.http_tcp = { alive, latencyMs: Date.now() - t0 };
        if (alive) {
          // Try /info — most images expose it
          try {
            const ctrl = new AbortController();
            const tt = setTimeout(() => ctrl.abort(), 3000);
            const r = await fetch(`${inst.endpoint}/info`, { signal: ctrl.signal });
            clearTimeout(tt);
            checks.http_info = { status: r.status };
          } catch (e) {
            checks.http_info = { error: (e as Error).message };
          }
        }
      } catch (e) {
        checks.http_tcp = { error: (e as Error).message };
      }
    }
    // SSH probe (TCP only — SSH banner timing depends on provider)
    if (inst.sshHost && inst.sshPort) {
      const t0 = Date.now();
      const alive = await tcpProbe(String(inst.sshHost), Number(inst.sshPort), 3000);
      checks.ssh_tcp = { alive, latencyMs: Date.now() - t0 };
    }

    // Aggregate alive flag — true only if we have evidence of reachability
    const httpOk = (checks.http_tcp as { alive?: boolean } | undefined)?.alive === true;
    const sshOk = (checks.ssh_tcp as { alive?: boolean } | undefined)?.alive === true;
    report.alive = httpOk || sshOk;
    report.zombie = inst.status === 'running' && !report.alive;
    reports.push(report);
  }

  if (opts.json) {
    console.log(JSON.stringify(opts.instance ? reports[0] : { instances: reports }, null, 2));
    return;
  }

  for (const r of reports) {
    const flag = r.zombie ? '  ⚠ ZOMBIE (provider says running, but unreachable)' : (r.alive ? '✓ alive' : '✗ unreachable');
    console.log(`${r.instanceId}  ${flag}`);
    console.log(`  provider: ${r.provider}  gpu: ${r.gpuType}  status: ${r.status}`);
    const checks = r.checks as Record<string, unknown>;
    if (checks.http_tcp) console.log(`  HTTP TCP : ${JSON.stringify(checks.http_tcp)}`);
    if (checks.http_info) console.log(`  HTTP /info: ${JSON.stringify(checks.http_info)}`);
    if (checks.ssh_tcp) console.log(`  SSH  TCP : ${JSON.stringify(checks.ssh_tcp)}`);
    console.log('');
  }
  // Exit code: 1 if any target instance is unreachable. Lets scripts gate
  // on `ai-gateway gpu doctor --instance X && do_thing`.
  const anyDead = reports.some(r => r.alive !== true);
  if (anyDead && opts.instance) process.exit(1);
}

/**
 * `ai-gateway gpu wait [--instance ID] [--timeout SEC]` — poll until the
 * active deploy (or a specific instance) is ready/reachable.
 * Without --instance: polls /v1/gpu/status until status === 'ready'.
 * With --instance: polls /v1/gpu/list until that instance is TCP-reachable.
 * Returns 0 when ready, 1 on timeout or error.
 */
async function cmdGpuWaitActive(opts: { timeout?: number }) {
  const timeoutSec = opts.timeout ?? 600;
  const startMs = Date.now();
  const deadline = startMs + timeoutSec * 1000;
  const { url, key } = getConfig();
  while (Date.now() < deadline) {
    try {
      const data = await fetchJSON(`${url}/v1/gpu/status`, { headers: headers(key) });
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      if (data.status === 'ready') {
        process.stderr.write('\n');
        console.log(`✓ ready (${elapsed}s) endpoint=${data.endpoint || '?'} ssh=${data.ssh || '?'}`);
        return;
      }
      if (data.status === 'error') {
        process.stderr.write('\n');
        console.error(`✗ deploy error: ${data.message || 'unknown'}`);
        process.exit(1);
      }
      if (data.status === 'idle') {
        process.stderr.write('\n');
        console.error('✗ no active deploy (status=idle)');
        process.exit(1);
      }
      process.stderr.write(`\r  [${elapsed}s] ${data.step || data.status} ${data.message || ''}`.padEnd(80));
    } catch (e) {
      process.stderr.write(`\r  gateway unreachable: ${(e as Error).message}`.padEnd(80));
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  process.stderr.write('\n');
  console.error(`✗ deploy did not become ready in ${timeoutSec}s`);
  process.exit(1);
}

async function cmdGpuWait(opts: { instance: string; timeout?: number; intervalSec?: number }) {
  const timeoutSec = opts.timeout ?? 300;
  const intervalSec = opts.intervalSec ?? 5;
  const deadline = Date.now() + timeoutSec * 1000;
  const { url, key } = getConfig();
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/v1/gpu/list`, { headers: headers(key) });
      const data = await res.json();
      const instances: Record<string, unknown>[] = Array.isArray(data) ? data : (data.instances || []);
      const inst = instances.find(i => i.instanceId === opts.instance || i.podId === opts.instance);
      if (!inst) {
        lastErr = `instance ${opts.instance} not in list`;
      } else {
        const t = pickProbeTarget(inst);
        if (t && await tcpProbe(t.host, t.port, 3000)) {
          const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000);
          console.log(`✓ ${opts.instance} reachable (${t.host}:${t.port}, ${elapsed}s)`);
          return;
        }
        lastErr = `${t ? `${t.host}:${t.port}` : 'no target'} not reachable, status=${inst.status}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    process.stderr.write('.');
    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }
  console.error(`\n✗ ${opts.instance} did not become reachable in ${timeoutSec}s. Last: ${lastErr}`);
  process.exit(1);
}

async function cmdGpuTerminate(instanceId: string, opts: { provider?: string; deployId?: string; force?: boolean }) {
  const { url, key } = getConfig();
  // Cross-project terminate guard: refuse to destroy an instance whose
  // label is owned by another user/project unless --force is passed.
  // Looks up the instance in /v1/gpu/list so we don't have to add a
  // dedicated "describe" endpoint server-side. Fails open (allow) when
  // the list endpoint is unreachable so a degraded gateway doesn't
  // strand legitimate cleanups.
  if (!opts.force) {
    try {
      const listRes = await fetch(`${url}/v1/gpu/list`, { headers: headers(key) });
      if (listRes.ok) {
        const listData = await listRes.json();
        const all: Record<string, unknown>[] = Array.isArray(listData) ? listData : (listData.instances || []);
        const target = all.find((inst) => (inst.instanceId || inst.podId) === instanceId);
        const rawLabel = target
          ? ((target as { label?: string; instanceName?: string }).label
              ?? (target as { instanceName?: string }).instanceName
              ?? '')
          : '';
        // Ignore the placeholder where instanceName just echoes instanceId.
        const label = (target && (rawLabel === target.instanceId || rawLabel === target.podId)) ? '' : rawLabel;
        if (label.includes('/')) {
          const owner = currentOwner();
          const labelOwner = label.split('/', 1)[0];
          if (labelOwner !== owner) {
            console.error(`Refusing terminate: instance ${instanceId} is owned by '${labelOwner}' (label="${label}").`);
            console.error(`Current operator is '${owner}'. Pass --force to terminate anyway,`);
            console.error(`or set AIGW_OWNER=${labelOwner} if you legitimately own that label.`);
            process.exit(3);
          }
        }
      }
    } catch {
      // see comment above — fail open
    }
  }
  const body: Record<string, string> = {};
  if (opts.provider) body.provider = opts.provider;
  if (opts.deployId) body.deployId = opts.deployId;
  const res = await fetch(`${url}/v1/gpu/terminate`, {
    method: 'POST', headers: headers(key),
    body: JSON.stringify({ instanceId, ...body }),
  });
  if (res.status === 404) {
    console.log('GPU endpoints not available (proxy-only mode).');
    return;
  }
  if (!res.ok) {
    const err = await res.text();
    console.error(`Error ${res.status}: ${err.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`Instance ${instanceId} terminated.`);
}

// ── GPU jobs — provision cheapest GPU, run a job, pull artifacts, terminate ─
//
// One-shot job lifecycle:
//   1. Pick cheapest GPU offer matching --gpu (default: 4090) under --max-cost
//   2. Deploy via existing /v1/gpu/deploy (auto-cascade)
//   3. Wait ready
//   4. Upload local --path to /workspace OR git clone --repo
//   5. Run --main inside /workspace, stream logs
//   6. Pull /workspace back to --output
//   7. Terminate instance (always, even on error)
//
// Designed for cost-sensitive batch jobs (TTS finetune, ASR eval, etc.) where
// you don't want a long-lived dev box. Auto-terminate prevents orphan spend.
interface GpuJobOpts {
  repo?: string;
  path?: string;
  main: string;
  gpu?: string;
  maxCost?: number;
  output?: string;
  timeoutMin?: number;
  image?: string;
  keepAlive?: boolean;        // never terminate (success or failure)
  terminateOnError?: boolean; // OPT-IN destroy on error. Default: keep alive on error so user can SSH-debug.
  env?: string;
  pullEveryMin?: number;      // periodic mid-run rsync /workspace → output (default 10; 0 disables)
  dryRun?: boolean;           // pick offer + print plan; never spend money
  stallMin?: number;          // warn if /workspace mtime unchanged for N min (default 30; 0 disables)
  maxSpend?: number;          // hard $ cap. polls cost; force-terminates when exceeded
  pullExclude?: string[];     // rsync --exclude paths (skip /root/.cache, dataset/, etc)
  preferSpot?: boolean;       // ask vast/runpod for interruptible (≈30-50% cheaper)
  selectMode?: 'cheapest' | 'balanced' | 'fast'; // offer ranking; all obey maxCost ceiling. default balanced
  reuseInstance?: boolean;    // skip provisioning if a live owner-tagged instance with same image exists
  abortOnDivergence?: boolean; // tail /workspace/.job.log for loss=X; abort if NaN/Inf or 5× initial
  gpuFallback?: boolean;      // walk cheaper-GPU ladder if primary unavailable @ maxCost
  bootTimeoutMin?: number;    // max wait for instance to reach "ready" before abandoning (default: timeoutMin)
  provider?: string;          // pin a provider (e.g. 'vast') — passed to server as body.provider
}

// Persist last job's instance info so subsequent jobs ssh/sync/pull/cleanup
// can target it without arg-passing.
function jobStatePath(): string {
  const home = process.env.HOME || '/tmp';
  return join(home, '.babelcast', 'last_job.json');
}
function jobHistoryPath(): string {
  const home = process.env.HOME || '/tmp';
  return join(home, '.babelcast', 'jobs-history.jsonl');
}
function appendJobHistory(entry: Record<string, unknown>): void {
  try {
    const p = jobHistoryPath();
    mkdirSync(dirname(p), { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    // Use appendFileSync (O_APPEND under the hood) — atomic under POSIX, so
    // two concurrent CLI processes don't race on read-modify-write and lose
    // history. Previous code read the whole file, concatenated, and rewrote
    // (O(n²) + last-write-wins).
    const fs = require('fs');
    fs.appendFileSync(p, line);
  } catch { /* best effort */ }
}
function saveJobState(state: Record<string, unknown>): void {
  try {
    const p = jobStatePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`  ⚠ could not save job state: ${(e as Error).message}`);
  }
}

// ── Adaptive boot timeout ───────────────────────────────────────────────────
// A fixed 10-min boot timeout wastes ~10 min on a dud host before retrying.
// Instead, learn the typical boot time per (provider,gpu) and abandon a host
// that runs >20% over the recent median — then auto-resubmit picks a fresh one.
// Keeps a rolling window of recent successful boot durations on disk.
function bootStatsPath(): string {
  return join(process.env.HOME || '/tmp', '.babelcast', 'boot_stats.json');
}
function readBootStats(): Record<string, number[]> {
  try { return JSON.parse(require('fs').readFileSync(bootStatsPath(), 'utf-8')); }
  catch { return {}; }
}
function recordBootTime(key: string, sec: number): void {
  try {
    const stats = readBootStats();
    const arr = stats[key] ?? [];
    arr.push(Math.round(sec));
    stats[key] = arr.slice(-20); // rolling window of last 20 boots
    const p = bootStatsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(stats));
  } catch { /* best effort — never block deploy on stats */ }
}
// Returns adaptive boot timeout in MINUTES, or the fallback when there is not
// enough history yet. median(recent)*1.2, clamped to [floorMin, fallbackMin].
function adaptiveBootTimeoutMin(key: string, fallbackMin: number, floorMin = 3): number {
  const arr = (readBootStats()[key] ?? []).slice().sort((a, b) => a - b);
  if (arr.length < 3) return fallbackMin; // not enough data — stay conservative
  const median = arr[Math.floor(arr.length / 2)];
  const adaptiveMin = (median * 1.2) / 60;
  return Math.max(floorMin, Math.min(fallbackMin, Math.ceil(adaptiveMin)));
}
function loadJobState(): Record<string, unknown> | null {
  try {
    const p = jobStatePath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// ── Cumulative job budget (spot-resume) ──────────────────────────────────────
// Spend is tracked per logical job (keyed by stable R2 prefix) so it survives
// pod restarts AND fresh CLI invocations — per-pod accounting would reset to $0
// on every preemption and let a flapping job blow the budget.
function jobBudgetPath(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(process.env.HOME || '/tmp', '.babelcast', `budget-${safe}.json`);
}
function loadBudget(jobId: string): JobBudget {
  try {
    const p = jobBudgetPath(jobId);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as JobBudget;
  } catch { /* fall through to empty */ }
  return emptyBudget(jobId, new Date().toISOString());
}
function saveBudget(b: JobBudget): void {
  try {
    const p = jobBudgetPath(b.jobId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(b, null, 2));
  } catch { /* best effort — never block a run on budget bookkeeping */ }
}

async function cmdGpuJobsRun(opts: GpuJobOpts): Promise<void> {
  const { url, key } = getConfig();
  if (!opts.repo && !opts.path) {
    console.error('Need --repo <url> OR --path <local-dir>');
    process.exit(1);
  }
  // Numeric sanity — NaN parseFloat or absurd budgets would silently slip through.
  const numericChecks: Array<[string, number | undefined, number, number]> = [
    ['--max-cost', opts.maxCost, 0.01, 50],
    ['--max-spend', opts.maxSpend, 0.01, 100],
    ['--pull-every', opts.pullEveryMin, 0, 1440],
    ['--stall-min', opts.stallMin, 0, 1440],
    ['--timeout-min', opts.timeoutMin, 1, 4320],
  ];
  for (const [name, val, lo, hi] of numericChecks) {
    if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || val < lo || val > hi)) {
      console.error(`Invalid ${name}=${val} (expected ${lo}-${hi})`);
      process.exit(1);
    }
  }
  const gpuFilter = String(opts.gpu || '4090');
  const maxCost = opts.maxCost ?? 0.5;
  const outputDir = opts.output || './job_output';
  const timeoutMin = opts.timeoutMin ?? 60;
  const image = opts.image || 'marcosremar/gpu-dev:latest';

  // Cheaper-GPU fallback ladder (--gpu-fallback). Used when primary unavailable
  // OR over budget. Order = preferred → cheaper alternatives by VRAM/perf class.
  const FALLBACK: Record<string, string[]> = {
    '5090': ['5090', '4090', 'A6000', 'A5000'],
    '4090': ['4090', '3090', 'A5000', '4080'],
    '4080': ['4080', '3090', 'A5000', 'A4000'],
    '3090': ['3090', 'A5000', 'A4000'],
    'A6000': ['A6000', 'A5000', 'A40'],
    'A5000': ['A5000', 'A4000', '3090'],
    'A100': ['A100', 'A6000', 'L40S'],
    'L40S': ['L40S', 'A6000', 'A100'],
  };

  // 1. Find cheapest matching offer.
  // Don't pass gpuTypes — server expects exact "NVIDIA GeForce RTX 4090" string,
  // and we want substring matching. Fetch unfiltered + filter client-side.
  console.log(`${c.cyan}[1/6]${c.reset} Finding cheapest GPU (filter=${gpuFilter}, max=$${maxCost}/h)...`);
  const offerRes = await fetch(`${url}/v1/gpu/offers?limit=100`, {
    headers: headers(key),
  });
  if (!offerRes.ok) {
    console.error(`No offers (HTTP ${offerRes.status}). Try later.`);
    process.exit(1);
  }
  const offerData = await offerRes.json();
  const offers: Array<Record<string, unknown>> = offerData.offers ?? [];
  // Server emits `pricePerHr` (camelCase). Older builds called it `priceHr` —
  // accept both. GPU name is `gpuName` (display) or `gpuType` (raw).
  const priceOf = (o: Record<string, unknown>): number => {
    const p = (o.pricePerHr ?? o.priceHr) as number | undefined;
    return typeof p === 'number' ? p : Number.POSITIVE_INFINITY;
  };
  const gpuName = (o: Record<string, unknown>): string =>
    String(o.gpuName ?? o.gpuType ?? o.gpu ?? '?');

  // Pre-filter by --gpu substring match (server may not honor the query param).
  // With --gpu-fallback, walk the FALLBACK ladder until something affordable found.
  const filterLc = gpuFilter.toLowerCase();
  const fallbackOn = !!opts.gpuFallback;
  const tryList = fallbackOn
    ? (FALLBACK[gpuFilter.toUpperCase()] || FALLBACK[gpuFilter] || [gpuFilter])
    : [gpuFilter];
  let matched: Array<Record<string, unknown>> = [];
  let usedFilter = gpuFilter;
  for (const candidate of tryList) {
    const lc = candidate.toLowerCase();
    matched = lc === 'any'
      ? offers
      : offers.filter((o) => gpuName(o).toLowerCase().includes(lc));
    const cheap = matched.filter((o) => priceOf(o) <= maxCost);
    if (cheap.length > 0) {
      usedFilter = candidate;
      if (candidate.toLowerCase() !== filterLc) {
        console.log(`  ${c.yellow}[fallback]${c.reset} primary '${gpuFilter}' unavailable @ $${maxCost}/h → using '${candidate}'`);
      }
      break;
    }
  }
  // Selection mode: cheapest | balanced (cost-benefit, default) | fast.
  // ALL modes obey the maxCost price ceiling first — so "fast" can never pick
  // an absurdly expensive GPU; it only prefers faster-booting hosts UNDER the cap.
  const selectMode = ((opts.selectMode as string) ?? 'balanced') as 'cheapest' | 'balanced' | 'fast';
  const qualityOf = (o: Record<string, unknown>): number => {
    const rel = Number(o.reliability2 ?? o.reliability ?? 0.9);   // 0-1
    const inet = Number(o.inetDown ?? o.inet_down ?? 0);          // Mbps
    const dl = Number(o.dlperf ?? o.dlPerf ?? 0);                 // vast dlperf
    const inetBoost = Math.min(inet / 1000, 1);                  // 1Gbps+ = full
    const dlBoost = Math.min(dl / 30, 1);
    return Math.max(0.05, 0.6 * rel + 0.25 * inetBoost + 0.15 * dlBoost);
  };
  const affordable = matched
    .filter((o) => priceOf(o) <= maxCost)   // price ceiling = "not absurd" guard
    .sort((a, b) => {
      if (selectMode === 'cheapest') return priceOf(a) - priceOf(b);
      if (selectMode === 'fast') {
        const dq = qualityOf(b) - qualityOf(a);            // fastest/most-reliable first
        return dq !== 0 ? dq : priceOf(a) - priceOf(b);    // tie-break cheaper
      }
      // balanced: effective price = $/quality (best cost-benefit)
      return priceOf(a) / qualityOf(a) - priceOf(b) / qualityOf(b);
    });
  if (affordable.length === 0) {
    console.error(`No '${gpuFilter}' offers within $${maxCost}/h.${fallbackOn ? ` Fallback chain [${tryList.join('→')}] also empty.` : ''} ` +
                  `Pool: ${offers.length} total, ${matched.length} match '${usedFilter}'.`);
    if (matched.length > 0) {
      const cheapest = [...matched].sort((a, b) => priceOf(a) - priceOf(b)).slice(0, 3);
      console.error(`Cheapest matching:`);
      for (const o of cheapest) console.error(`  ${gpuName(o)} @ $${priceOf(o).toFixed(3)}/h on ${o.provider}`);
    }
    process.exit(1);
  }
  const pick = affordable[0];
  const pickPrice = priceOf(pick);
  const pickName = gpuName(pick);
  console.log(`  picked: ${pickName} @ $${pickPrice.toFixed(3)}/h on ${pick.provider} (mode=${selectMode})`);

  if (opts.dryRun) {
    const timeoutMin = opts.timeoutMin ?? 60;
    const projHi = (pickPrice * (timeoutMin / 60)).toFixed(2);
    console.log(`\n${c.yellow}[DRY RUN]${c.reset} Plan (no money spent):`);
    console.log(`  gpu:        ${pickName}`);
    console.log(`  provider:   ${pick.provider}`);
    console.log(`  price:      $${pickPrice.toFixed(3)}/h`);
    console.log(`  image:      ${image}`);
    console.log(`  upload:     ${opts.path ? opts.path : `git clone ${opts.repo}`}`);
    console.log(`  main:       ${opts.main.slice(0, 100)}${opts.main.length > 100 ? '...' : ''}`);
    console.log(`  output:     ${outputDir}`);
    console.log(`  timeout:    ${timeoutMin}min  → projected MAX cost: $${projHi}`);
    console.log(`  pull-every: ${opts.pullEveryMin === undefined ? 10 : opts.pullEveryMin}min`);
    console.log(`\nRe-run without --dry-run to actually deploy.`);
    process.exit(0);
  }

  // 2. Deploy (or reuse a live owner-tagged instance with same image)
  let info: Record<string, unknown> | null = null;
  let deployId: string | undefined;
  if (opts.reuseInstance) {
    const owner = currentOwner();
    const listRes = await fetch(`${url}/v1/gpu/list?probe=false`, { headers: headers(key) });
    if (listRes.ok) {
      const data: any = await listRes.json();
      const all: any[] = Array.isArray(data) ? data : (data.instances || []);
      const live = all.find((i: any) => {
        const lbl = (i.label || i.instanceName || '') as string;
        return lbl.startsWith(`${owner}/`) && (i.sshHost || i.host) && (!image || i.image === image);
      });
      if (live) {
        console.log(`${c.cyan}[2/6]${c.reset} ${c.green}REUSING${c.reset} live instance ${live.instanceId || live.podId}`);
        info = live;
        deployId = live.deployId;
      }
    }
  }
  if (!info) {
    console.log(`${c.cyan}[2/6]${c.reset} Provisioning instance...`);
    const deployBody: Record<string, unknown> = {
      image,
      gpuTypes: [pickName],
    };
    if (opts.env) deployBody.env = opts.env;
    if (opts.provider) deployBody.provider = opts.provider;  // pin provider (server honors body.provider)
    deployBody.interruptible = opts.preferSpot === true;
    deployBody.strictFastBoot = true;  // reliability >= 0.97 filter for finetune jobs
    deployBody.finetune = true;        // protect from autoscaler cancel-and-redeploy
    deployBody.label = `${currentOwner()}/job-${Date.now()}`;
    const depRes = await fetch(`${url}/v1/gpu/deploy`, {
      method: 'POST', headers: headers(key), body: JSON.stringify(deployBody),
    });
    if (!depRes.ok) {
      const err = await depRes.text();
      console.error(`Deploy failed: ${err.slice(0, 200)}`);
      process.exit(1);
    }
    const dep = await depRes.json();
    deployId = dep.deployId;
    console.log(`  deployId: ${deployId}`);
  }

  // 3. Poll until ready (skip if reusing — already ready)
  if (!info) {
    // bootTimeoutMin caps how long we wait for provisioning. Shorter than timeoutMin so
    // slow/dead instances are abandoned fast and auto-resubmit picks a new one.
    const bootKey = `${pick.provider}:${pickName}`;
    // Caller's bootTimeoutMin is the CEILING/fallback, not an override: the
    // adaptive value (median×1.2 of recent boots, clamped [3min, ceiling]) wins
    // once there's history, else we fall back to the caller's value. This lets
    // the finetune's fixed 10-min cap still benefit from adaptive shortening.
    const bootCeilingMin = opts.bootTimeoutMin ?? timeoutMin;
    const bootTimeoutMin = adaptiveBootTimeoutMin(bootKey, bootCeilingMin);
    const adaptiveNote = bootTimeoutMin < bootCeilingMin ? ' (adaptive: median×1.2)' : '';
    console.log(`${c.cyan}[3/6]${c.reset} Waiting for instance ready (timeout=${bootTimeoutMin}min${adaptiveNote})...`);
    const bootStart = Date.now();
    const deadline = bootStart + bootTimeoutMin * 60_000;
  while (Date.now() < deadline) {
    const stRes = await fetch(`${url}/v1/gpu/status`, { headers: headers(key) });
    if (stRes.ok) {
      const st = await stRes.json();
      const phase = (st.phase || '').toString();
      // Guard against autoscaler race: status endpoint returns global active
      // deploy. Ignore results that belong to a different deployId.
      const stDeployId = st.deployId || st.podId;
      const deployIdMatches = !deployId || !stDeployId || stDeployId === deployId ||
        String(stDeployId).includes(deployId.replace('deploy-', ''));
      if ((phase === 'ready' || st.gpuHealthy === true || st.sshHost) && deployIdMatches) {
        info = st;
        const bootSec = (Date.now() - bootStart) / 1000;
        recordBootTime(bootKey, bootSec); // feed the adaptive timeout for next runs
        console.log(`  ready: ${st.sshHost || 'n/a'}:${st.sshPort || 'n/a'} (${phase}) in ${bootSec.toFixed(0)}s`);
        break;
      }
      // Server-side deploy errored (no instance will appear) — abort NOW rather
      // than polling a dead deploy for the full timeout. auto-resubmit retries.
      if ((phase === 'error' || st.status === 'error') && deployIdMatches) {
        console.log();
        process.stderr.write(`${c.yellow}⚠ deploy errored server-side (${st.error || st.message || 'unknown'}) — abandoning${c.reset}\n`);
        await fetch(`${url}/v1/gpu/terminate`, {
          method: 'POST', headers: headers(key), body: JSON.stringify({ deployId }),
        }).catch(() => {});
        throw new Error(`deploy errored: ${st.error || st.message || 'unknown'}`);
      }
      process.stdout.write(`\r  ${phase}...                    `);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log();
  if (!info) {
    process.stderr.write(`${c.yellow}⚠ instance boot timed out after ${bootTimeoutMin}min — terminating and trying new instance${c.reset}\n`);
    await fetch(`${url}/v1/gpu/terminate`, {
      method: 'POST', headers: headers(key),
      body: JSON.stringify({ deployId }),
    });
    throw new Error(`instance boot timed out after ${bootTimeoutMin}min`);
  }
  } // end if (!info) — close reuse skip block

  const sshHost = info.sshHost as string;
  const sshPort = info.sshPort as number;
  const instanceId = (info.instanceId || info.podId) as string;
  const sshOpts = ['-p', String(sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
                   '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8'];

  // Persist instance info so jobs ssh/sync/pull/cleanup can target it.
  saveJobState({
    instanceId, deployId, sshHost, sshPort,
    localPath: opts.path ? resolve(opts.path) : null,
    repo: opts.repo || null,
    output: resolve(outputDir),
    main: opts.main,
    pricePerHr: pickPrice,
    provider: pick.provider,
    gpuType: pickName,
    startedAt: new Date().toISOString(),
  });

  let exitCode = 0;
  let pullOk = false;
  let t0 = Date.now();
  let budgetExceeded = false;
  try {
    // 4. Setup workspace
    console.log(`${c.cyan}[4/6]${c.reset} Setting up workspace...`);
    if (opts.repo) {
      const cloneCmd = `git clone --depth 1 ${opts.repo} /workspace`;
      // Retry clone: vast.ai "ready" can fire before sshd is fully stable.
      let cloneOk = false;
      for (let i = 0; i < 12; i++) {
        const cloneRes = spawnSync('ssh', [...sshOpts, `root@${sshHost}`, cloneCmd], { stdio: 'inherit' });
        if (cloneRes.status === 0) { cloneOk = true; break; }
        if (i < 11) {
          process.stderr.write(`  git clone failed (attempt ${i + 1}/12), retrying in 10s...\n`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        }
      }
      if (!cloneOk) throw new Error(`git clone failed after 12 attempts`);
    } else if (opts.path) {
      const localPath = opts.path.replace(/\/$/, '');
      console.log(`  rsync ${localPath} → /workspace`);
      // Retry rsync: vast.ai "ready" fires before sshd is stable; backoff up to ~3min.
      // 8 attempts is enough for any legitimate SSH proxy startup. Dead instances fail fast.
      let rsyncOk = false;
      let rsyncRefusedStreak = 0;
      const rsyncDelays = [5, 10, 15, 20, 30, 30, 30, 30];
      for (let i = 0; i < rsyncDelays.length; i++) {
        const upRes = spawnSync('rsync', ['-az', '--delete', '-e',
          `ssh -p ${sshPort} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR -o ServerAliveInterval=15 -o ServerAliveCountMax=8`,
          `${localPath}/`, `root@${sshHost}:/workspace/`,
        ], { stdio: ['inherit', 'inherit', 'pipe'] });
        if (upRes.status === 0) { rsyncOk = true; break; }
        const stderr = upRes.stderr?.toString() ?? '';
        const refused = stderr.includes('Connection refused') || stderr.includes('connect to host');
        if (refused) rsyncRefusedStreak++; else rsyncRefusedStreak = 0;
        // 5 consecutive "Connection refused" = proxy port is dead, fail fast
        if (rsyncRefusedStreak >= 5) {
          process.stderr.write(`  rsync: SSH port ${sshPort} consistently refused — instance SSH proxy dead\n`);
          break;
        }
        if (i < rsyncDelays.length - 1) {
          process.stderr.write(`  rsync failed (attempt ${i + 1}/${rsyncDelays.length}), retrying in ${rsyncDelays[i]}s...\n`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rsyncDelays[i] * 1000);
        }
      }
      if (!rsyncOk) throw new Error(`rsync upload failed — SSH proxy unreachable`);
    }

    const pullEveryMin = opts.pullEveryMin === undefined ? 10 : opts.pullEveryMin;
    console.log(`${c.cyan}[5/6]${c.reset} Running job: ${opts.main}`);
    if (pullEveryMin > 0) {
      console.log(`  (mid-run checkpoint pull every ${pullEveryMin}min → ${outputDir})`);
    }
    mkdirSync(outputDir, { recursive: true });
    // Wrap user command with tee → /workspace/.job.log so 'gpu jobs logs' can tail it
    // even if the local terminal disconnects. PIPESTATUS preserves user-cmd exit code.
    // Heartbeat: some SSH proxies (vast.ai) drop connections on application-level idle.
    // Print a space every 4s so there's always data flowing even during silent pip/hf phases.
    const runCmd = `cd /workspace && { while true; do sleep 4; printf ' '; done; } & _HB=$!; trap 'kill $_HB 2>/dev/null' EXIT; set -o pipefail; { ${opts.main}; } 2>&1 | tee /workspace/.job.log; _EC=\${PIPESTATUS[0]}; kill $_HB 2>/dev/null; exit $_EC`;
    t0 = Date.now();
    const child = spawn('ssh', [...sshOpts, `root@${sshHost}`, runCmd], { stdio: 'inherit' });
    const rsyncEnv = `ssh -p ${sshPort} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR`;

    const midPullExcludesDefault = ['.cache/', '.cache-pip/', '.huggingface/', '__pycache__/', '*.pyc'];
    const midPullExcludes = [...midPullExcludesDefault, ...(opts.pullExclude || [])];
    const midPullExcludeArgs = midPullExcludes.flatMap((e) => ['--exclude', e]);
    let midRunPulling = false;
    const doMidPull = (label: string): boolean => {
      if (midRunPulling) return false;
      midRunPulling = true;
      const r = spawnSync('rsync', ['-az', '--compress-level=3', '--partial', '--inplace', ...midPullExcludeArgs, '-e', rsyncEnv,
        `root@${sshHost}:/workspace/`, `${outputDir}/`,
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      const tag = r.status === 0 ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
      const dtMin = ((Date.now() - t0) / 60_000).toFixed(1);
      process.stderr.write(`\n  [+${dtMin}min] ${label} ${tag}${r.status === 0 ? '' : ` (exit ${r.status})`}\n`);
      midRunPulling = false;
      return r.status === 0;
    };

    const pullTimer = pullEveryMin > 0
      ? setInterval(() => doMidPull('mid-run pull'), pullEveryMin * 60_000)
      : null;

    // Stall watchdog — query the newest mtime under /workspace via ssh.
    // If it stops advancing for stallMin minutes, the box is likely hung
    // (network blip, OOM frozen kernel, deadlocked Python). Just warns —
    // user can SIGINT, then `gpu jobs ssh` to inspect.
    const stallMin = opts.stallMin === undefined ? 30 : opts.stallMin;
    let lastMtime = 0;
    let stallSinceMs = Date.now();
    let stallWarned = false;
    // Live divergence watcher: tail /workspace/.job.log for loss=X.
    // Abort job if NaN/Inf OR sustained loss > 5× initial (after warmup).
    let divergenceAborted = false;
    const lossSamples: number[] = [];
    let initialLoss = 0;
    const divergenceTimer = opts.abortOnDivergence ? setInterval(() => {
      const r = spawnSync('ssh', [...sshOpts, `root@${sshHost}`,
        `tail -n 50 /workspace/.job.log 2>/dev/null | grep -oE 'loss=[0-9.]+' | tail -10`],
        { encoding: 'utf-8', timeout: 10_000 });
      const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
      for (const ln of lines) {
        const m = ln.match(/loss=([0-9.]+)/);
        if (!m) continue;
        const v = parseFloat(m[1]);
        if (!Number.isFinite(v) || isNaN(v)) {
          divergenceAborted = true;
          process.stderr.write(`\n${c.red}⛔ DIVERGENCE: loss = NaN/Inf — aborting${c.reset}\n`);
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          return;
        }
        if (lossSamples.length === 0) initialLoss = v;
        lossSamples.push(v);
        if (lossSamples.length > 20) lossSamples.shift();
      }
      // After 10+ samples, check if recent avg is 5× initial = diverged
      if (lossSamples.length >= 10 && initialLoss > 0) {
        const recentAvg = lossSamples.slice(-5).reduce((a, x) => a + x, 0) / 5;
        if (recentAvg > 5 * initialLoss) {
          divergenceAborted = true;
          process.stderr.write(`\n${c.red}⛔ DIVERGENCE: loss ${recentAvg.toFixed(2)} > 5× init ${initialLoss.toFixed(2)} — aborting${c.reset}\n`);
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }
      }
    }, 60_000) : null;

    // Hard $ budget cap — polls cost every minute. Once breached, force-kill
    // the run + terminate instance (overrides keep-alive-on-error).
    const budgetTimer = (opts.maxSpend && opts.maxSpend > 0) ? setInterval(() => {
      const elapsedH = (Date.now() - t0) / 3_600_000;
      const spent = elapsedH * (pickPrice as number);
      if (spent >= opts.maxSpend!) {
        if (budgetExceeded) return;
        budgetExceeded = true;
        process.stderr.write(`\n${c.red}⛔ BUDGET EXCEEDED${c.reset}: spent $${spent.toFixed(2)} ≥ cap $${opts.maxSpend!.toFixed(2)} after ${elapsedH.toFixed(2)}h\n`);
        process.stderr.write(`  killing remote job + terminating instance...\n`);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }, 60_000) : null;

    const stallTimer = stallMin > 0 ? setInterval(() => {
      const r = spawnSync('ssh', [...sshOpts, `root@${sshHost}`,
        `find /workspace -type f -printf '%T@\\n' 2>/dev/null | sort -nr | head -1`],
        { encoding: 'utf-8', timeout: 15_000 });
      const mt = parseFloat((r.stdout || '0').trim());
      if (Number.isFinite(mt) && mt > 0) {
        if (mt > lastMtime) {
          lastMtime = mt;
          stallSinceMs = Date.now();
          stallWarned = false;
        } else {
          const stalledMin = (Date.now() - stallSinceMs) / 60_000;
          if (stalledMin >= stallMin && !stallWarned) {
            process.stderr.write(`\n${c.yellow}⚠ STALL detected: /workspace mtime unchanged for ${stalledMin.toFixed(1)}min.${c.reset}\n`);
            process.stderr.write(`  Inspect: ai-gateway gpu jobs ssh "ps aux | head -30; nvidia-smi"\n`);
            process.stderr.write(`  Abort: Ctrl+C (state will be pulled, instance kept alive)\n`);
            stallWarned = true;
          }
        }
      }
    }, Math.max(60_000, (stallMin / 3) * 60_000)) : null;

    // SIGINT/SIGTERM handler: user hits Ctrl+C OR session dies.
    // Pull checkpoint state AND keep instance alive so they can reconnect.
    let aborted = false;
    const onAbort = (sig: string) => {
      if (aborted) return;
      aborted = true;
      process.stderr.write(`\n${c.yellow}[${sig}]${c.reset} aborting — pulling /workspace before exit (instance kept alive)...\n`);
      if (pullTimer) clearInterval(pullTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (budgetTimer) clearInterval(budgetTimer);
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      doMidPull('abort pull');
      process.stderr.write(`${c.yellow}Instance ${instanceId} kept alive. Reconnect via:${c.reset}\n`);
      process.stderr.write(`  ai-gateway gpu jobs ssh\n`);
      process.stderr.write(`  ai-gateway gpu jobs cleanup --force   # when done\n`);
      process.exit(130);
    };
    process.on('SIGINT', () => onAbort('SIGINT'));
    process.on('SIGTERM', () => onAbort('SIGTERM'));
    process.on('SIGHUP', () => onAbort('SIGHUP'));

    const runStatus: number = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code ?? 0));
      child.on('error', () => resolve(1));
    });
    if (pullTimer) clearInterval(pullTimer);
    if (stallTimer) clearInterval(stallTimer);
    if (budgetTimer) clearInterval(budgetTimer);
    if (divergenceTimer) clearInterval(divergenceTimer);
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGHUP');
    const dt = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(`  job exit code: ${runStatus} (${dt}min)`);
    if (runStatus !== 0) exitCode = runStatus || 1;
    // Budget breach forces terminate even on default keep-alive.
    if (budgetExceeded || divergenceAborted) opts.terminateOnError = true;
  } catch (e) {
    console.error(`${c.red}Job error:${c.reset} ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    // 6. ALWAYS pull /workspace back (success OR failure). Retries up to 3x
    // because workspace contains the work product — losing it on failure
    // means paying for the GPU run twice.
    console.log(`${c.cyan}[6/6]${c.reset} Pulling /workspace → ${outputDir} (always, even on failure)...`);
    try {
      mkdirSync(outputDir, { recursive: true });
      const rsyncEnv = `ssh -p ${sshPort} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR`;
      // Build exclude args. Default skips well-known cache/data dirs that bloat pulls.
      const excludesDefault = ['.cache/', '.cache-pip/', '.huggingface/', '__pycache__/', '*.pyc'];
      const excludes = [...excludesDefault, ...(opts.pullExclude || [])];
      const excludeArgs = excludes.flatMap((e) => ['--exclude', e]);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const pullRes = spawnSync('rsync', ['-az', '--compress-level=3', '--partial', '--inplace', ...excludeArgs, '-e', rsyncEnv,
          `root@${sshHost}:/workspace/`, `${outputDir}/`,
        ], { stdio: 'inherit' });
        if (pullRes.status === 0) { pullOk = true; break; }
        console.error(`  ⚠ pull attempt ${attempt}/5 failed (exit=${pullRes.status})`);
        if (attempt < 5) {
          const waitMs = 15000 * attempt; // 15s, 30s, 45s, 60s — survives SSH proxy reconnect
          console.error(`  retrying in ${waitMs / 1000}s...`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      if (pullOk) {
        const pulledCount = (() => {
          try {
            return readdirSync(outputDir).length;
          } catch { return -1; }
        })();
        console.log(`  ${c.green}✓${c.reset} pulled ${pulledCount >= 0 ? pulledCount + ' entries' : 'OK'} → ${outputDir}`);
      } else {
        console.error(`  ${c.red}✗ pull failed after 3 attempts. Files still on /workspace.${c.reset}`);
        console.error(`  ${c.yellow}Forcing keep-alive so you can retry: ai-gateway gpu jobs pull${c.reset}`);
      }
    } catch (pullErr) {
      console.error(`  ${c.red}pull threw:${c.reset} ${(pullErr as Error).message}`);
    }

    const failed = exitCode !== 0;
    // SAFETY: keep alive when pull failed AND terminateOnError not set — workspace may still be accessible.
    // But if terminateOnError is set (e.g. automated finetune), always terminate to prevent billing leaks.
    const shouldTerminate = !pullOk
      ? !!opts.terminateOnError   // automated jobs: terminate even when pull failed
      : opts.keepAlive
        ? false
        : (failed ? !!opts.terminateOnError : true);

    if (!shouldTerminate) {
      const reason = !pullOk ? 'pull failed (data not yet local)'
        : opts.keepAlive ? '--keep-alive'
        : 'job failed (default: keep alive on error)';
      const sshUserHost = `root@${sshHost}`;
      const localPath = opts.path ? resolve(opts.path) : null;
      console.log(`\n${c.yellow}╭─── Instance kept alive (${reason}) ───────────────────${c.reset}`);
      console.log(`${c.yellow}│${c.reset} instance: ${instanceId}`);
      console.log(`${c.yellow}│${c.reset} ssh:      ssh -p ${sshPort} ${sshUserHost}`);
      console.log(`${c.yellow}│${c.reset} workspace: /workspace  (on remote)`);
      if (localPath) {
        console.log(`${c.yellow}│${c.reset} push local → remote:`);
        console.log(`${c.yellow}│${c.reset}   rsync -az --delete -e "ssh -p ${sshPort}" "${localPath}/" "${sshUserHost}:/workspace/"`);
        console.log(`${c.yellow}│${c.reset}   ai-gateway gpu jobs sync       # convenience wrapper`);
      }
      console.log(`${c.yellow}│${c.reset} pull remote → local:`);
      console.log(`${c.yellow}│${c.reset}   ai-gateway gpu jobs pull         # convenience wrapper`);
      console.log(`${c.yellow}│${c.reset} re-run main:`);
      console.log(`${c.yellow}│${c.reset}   ai-gateway gpu jobs exec --main "<cmd>"`);
      console.log(`${c.yellow}│${c.reset} when done: ai-gateway gpu jobs cleanup`);
      console.log(`${c.yellow}╰────────────────────────────────────────────────${c.reset}`);
      console.log(`  ${c.dim}(state saved to ~/.babelcast/last_job.json)${c.reset}`);
    } else {
      console.log(`${c.cyan}[cleanup]${c.reset} Terminating ${instanceId}...`);
      const termRes = await fetch(`${url}/v1/gpu/terminate`, {
        method: 'POST', headers: headers(key),
        body: JSON.stringify({ instanceId, deployId }),
      });
      if (termRes.ok) console.log(`  ${c.green}✓${c.reset} terminated`);
      else console.error(`  ${c.red}terminate may have failed${c.reset}`);
      // Wipe state since instance is gone, append final entry to history
      const elapsedH = (Date.now() - t0) / 3_600_000;
      appendJobHistory({
        instanceId, deployId, gpuType: pickName, provider: pick.provider,
        pricePerHr: pickPrice, elapsedH, spentUsd: elapsedH * pickPrice,
        success: exitCode === 0, budgetExceeded,
        startedAt: new Date(t0).toISOString(),
        endedAt: new Date().toISOString(),
        main: opts.main.slice(0, 200),
      });
      try { unlinkSync(jobStatePath()); } catch { /* ignore */ }
    }
  }

  console.log(`\n${exitCode === 0 ? c.green + '✓ Job completed' : c.red + '✗ Job failed'}${c.reset}`);
  console.log(`  output: ${outputDir}`);
  process.exit(exitCode);
}

// ── jobs ssh / sync / pull / exec / cleanup — operate on saved last_job state ──
function requireJobState(): Record<string, unknown> {
  const s = loadJobState();
  if (!s) {
    console.error(`No saved job state. Run 'ai-gateway gpu jobs run ...' first.`);
    process.exit(1);
  }
  return s;
}

async function cmdGpuJobsSsh(extraCmd?: string): Promise<void> {
  const s = requireJobState();
  const args = ['-p', String(s.sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                '-o', 'LogLevel=ERROR', `root@${s.sshHost}`];
  if (extraCmd) args.push(extraCmd);
  const r = spawnSync('ssh', args, { stdio: 'inherit' });
  process.exit(r.status || 0);
}

async function cmdGpuJobsSync(localOverride?: string): Promise<void> {
  const s = requireJobState();
  const local = localOverride || (s.localPath as string | null);
  if (!local) {
    console.error(`No localPath in saved state. Pass <local-dir> as positional arg.`);
    process.exit(1);
  }
  console.log(`rsync ${local} → ${s.sshHost}:/workspace`);
  const r = spawnSync('rsync', ['-az', '--delete', '-e',
    `ssh -p ${s.sshPort} -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR`,
    `${(local as string).replace(/\/$/, '')}/`, `root@${s.sshHost}:/workspace/`,
  ], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

async function cmdGpuJobsPull(localOverride?: string): Promise<void> {
  const s = requireJobState();
  const local = localOverride || (s.output as string);
  mkdirSync(local, { recursive: true });
  console.log(`rsync ${s.sshHost}:/workspace/ → ${local}`);
  const r = spawnSync('rsync', ['-az', '-e',
    `ssh -p ${s.sshPort} -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR`,
    `root@${s.sshHost}:/workspace/`, `${local}/`,
  ], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

async function cmdGpuJobsExec(cmd: string): Promise<void> {
  const s = requireJobState();
  const r = spawnSync('ssh', ['-p', String(s.sshPort),
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR',
    `root@${s.sshHost}`, `cd /workspace && ${cmd}`], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

async function cmdGpuJobsCleanup(force: boolean): Promise<void> {
  const s = loadJobState();
  if (!s) { console.log('No saved job state.'); return; }
  const { url, key } = getConfig();
  if (!force) {
    console.log(`About to terminate ${s.instanceId} (${s.sshHost}). Re-run with --force to confirm.`);
    return;
  }
  console.log(`Terminating ${s.instanceId}...`);
  const r = await fetch(`${url}/v1/gpu/terminate`, {
    method: 'POST', headers: headers(key),
    body: JSON.stringify({ instanceId: s.instanceId, deployId: s.deployId }),
  });
  if (r.ok) {
    console.log(`  ${c.green}✓${c.reset} terminated`);
    try { unlinkSync(jobStatePath()); } catch { /* ignore */ }
  } else {
    console.error(`  ${c.red}terminate may have failed (HTTP ${r.status})${c.reset}`);
  }
}

// gpu train: high-level finetune/training wrapper. Composes 'jobs run' with
// sensible ML defaults: spot instances, budget cap, mid-pull, auto-resume,
// pull excludes for cache/dataset, optional HF push of final checkpoints.
interface GpuTrainOpts {
  scriptPath: string;             // local python file or directory
  dataset?: string;               // hf://repo-id  (downloaded to /root/data)
  datasetInclude?: string;        // hf download --include glob (e.g. "wav/*")
  noHfTransfer?: boolean;         // disable HF_HUB_ENABLE_HF_TRANSFER (avoid 429 on small-file datasets)
  model?: string;                 // hf://repo-id  (downloaded to /root/model)
  epochs?: number;
  lr?: number;
  gpu?: string;
  maxCost?: number;
  maxSpend?: number;
  output?: string;
  pushToHf?: string;              // hf-repo to upload checkpoints
  autoResume?: boolean;
  preferSpot?: boolean;
  reuse?: boolean;
  extraArgs?: string;             // appended to the python script command
  dryRun?: boolean;
  image?: string;                 // override docker image (default: marcosremar/gpu-dev:latest)
}
// ──────────────────────────────────────────────────────────────────────────
// gpu finetune — generic finetune module (text or audio).
// Composes 'jobs run' with workload-specific defaults:
//   - apt + pip presets per type
//   - HF dataset/model download (filter, no-transfer)
//   - encode stage (audio): multi-GPU shard encoder when --num-gpus > 1
//   - train stage with --resume + checkpoint loop
//   - HF push final ckpt
//   - spot + budget cap + auto-keep-alive on error (defaults from jobs run)
// ──────────────────────────────────────────────────────────────────────────
interface GpuFinetuneOpts {
  type: 'text' | 'audio' | 'custom';
  project?: string;             // project name → resolves preset + injects defaults
  localPath?: string;           // dir to rsync (default = dirname(scriptPath))
  scriptPath: string;
  dataset?: string;             // hf://repo-id
  datasetInclude?: string;
  noHfTransfer?: boolean;
  model?: string;               // hf://repo-id
  prepCmd?: string;             // optional pre-encode step (e.g. resolve paths, convert tags)
  encodeCmd?: string;           // optional override (default: <script> encode --input ... --output ...)
  trainCmd?: string;            // optional override (default: <script> train --tokens ... --output ...)
  epochs?: number;
  lr?: number;
  numGpus?: number;             // shards encoding across N GPUs (uses encode_multi_gpu.sh if available)
  maxSamples?: number;          // cap on encode + train rows (honored unless smokeOnly forces 30)
  gpu?: string;
  maxCost?: number;
  maxSpend?: number;
  output?: string;
  pushToHf?: string;
  autoResume?: boolean;
  preferSpot?: boolean;
  selectMode?: 'cheapest' | 'balanced' | 'fast'; // offer ranking (default balanced); all obey maxCost ceiling
  reuse?: boolean;
  r2Bucket?: string;            // R2/S3 bucket for durable dataset+ckpt storage (spot-resume)
  r2Prefix?: string;            // stable prefix/folder (default jobs/<project|type>) — ties data to the run
  resumeFromR2?: boolean;       // on (re)start, restore /workspace/checkpoints from R2 and --resume
  extraTrainArgs?: string;
  extraDeps?: string;           // extra pip packages
  aptPkgs?: string;             // extra apt-get packages
  dryRun?: boolean;
  smoke?: boolean;              // ONLY run smoke (30 samples × 3 epochs) — useful for testing pipeline
  skipSmoke?: boolean;          // skip mandatory pre-full smoke step (advanced; default smoke ON)
  persistCache?: boolean;       // #9 mount persistent volume for HF cache (skip re-download $$)
  retryOnPreempt?: number;      // #10 if spot preempted, re-deploy and resume from latest ckpt up to N times
  incremental?: boolean;        // #14 hash dataset; if unchanged from last run, skip encode + resume from last ckpt
  autoFix?: boolean;            // #2 on smoke failure, run KNOWN_BUGS lookup + suggest/apply fix + retry
  plugin?: string;              // #12 named plugin (lora|qlora|grad-ckpt|flash-attn)
  watchWer?: string;            // #7 path to eval_holdout.json — runs WER eval every 10min in background
  webDashboard?: boolean;       // #13 open local web dashboard (stub)
  // — Round 4: ideas from Axolotl/SkyPilot/Unsloth —
  wandb?: { project: string; entity?: string; runName?: string; logModel?: 'checkpoint'|'end'|'none' };
  notifyOnComplete?: string;    // webhook URL to POST {status, runId, ckpt, finalLoss}
  secrets?: Record<string, string>;  // sensitive env vars (redacted in logs/state)
  providers?: string[];         // multi-cloud failover order: ['vast', 'runpod']
  failoverOnPreempt?: boolean;  // try next provider if current preempts
  evalsPerEpoch?: number;       // run eval N times per epoch (cadence)
  earlyStopOnEval?: { metric: string; threshold: number }; // stop if metric < threshold
  multiDataset?: Array<{ path: string; weight: number }>; // weighted multi-dataset
  ckptAverage?: number;         // average last N checkpoints into final (Polyak/EMA)
  exportGguf?: boolean;         // post-train: convert ckpt to GGUF for llama.cpp
  // Round 6 — 3-repo HF organization
  hfBase?: string;              // owner/name → derives -dataset, -weights, -code repos
  hfStructure?: 'flat' | 'split' | 'tri';  // flat=1 repo (legacy), split=2 (data+weights), tri=3 (+code)
  fromHf?: string;              // resume: auto-fetch all 3 repos (encoded.pt, weights, code)
  // Round 8 — quality automation
  quality?: 'auto' | 'safe' | 'fast';   // auto=smart defaults, safe=conservative, fast=aggressive
  autoStopPlateau?: number;     // override: stop train if no loss improvement for N steps
  torchCompile?: boolean;       // override: torch.compile flow_net (1.5-2× speedup)
  augmentPitch?: boolean;       // override: pitch-shift ±2 semitones (doubles encode dataset)
  augmentSpeed?: boolean;       // override: speed-perturb 0.9-1.1× (doubles encode dataset)
  saveEverySteps?: number;      // checkpoint cadence (default 100; 5 in smoke)
  image?: string;               // override docker image (default: aigw-finetune-base if published, else gpu-dev)
  // Tier 2 — advanced (default sane via quality:auto; expose for power users)
  batchSize?: number;           // micro-batch size (default 2)
  gradAccum?: number;           // gradient accumulation steps (default 16)
  weightDecay?: number;         // AdamW weight decay (default 0.01)
  warmupSteps?: number;         // LR warmup steps (default 200)
  freezeBackboneLayers?: number;  // freeze first N transformer blocks (default 4)
  onlyFlowNet?: boolean;        // MoshiVis-style: train ONLY flow_net + out_eos (LoRA-like)
  curriculum?: 'linear' | '';   // curriculum strategy (default '': random shuffle)
  seed?: number;                // random seed (reproducibility, default 42)
  gradClip?: number;            // gradient norm clip threshold (default 1.0)
  logEverySteps?: number;       // print loss every N steps (default 25)
}
// Schema validation, cost estimation, and run history all delegate to the
// gpu-finetune module. These thin wrappers keep call-sites below readable.
function validateFinetuneSpec(spec: Partial<FinetuneOpts>): string[] {
  return validateSpec(spec).errors;
}

function estimateFinetuneCost(opts: Partial<FinetuneOpts>, sampleCount = 7449, gpuPrice = 0.30) {
  return estimateCost(opts, sampleCount, gpuPrice);
}

function finetuneStateStore(): FileFinetuneState {
  return new FileFinetuneState(join(process.env.HOME || '/tmp', '.babelcast', 'finetune_runs'));
}

function recordFinetuneRun(spec: Partial<FinetuneOpts>, instanceInfo: Record<string, unknown>): string {
  const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  finetuneStateStore().save({ id, ts: new Date().toISOString(), spec, instance: instanceInfo });
  return id;
}

// Live fail-fast checks (HF reachability, token write-access, R2 creds, script)
// before any GPU spend. Prints a one-line-per-check report. Returns the result
// so callers decide whether to abort (submit) or just report (validate).
async function runFinetunePreflight(spec: Partial<FinetuneOpts>): Promise<PreflightResult> {
  const result = await preflightChecks(spec, process.env);
  for (const ch of result.checks) {
    const icon = ch.status === 'ok' ? `${c.green}✓${c.reset}`
      : ch.status === 'warn' ? `${c.yellow}!${c.reset}`
      : `${c.red}✗${c.reset}`;
    console.log(`  ${icon} ${ch.name}: ${ch.detail}`);
  }
  return result;
}

// gpu finetune compare — A/B WER test multiple ckpts via Whisper roundtrip.
// Delegates to src/modules/gpu-finetune/compare.ts.
async function cmdGpuFinetuneCompare(opts: {
  ckpts: string[]; prompts: string; max?: number; whisperModel?: string;
}): Promise<void> {
  if (opts.ckpts.length < 1) { console.error('Need ≥1 --ckpt path'); process.exit(1); }
  if (!existsSync(opts.prompts)) { console.error(`Prompts not found: ${opts.prompts}`); process.exit(1); }
  console.log(`[compare] ${opts.ckpts.length} ckpts × ${opts.max || 'all'} prompts`);
  try {
    const result = runCompare(opts);
    if (result.winner) {
      console.log(`\n[compare] winner=${result.winner}  avgWER=${result.winnerAvgWer.toFixed(3)}`);
    }
  } catch (e) {
    console.error(`[compare] failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * Thin CLI shell — delegates status parsing to src/gpu-finetune/status.ts.
 * SSH probe is still run here (CLI lives near the SSH session); only the
 * parse/detect/render logic is shared with the module.
 */
async function cmdGpuFinetuneStatus(): Promise<void> {
  const s = loadJobState();
  if (!s) { console.log('No saved finetune state.'); return; }
  const sshArgs = ['-p', String(s.sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'LogLevel=ERROR', `root@${s.sshHost}`];

  // Pick probe paths from preset manifest if the saved run used one.
  const presetType = (s.spec as Record<string, unknown> | undefined)?.type as string | undefined;
  const preset = presetType ? loadPreset(presetType) : undefined;
  const probeCmd = buildProbeCommand(preset?.manifest?.probePaths);
  const probe = spawnSync('ssh', [...sshArgs, probeCmd], { encoding: 'utf-8', timeout: 20_000 });

  const out = probe.stdout || '';
  const probeOut = parseProbeOutput(out);
  const status = buildStatusResult(probeOut, {
    instanceId: s.instanceId as string,
    gpuType: (s.gpuType as string) || '',
    provider: (s.provider as string) || '',
    pricePerHr: (s.pricePerHr as number) ?? 0,
    startedAt: s.startedAt as string,
  }, preset?.manifest?.stagePatterns);

  console.log(`\n${c.bold}═══ gpu finetune status ═══${c.reset}`);
  console.log(`${c.dim}instance:${c.reset} ${status.instanceId}  ${status.gpuType} on ${status.provider} @ $${status.pricePerHr.toFixed(3)}/h`);
  console.log(`${c.dim}elapsed: ${c.reset} ${status.elapsedMin.toFixed(1)}min   ${c.dim}spent:${c.reset} $${status.spent.toFixed(3)}`);
  console.log(`${c.dim}stage:   ${c.reset} ${c.cyan}${status.stage}${c.reset}${status.stageDetail ? '   ' + c.dim + status.stageDetail + c.reset : ''}`);

  if (status.vramTotalGb > 0) {
    const vramPct = (status.vramUsedGb / status.vramTotalGb) * 100;
    console.log(`${c.dim}gpu:     ${c.reset} ${status.gpuPct.toFixed(0)}% util   VRAM ${status.vramUsedGb.toFixed(1)}/${status.vramTotalGb.toFixed(0)}GB (${vramPct.toFixed(0)}%)`);
  }

  if (status.wavCached > 0) console.log(`${c.dim}files:   ${c.reset} ${status.wavCached} wavs cached`);
  if (status.checkpoints.length > 0) console.log(`${c.dim}ckpts:   ${c.reset} ${status.checkpoints.join(', ').slice(0, 100)}`);

  if (status.recentLoss.length > 0) {
    console.log(`${c.dim}log:     ${c.reset}`);
    for (const ln of status.recentLoss.slice(-5)) console.log(`           ${ln}`);
  }
  console.log('');
}

// #15 Auto-deploy: push checkpoint to HF + (optional) hot-swap local server via env
async function cmdGpuFinetuneDeploy(opts: {
  ckpt?: string; hfRepo?: string; hfFile?: string; pushTo?: string; restartServer?: boolean;
}): Promise<void> {
  let envBlock = '';
  if (opts.hfRepo) {
    // Server side: env vars trigger HF auto-download + cache
    envBlock = `IARATTS_HF_REPO='${opts.hfRepo}'`;
    if (opts.hfFile) envBlock += ` IARATTS_HF_FILE='${opts.hfFile}'`;
    console.log(`Deploy via HF auto-download:`);
    console.log(`  ${envBlock} python iaratts/web/pocket_tts_server.py`);
  } else if (opts.ckpt) {
    if (!existsSync(opts.ckpt)) { console.error(`Ckpt not found: ${opts.ckpt}`); process.exit(1); }
    if (opts.pushTo) {
      console.log(`pushing ${opts.ckpt} → hf://${opts.pushTo}...`);
      const r = spawnSync('hf', ['upload', opts.pushTo, opts.ckpt, '--repo-type', 'model'],
                          { stdio: 'inherit' });
      if (r.status !== 0) { console.error('hf upload failed'); process.exit(1); }
    }
    envBlock = `IARATTS_CKPT='${resolve(opts.ckpt)}'`;
    console.log(`Local deploy:`);
    console.log(`  ${envBlock} python iaratts/web/pocket_tts_server.py`);
  } else {
    console.error('Need --ckpt <path> OR --hf-repo <owner/name>');
    process.exit(1);
  }

  if (opts.restartServer) {
    // Find + kill running pocket_tts_server.py
    const findRes = spawnSync('pgrep', ['-f', 'pocket_tts_server.py'], { encoding: 'utf-8' });
    const pids = (findRes.stdout || '').trim().split('\n').filter(Boolean);
    if (pids.length === 0) {
      console.log('  (no running server to restart)');
    } else {
      console.log(`  killing existing server PIDs: ${pids.join(', ')}`);
      for (const pid of pids) spawnSync('kill', [pid]);
    }
    console.log(`  starting new server with new env...`);
    spawnSync('bash', ['-c', `${envBlock} nohup python iaratts/web/pocket_tts_server.py > /tmp/iaratts_server.log 2>&1 &`],
              { stdio: 'inherit' });
    console.log(`  ✓ server restarting (log: /tmp/iaratts_server.log)`);
  }
}

// #3 Dataset auto-validation (local pre-flight)
function validateDatasetLocal(jsonlPath: string, type: 'audio' | 'text' | 'custom'): string[] {
  const errs: string[] = [];
  if (!existsSync(jsonlPath)) { errs.push(`dataset file not found: ${jsonlPath}`); return errs; }
  const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter((l) => l.trim());
  if (lines.length < 100) errs.push(`only ${lines.length} samples (<100, too small)`);
  let badRows = 0; let tagged = 0;
  for (let i = 0; i < Math.min(lines.length, 100); i++) {
    try {
      const r = JSON.parse(lines[i]);
      if (type === 'audio' && !r.audio) badRows++;
      if (type === 'text' && !r.text) badRows++;
      if (r.tag_positions?.length > 0) tagged++;
    } catch { badRows++; }
  }
  if (badRows > 5) errs.push(`${badRows}/100 rows malformed (missing required fields)`);
  console.log(`[validate] ${lines.length} rows total, ${tagged}/100 sample have tags`);
  return errs;
}

// #1 LR finder — runs N mini-trains with different LR, picks lowest-loss
async function cmdGpuFinetuneLrFind(opts: GpuFinetuneOpts & { lrs?: number[] }): Promise<void> {
  const lrs = opts.lrs || [1e-6, 5e-6, 1e-5, 5e-5, 1e-4, 5e-4];
  console.log(`[lr-find] testing ${lrs.length} LRs: ${lrs.join(', ')}`);
  console.log(`[lr-find] each is a smoke run (~5min × ${lrs.length} = ${lrs.length * 5}min, ~$${(lrs.length * 0.025).toFixed(2)})`);
  console.log(`[lr-find] (TODO: parallel sweep via #8 sweep — currently sequential)`);
  const results: { lr: number; finalLoss: number }[] = [];
  for (const lr of lrs) {
    console.log(`\n[lr-find] testing lr=${lr}`);
    // Each call runs smoke, captures final loss from log
    await cmdGpuFinetune({ ...opts, lr, smoke: true, dryRun: opts.dryRun });
    // (parsing final loss from .job.log left as exercise)
    results.push({ lr, finalLoss: NaN });
  }
  console.log('\n[lr-find] results:');
  for (const r of results) console.log(`  lr=${r.lr.toExponential(1)}  final_loss=${r.finalLoss}`);
}

// #14 Incremental finetune — hash dataset, compare with last run, skip re-encode if same
function datasetHash(jsonlPath: string): string {
  if (!existsSync(jsonlPath)) return '';
  const content = readFileSync(jsonlPath, 'utf-8');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// #2 Auto-fix lookup — pattern-match common errors → suggested fix
const KNOWN_BUGS: Array<{ re: RegExp; fix: string; auto?: string }> = [
  { re: /pkg-config.*not found/i, fix: 'Add libsentencepiece-dev to apt deps', auto: 'extraAptPkgs="libsentencepiece-dev"' },
  { re: /unbound variable.*HF_TOKEN/i, fix: 'HF_TOKEN env not exported in main', auto: 'finetune now embeds HF_TOKEN automatically' },
  { re: /assert ldim == flow_lm\.ldim/i, fix: 'Mimi encode dim mismatch — use mimi.encode_to_latent', auto: '' },
  { re: /mat1 and mat2.*BFloat16/i, fix: 'Cast to model dtype, not .float()', auto: '' },
  { re: /CUDA out of memory/i, fix: 'Reduce micro_batch_size or grad_accum, enable grad_checkpoint', auto: 'extraTrainArgs="--micro-batch-size 1"' },
  { re: /HTTP Error 429/i, fix: 'HF rate limit — disable hf_transfer + use --include filter', auto: 'noHfTransfer=true' },
];
function diagnoseError(logTail: string): { bug: typeof KNOWN_BUGS[0]; line: string } | null {
  for (const ln of logTail.split('\n')) {
    for (const b of KNOWN_BUGS) {
      if (b.re.test(ln)) return { bug: b, line: ln };
    }
  }
  return null;
}

// #7 WER eval in background — generate sample + Whisper transcribe + log WER
// Stub: full impl would spawn ssh worker that runs every N steps
function buildWerEvalCmd(scriptDir: string, evalPrompts: string): string {
  return `(while true; do sleep 600; ` +
    `LATEST=$(ls -t /workspace/checkpoints/step-*.safetensors 2>/dev/null | head -1); ` +
    `if [ -n "$LATEST" ]; then ` +
    `python ${scriptDir}/eval_finetune.py --checkpoint "$LATEST" --prompts ${evalPrompts} ` +
    `--output-dir /workspace/wer_eval --max 5 2>&1 | tee -a /workspace/wer.log; fi; done) & `;
}

// #8 Optuna sweep — parallel hyperparam search via N spot instances
async function cmdGpuFinetuneSweep(opts: GpuFinetuneOpts & { trials?: number }): Promise<void> {
  if (!opts.scriptPath && !opts.type) {
    console.error(
      `gpu finetune sweep: missing required input. Provide one of:\n` +
      `  • -f <train.yaml>          (or place ./train.yaml in cwd)\n` +
      `  • --type <preset>          (e.g. flow-matching-tts)\n` +
      `  • --script <trainer.py>    (custom trainer)`
    );
    process.exit(1);
  }
  const trials = opts.trials ?? 4;
  console.log(`[sweep] launching ${trials} parallel finetune trials with hyperparam variants`);
  // Generate trial configs varying lr, epochs, freeze layers
  const lrs = [1e-5, 3e-5, 5e-5, 1e-4];
  const procs: ChildProcess[] = [];
  for (let i = 0; i < trials; i++) {
    const lr = lrs[i % lrs.length];
    const trialId = `trial-${i}-lr${lr.toExponential(0)}`;
    console.log(`[sweep] launching ${trialId}`);
    // Spawn separate finetune subprocess. Prefer preset type when given so
    // children re-resolve through loadPreset (vs. carrying an absolute path
    // that may not exist in their cwd).
    const launchArgs = ['gpu', 'finetune', 'submit', '--lr', String(lr), '--smoke',
                        '--output', `./sweeps/${trialId}`];
    if (opts.type) launchArgs.push('--type', opts.type);
    else if (opts.scriptPath) launchArgs.push('--script', opts.scriptPath);
    const child = spawn(process.argv[0], [process.argv[1], ...launchArgs], { stdio: 'inherit' });
    procs.push(child);
  }
  console.log(`[sweep] ${procs.length} trials launched. Wait + compare losses.`);
  console.log(`[sweep] (TODO: parse final losses + auto-pick best, push winner to HF)`);
}

// Plugins (LoRA / QLoRA / grad-ckpt / flash-attn) live in
// src/modules/gpu-finetune/types.ts:BUNDLED_PLUGINS — single source of truth.
// `loadPreset` and `listPresets` are imported from the module.

// Web dashboard stub — opens browser with URL
async function cmdGpuFinetuneWatchWeb(): Promise<void> {
  console.log(`Web dashboard not yet built. (TODO: serve /workspace/.job.log via http on local port + chart.js loss plot)`);
  console.log(`For now, use: ai-gateway gpu jobs watch  (terminal dashboard with bars + log tail)`);
}

/**
 * Thin CLI shell over FinetuneGateway (src/gpu-finetune).
 * All orchestration logic lives in the module; the CLI only:
 *   - parses args into FinetuneOpts
 *   - injects jobRunner + probe adapters that bridge to cmdGpuJobsRun / SSH
 *   - calls gateway.run() and surfaces the result
 */
async function cmdGpuFinetune(opts: GpuFinetuneOpts): Promise<void> {
  const preset = loadPreset(opts.type);
  if (!preset && !opts.scriptPath) {
    console.error(
      `gpu finetune: missing required input. Provide one of:\n` +
      `  • --spec <train.yaml>           (or place ./train.yaml in cwd)\n` +
      `  • --type <preset>               (e.g. flow-matching-tts)\n` +
      `  • --script <path/to/trainer.py> (custom trainer)`
    );
    process.exit(1);
  }

  const checks = runNumericChecks(opts as Partial<FinetuneOpts>);
  for (const r of checks) {
    if (!r.ok) {
      console.error(`gpu finetune: invalid ${r.name}=${r.value} (expected ${r.lo}..${r.hi})`);
      process.exit(1);
    }
  }

  if (opts.dataset && !opts.dataset.startsWith('hf://')) {
    console.error(`--dataset must use hf://<repo-id> form`); process.exit(1);
  }
  if (opts.model && !opts.model.startsWith('hf://')) {
    console.error(`--model must use hf://<repo-id> form`); process.exit(1);
  }

  // jobRunner: cmdGpuJobsRun has side-effects (saves job state, prints to stdout)
  // and returns void. Read loadJobState() AFTER the call to recover real metadata.
  const jobRunner: GpuJobRunner = {
    async run(rOpts) {
      await cmdGpuJobsRun({
        path: rOpts.path,
        main: rOpts.main,
        gpu: rOpts.gpu,
        maxCost: rOpts.maxCost,
        maxSpend: rOpts.maxSpend,
        output: rOpts.output,
        timeoutMin: rOpts.timeoutMin,
        bootTimeoutMin: rOpts.bootTimeoutMin,
        image: rOpts.image,
        provider: rOpts.provider,
        keepAlive: false,
        terminateOnError: true,
        pullEveryMin: rOpts.pullEveryMin,
        stallMin: rOpts.stallMin,
        pullExclude: rOpts.pullExclude,
        preferSpot: rOpts.preferSpot,
        reuseInstance: rOpts.reuseInstance,
        abortOnDivergence: rOpts.abortOnDivergence,
        gpuFallback: rOpts.gpuFallback,
        dryRun: rOpts.dryRun,
      });
      const s = loadJobState();
      return {
        instanceId: (s?.instanceId as string) || '',
        sshHost: (s?.sshHost as string) || '',
        sshPort: (s?.sshPort as number) ?? 0,
        gpuType: (s?.gpuType as string) || rOpts.gpu,
        provider: (s?.provider as string) || '',
        pricePerHr: (s?.pricePerHr as number) ?? rOpts.maxCost,
        startedAt: (s?.startedAt as string) || new Date().toISOString(),
      };
    },
  };

  const probePathsFromPreset = preset?.manifest?.probePaths;
  const probe: FinetuneProbe = {
    async probe(meta) {
      const s = loadJobState();
      const sshHost = (s?.sshHost as string) || meta.sshHost;
      const sshPort = (s?.sshPort as number) ?? meta.sshPort;
      if (!sshHost) return '';
      const sshArgs = [
        '-p', String(sshPort),
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'LogLevel=ERROR',
        `root@${sshHost}`,
      ];
      const cmd = buildProbeCommand(probePathsFromPreset);
      const result = spawnSync('ssh', [...sshArgs, cmd], { encoding: 'utf-8', timeout: 20_000 });
      return result.stdout || '';
    },
  };

  const gateway = new FinetuneGateway({
    stateStore: finetuneStateStore(),
    hfToken: new EnvHfTokenResolver(),
    jobRunner,
    probe,
    log: {
      debug: (...a: unknown[]) => { if (process.env.DEBUG) console.log(...a); },
      log: (...a: unknown[]) => console.log(...a),
      warn: (...a: unknown[]) => console.warn(...a),
      error: (...a: unknown[]) => console.error(...a),
    },
  });

  const skipSmoke = opts.skipSmoke === true;
  const smokeOnly = !!opts.smoke;
  if (skipSmoke && !smokeOnly) {
    console.warn(`${c.yellow}⚠ smoke step skipped (--no-smoke / skipSmoke: true).${c.reset} ` +
                 `Pipeline bugs will only surface during the full run — could waste GPU $$. ` +
                 `Recommend keeping smoke ON unless debugging a specific pipeline issue.`);
  }
  if (smokeOnly && opts.epochs && opts.epochs !== 3) {
    console.warn(`${c.yellow}⚠ smoke mode forces epochs=3 (your epochs=${opts.epochs} ignored).${c.reset}`);
  }

  // Auto-resubmit (spot-resume controller): vast.ai spot pods evict randomly.
  // On a transient pod death we redeploy and resume from the last checkpoint —
  // from R2 when r2Bucket is set (durable, full optimizer state), else HF.
  // Budget is accumulated ACROSS restarts (spot-resume.ts) so a flapping job
  // can't blow past maxSpend; non-eviction errors stop immediately.
  const maxAttempts = opts.retryOnPreempt && opts.retryOnPreempt > 0
    ? Math.min(20, opts.retryOnPreempt + 1)
    : 5;
  const jobId = deriveJobId(opts);
  let budget = loadBudget(jobId);
  if (budget.totalSpentUsd > 0 || budget.attempts > 0) {
    process.stderr.write(`${c.dim}[finetune] job '${jobId}' prior spend $${budget.totalSpentUsd.toFixed(2)} over ${budget.attempts} attempt(s)${c.reset}\n`);
  }
  const maxSpend = typeof opts.maxSpend === 'number' ? opts.maxSpend : 0;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // Force R2 resume on restarts so the fresh pod continues from the last
      // checkpoint even if the first attempt started clean.
      if (opts.r2Bucket) (opts as FinetuneOpts).resumeFromR2 = true;
      else (opts as FinetuneOpts).autoResume = true;
      const via = opts.r2Bucket ? `R2 (${jobId})` : 'HF';
      process.stderr.write(`\n${c.yellow}[finetune] auto-resubmit ${attempt}/${maxAttempts} — resuming from ${via} checkpoint (spent $${budget.totalSpentUsd.toFixed(2)}${maxSpend > 0 ? `/$${maxSpend.toFixed(2)}` : ''})${c.reset}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
    const attemptStart = new Date().toISOString();
    try {
      const result = await gateway.run(opts as FinetuneOpts);
      const spend = attemptSpendUsd({
        pricePerHr: result.pricePerHr || 0,
        startedAt: result.startedAt || attemptStart,
        endedAt: new Date().toISOString(),
      });
      budget = addAttempt(budget, spend, new Date().toISOString());
      saveBudget(budget);
      console.log(`[finetune] submitted — instanceId=${result.instanceId || '(see job state)'}  gpu=${result.gpuType}  $${result.pricePerHr}/h  cumSpend=$${budget.totalSpentUsd.toFixed(2)}`);
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err instanceof Error ? err.message : err);
      // Account this attempt's spend from persisted job state (pricePerHr/startedAt).
      const s = loadJobState();
      const spend = attemptSpendUsd({
        pricePerHr: (s?.pricePerHr as number) || 0,
        startedAt: (s?.startedAt as string) || attemptStart,
        endedAt: new Date().toISOString(),
      });
      budget = addAttempt(budget, spend, new Date().toISOString());
      saveBudget(budget);
      const decision = decideRetry({
        isEviction: isEvictionError(msg),
        attempt,
        maxAttempts,
        totalSpentUsd: budget.totalSpentUsd,
        maxSpend,
      });
      process.stderr.write(`  [finetune] attempt ${attempt} failed: ${msg}\n  → ${decision.reason}\n`);
      if (!decision.retry) throw err;
    }
  }
  throw lastErr;
}

async function cmdGpuTrain(opts: GpuTrainOpts): Promise<void> {
  if (!existsSync(opts.scriptPath)) {
    console.error(`Script not found: ${opts.scriptPath}`);
    process.exit(1);
  }
  // Validate HF refs early (catch typos before paying for GPU)
  if (opts.dataset && !opts.dataset.startsWith('hf://')) {
    console.error(`--dataset must use hf://<repo-id> form (got: ${opts.dataset})`);
    process.exit(1);
  }
  if (opts.model && !opts.model.startsWith('hf://')) {
    console.error(`--model must use hf://<repo-id> form (got: ${opts.model})`);
    process.exit(1);
  }
  if (opts.pushToHf && !opts.pushToHf.includes('/')) {
    console.error(`--push-to-hf must be 'owner/repo' form`);
    process.exit(1);
  }
  if (!process.env.HF_TOKEN && !existsSync(`${process.env.HOME}/.cache/huggingface/token`)) {
    console.error(`HF_TOKEN env not set and ~/.cache/huggingface/token missing.`);
    console.error(`  Run: huggingface-cli login`);
    process.exit(1);
  }
  const epochs = opts.epochs ?? 4;
  const lr = opts.lr ?? 5e-5;
  const output = opts.output || './checkpoints/run-' + Date.now();
  // Comma-separated globs map to multiple --include flags (hf download
  // accepts the flag repeatedly but no commas in a single value).
  const dsInclude = opts.datasetInclude
    ? opts.datasetInclude.split(',').map(p => ` --include "${p.trim()}"`).join('')
    : '';
  const datasetDl = opts.dataset?.startsWith('hf://')
    ? `hf download ${opts.dataset.slice(5)} --repo-type dataset --local-dir /root/data --token "$HF_TOKEN"${dsInclude} && `
    : '';
  const modelDl = opts.model?.startsWith('hf://')
    ? `hf download ${opts.model.slice(5)} --local-dir /root/model --token "$HF_TOKEN" && `
    : '';
  const scriptName = opts.scriptPath.replace(/\/$/, '').split('/').pop()!;
  const resumeFlag = opts.autoResume ? '--resume /workspace/checkpoints' : '';
  const pushUp = opts.pushToHf
    ? ` && hf upload ${opts.pushToHf} /workspace/checkpoints --repo-type model --token "$HF_TOKEN"`
    : '';
  const main = [
    'set -euo pipefail',
    `export ${opts.noHfTransfer ? '' : 'HF_HUB_ENABLE_HF_TRANSFER=1 '}DEBIAN_FRONTEND=noninteractive`,
    'apt-get update -qq && apt-get install -y -qq pkg-config build-essential libsentencepiece-dev',
    'pip install --quiet --prefer-binary "huggingface-hub>=1.0.0" hf_transfer torch torchaudio safetensors soundfile',
    `${datasetDl}${modelDl}true`,
    'mkdir -p /workspace/checkpoints',
    `python ${scriptName} train --output /workspace/checkpoints --epochs ${epochs} --learning-rate ${lr} ${resumeFlag} ${opts.extraArgs || ''}${pushUp}`,
  ].join(' && ');

  await cmdGpuJobsRun({
    path: opts.scriptPath.endsWith('/') || existsSync(opts.scriptPath) && require('fs').statSync(opts.scriptPath).isDirectory()
      ? opts.scriptPath
      : require('path').dirname(opts.scriptPath),
    main,
    gpu: opts.gpu || '4090',
    maxCost: opts.maxCost ?? 0.4,
    maxSpend: opts.maxSpend ?? 5.00,            // safety net
    output,
    timeoutMin: 360,
    image: opts.image || 'marcosremar/gpu-dev:latest',
    keepAlive: false,
    pullEveryMin: 10,
    stallMin: 30,
    pullExclude: ['data/', 'model/', 'wav/'], // skip raw dataset; checkpoints (.pt) ARE pulled
    preferSpot: opts.preferSpot ?? false,
    selectMode: opts.selectMode,
    reuseInstance: opts.reuse ?? false,
    dryRun: opts.dryRun,
  });
}

async function cmdGpuJobsStatus(): Promise<void> {
  const s = loadJobState();
  if (!s) { console.log('No saved job state.'); return; }
  console.log(JSON.stringify(s, null, 2));
}

// Pull live resource metrics from the saved instance: GPU%, VRAM, RAM,
// disk usage on /workspace, cumulative network rx/tx bytes (eth-like ifaces).
// Returns parsed object; logs nothing.
function fetchInstanceMetrics(s: Record<string, unknown>): {
  gpuPct: number; vramUsedMb: number; vramTotalMb: number;
  ramUsedMb: number; ramTotalMb: number;
  diskPct: number; diskUsedGb: number; diskTotalGb: number;
  netRxBytes: number; netTxBytes: number;
  raw: string;
} | null {
  const sshArgs = ['-p', String(s.sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'LogLevel=ERROR', `root@${s.sshHost}`];
  const cmd = [
    `gpu=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')`,
    `ram=$(free -m | awk '/^Mem:/{print $3","$2}')`,
    `disk=$(df -B1G /workspace 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $3","$2","$5}')`,
    `net=$(awk '/eth|ens|enp|wlp/ {rx+=$2; tx+=$10} END {print rx","tx}' /proc/net/dev)`,
    `printf "%s|%s|%s|%s\\n" "$gpu" "$ram" "$disk" "$net"`,
  ].join('; ');
  const r = spawnSync('ssh', [...sshArgs, cmd], { encoding: 'utf-8', timeout: 10_000 });
  const raw = (r.stdout || '').trim();
  const parts = raw.split('|');
  if (parts.length < 4) return null;
  const [gpu, ram, disk, net] = parts;
  const [gpuPct = 0, vramUsedMb = 0, vramTotalMb = 0] = gpu.split(',').map(Number);
  const [ramUsedMb = 0, ramTotalMb = 0] = ram.split(',').map(Number);
  const [diskUsedGb = 0, diskTotalGb = 0, diskPct = 0] = disk.split(',').map(Number);
  const [netRxBytes = 0, netTxBytes = 0] = net.split(',').map(Number);
  return {
    gpuPct, vramUsedMb, vramTotalMb,
    ramUsedMb, ramTotalMb,
    diskPct, diskUsedGb, diskTotalGb,
    netRxBytes, netTxBytes, raw,
  };
}

function renderBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const colorFn = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
  return `${colorFn}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
}
function fmtMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)}MB`;
  return `${(n / 1_073_741_824).toFixed(2)}GB`;
}

async function cmdGpuJobsMetrics(opts: { json?: boolean; windowSec?: number }): Promise<void> {
  const s = requireJobState();
  const windowSec = opts.windowSec ?? 60;          // default: average over 60s
  const sampleEvery = Math.min(5, Math.max(1, Math.floor(windowSec / 12)));
  const samples: { rx: number; tx: number; gpuPct: number; vramUsed: number;
                   ramUsed: number; t: number }[] = [];
  process.stderr.write(`sampling ${windowSec}s (every ${sampleEvery}s)`);
  const tStart = Date.now();
  while ((Date.now() - tStart) < windowSec * 1000) {
    const m = fetchInstanceMetrics(s);
    if (!m) { console.error('\nFailed to fetch metrics. SSH OK?'); process.exit(1); }
    samples.push({ rx: m.netRxBytes, tx: m.netTxBytes, gpuPct: m.gpuPct,
                   vramUsed: m.vramUsedMb, ramUsed: m.ramUsedMb, t: Date.now() });
    process.stderr.write('.');
    if ((Date.now() - tStart) + sampleEvery * 1000 < windowSec * 1000) {
      await new Promise((r) => setTimeout(r, sampleEvery * 1000));
    } else break;
  }
  process.stderr.write('\n');
  const last = samples[samples.length - 1];
  const first = samples[0];
  const dt = (last.t - first.t) / 1000;
  const downBps = dt > 0 ? (last.rx - first.rx) / dt : 0;
  const upBps = dt > 0 ? (last.tx - first.tx) / dt : 0;
  const avgGpu = samples.reduce((a, x) => a + x.gpuPct, 0) / samples.length;
  const avgVram = samples.reduce((a, x) => a + x.vramUsed, 0) / samples.length;
  const avgRam = samples.reduce((a, x) => a + x.ramUsed, 0) / samples.length;
  // Static (size info) — pull current
  const m = fetchInstanceMetrics(s)!;
  const vramPct = m.vramTotalMb ? (avgVram / m.vramTotalMb) * 100 : 0;
  const ramPct = m.ramTotalMb ? (avgRam / m.ramTotalMb) * 100 : 0;
  if (opts.json) {
    console.log(JSON.stringify({
      windowSec: dt.toFixed(1), samples: samples.length,
      gpuAvgPct: avgGpu, vramPct, ramPct, diskPct: m.diskPct,
      vramUsedMb: avgVram, vramTotalMb: m.vramTotalMb,
      ramUsedMb: avgRam, ramTotalMb: m.ramTotalMb,
      diskUsedGb: m.diskUsedGb, diskTotalGb: m.diskTotalGb,
      netDownBpsAvg: downBps, netUpBpsAvg: upBps,
      netRxBytesCum: m.netRxBytes, netTxBytesCum: m.netTxBytes,
    }, null, 2));
    return;
  }
  console.log(`instance: ${s.instanceId} (${s.gpuType} on ${s.provider})`);
  console.log(`window:   ${dt.toFixed(0)}s avg over ${samples.length} samples`);
  console.log(`  GPU   ${renderBar(avgGpu)} ${avgGpu.toFixed(0)}%  (avg)`);
  console.log(`  VRAM  ${renderBar(vramPct)} ${vramPct.toFixed(0)}%  ${fmtMB(Math.round(avgVram))}/${fmtMB(m.vramTotalMb)}`);
  console.log(`  RAM   ${renderBar(ramPct)} ${ramPct.toFixed(0)}%  ${fmtMB(Math.round(avgRam))}/${fmtMB(m.ramTotalMb)}`);
  console.log(`  DISK  ${renderBar(m.diskPct)} ${m.diskPct.toFixed(0)}%  ${m.diskUsedGb}GB/${m.diskTotalGb}GB`);
  console.log(`  NET   ↓ ${fmtBytes(downBps)}/s   ↑ ${fmtBytes(upBps)}/s   (${dt.toFixed(0)}s avg)`);
}

// jobs watch: single-screen live dashboard. Refreshes every <interval>s.
// Combines cost + last log lines + workspace mtime (stall detector).
async function cmdGpuJobsWatch(opts: { interval?: number; lines?: number }): Promise<void> {
  const s = requireJobState();
  const interval = (opts.interval ?? 10) * 1000;
  const lines = opts.lines ?? 8;
  const sshArgs = ['-p', String(s.sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'LogLevel=ERROR', `root@${s.sshHost}`];
  const price = (s.pricePerHr as number) ?? 0;
  const started = new Date(s.startedAt as string).getTime();
  let lastMtime = 0;
  let lastChange = Date.now();
  let prevRx = 0, prevTx = 0, prevTime = Date.now();

  process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    const elapsedH = (Date.now() - started) / 3_600_000;
    const spent = elapsedH * price;
    const stalled = (Date.now() - lastChange) / 60_000;
    const m = fetchInstanceMetrics(s);

    const probe = spawnSync('ssh', [...sshArgs,
      `find /workspace -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1; ` +
      `echo ---; tail -${lines} /workspace/.job.log 2>/dev/null || echo '(no log)'`],
      { encoding: 'utf-8', timeout: 10_000 });
    const out = probe.stdout || '';
    const [mtimeStr, ...rest] = out.split('---');
    const mt = parseFloat((mtimeStr || '0').trim());
    if (Number.isFinite(mt) && mt > lastMtime) { lastMtime = mt; lastChange = Date.now(); }

    const stallTag = stalled > 30
      ? `${c.red}STALLED ${stalled.toFixed(0)}min${c.reset}`
      : `${c.green}healthy${c.reset}`;
    console.log(`${c.bold}gpu jobs watch${c.reset}  ${new Date().toISOString().slice(11, 19)}  (Ctrl+C to exit)`);
    console.log(`─────────────────────────────────────────────────────────────`);
    console.log(`instance:  ${s.instanceId}  (${s.gpuType} on ${s.provider})`);
    console.log(`elapsed:   ${elapsedH.toFixed(2)}h    spent: ${c.yellow}$${spent.toFixed(3)}${c.reset}    @ $${price.toFixed(3)}/h`);
    console.log(`workspace: ${stallTag}    last change: ${stalled.toFixed(1)}min ago`);
    if (m) {
      const vramPct = m.vramTotalMb ? (m.vramUsedMb / m.vramTotalMb) * 100 : 0;
      const ramPct = m.ramTotalMb ? (m.ramUsedMb / m.ramTotalMb) * 100 : 0;
      const dt = (Date.now() - prevTime) / 1000;
      const downBps = prevRx > 0 ? (m.netRxBytes - prevRx) / dt : 0;
      const upBps = prevTx > 0 ? (m.netTxBytes - prevTx) / dt : 0;
      prevRx = m.netRxBytes; prevTx = m.netTxBytes; prevTime = Date.now();
      console.log(`─── resources ────────────────────────────────────────────`);
      console.log(`GPU   ${renderBar(m.gpuPct, 24)} ${m.gpuPct.toFixed(0)}%`);
      console.log(`VRAM  ${renderBar(vramPct, 24)} ${vramPct.toFixed(0)}%   ${fmtMB(m.vramUsedMb)}/${fmtMB(m.vramTotalMb)}`);
      console.log(`RAM   ${renderBar(ramPct, 24)} ${ramPct.toFixed(0)}%   ${fmtMB(m.ramUsedMb)}/${fmtMB(m.ramTotalMb)}`);
      console.log(`DISK  ${renderBar(m.diskPct, 24)} ${m.diskPct.toFixed(0)}%   ${m.diskUsedGb}GB/${m.diskTotalGb}GB`);
      console.log(`NET   ↓ ${fmtBytes(downBps)}/s  ↑ ${fmtBytes(upBps)}/s   ` +
                  `cum ↓${fmtBytes(m.netRxBytes)} ↑${fmtBytes(m.netTxBytes)}`);
    }
    console.log(`─── /workspace/.job.log (last ${lines}) ─────────────────────`);
    console.log(rest.join('---').trim());
  };
  render();
  const t = setInterval(render, interval);
  process.stdin.resume();
  void t;
}

// jobs history: show last N completed jobs from ~/.babelcast/jobs-history.jsonl
async function cmdGpuJobsHistory(opts: { n?: number; json?: boolean; totals?: boolean }): Promise<void> {
  const p = jobHistoryPath();
  if (!existsSync(p)) { console.log('No job history yet.'); return; }
  const lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
  const recent = rows.slice(-(opts.n ?? 10));
  if (opts.json) {
    console.log(JSON.stringify(recent, null, 2));
    return;
  }
  console.log(`${'startedAt'.padEnd(20)} ${'gpu'.padEnd(15)} ${'$/h'.padStart(6)} ${'h'.padStart(5)} ${'$'.padStart(7)} ${'ok'.padStart(3)} main`);
  console.log('─'.repeat(80));
  let totalSpent = 0;
  let totalH = 0;
  for (const r of recent) {
    const start = (r.startedAt || '').slice(0, 19).replace('T', ' ');
    const gpu = String(r.gpuType || '?').slice(0, 15);
    const ph = (r.pricePerHr || 0).toFixed(3);
    const h = (r.elapsedH || 0).toFixed(2);
    const sp = (r.spentUsd || 0).toFixed(3);
    const ok = r.success ? c.green + '✓' + c.reset : c.red + '✗' + c.reset;
    const main = String(r.main || '').slice(0, 30);
    console.log(`${start.padEnd(20)} ${gpu.padEnd(15)} ${ph.padStart(6)} ${h.padStart(5)} ${sp.padStart(7)} ${ok.padStart(3)} ${main}`);
    totalSpent += r.spentUsd || 0;
    totalH += r.elapsedH || 0;
  }
  if (opts.totals || recent.length > 1) {
    console.log('─'.repeat(80));
    console.log(`TOTAL (${recent.length} jobs):  ${totalH.toFixed(2)}h  $${totalSpent.toFixed(2)}`);
  }
}

// jobs logs: fetch (or tail -f) /workspace/.job.log written by the wrapped --main
async function cmdGpuJobsLogs(opts: { follow?: boolean; lines?: number }): Promise<void> {
  const s = requireJobState();
  const sshArgs = ['-p', String(s.sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'LogLevel=ERROR', `root@${s.sshHost}`];
  const lines = opts.lines ?? 200;
  const cmd = opts.follow
    ? `tail -n ${lines} -F /workspace/.job.log 2>/dev/null || echo '(no log yet)'`
    : `tail -n ${lines} /workspace/.job.log 2>/dev/null || echo '(no log yet)'`;
  const r = spawnSync('ssh', [...sshArgs, cmd], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

// jobs cost: compute hours since startedAt × pricePerHr
async function cmdGpuJobsCost(): Promise<void> {
  const s = requireJobState();
  const price = (s.pricePerHr as number | undefined) ?? 0;
  const started = new Date(s.startedAt as string).getTime();
  const ms = Date.now() - started;
  const hours = ms / 3_600_000;
  const minutes = ms / 60_000;
  const spend = hours * price;
  // Pick most readable unit
  const elapsedStr = hours >= 1
    ? `${hours.toFixed(2)}h (${minutes.toFixed(0)}min)`
    : `${minutes.toFixed(1)}min`;
  console.log(`instance:    ${s.instanceId}  (${s.gpuType || 'n/a'} on ${s.provider || 'n/a'})`);
  console.log(`started:     ${s.startedAt}`);
  console.log(`elapsed:     ${elapsedStr}`);
  console.log(`price:       $${price.toFixed(3)}/h`);
  console.log(`spent so far:$${spend.toFixed(3)}`);
  if (price === 0) console.log(`  ${c.yellow}(price metadata missing — older state file?)${c.reset}`);
}

// jobs clean: free up the saved instance for a fresh re-run without
// re-provisioning. Kills GPU processes, wipes /workspace, optionally clears
// pip/HF caches. With --orphans: sweep all instances owned by this user.
async function cmdGpuJobsClean(opts: {
  orphans?: boolean; cache?: boolean; keepWorkspace?: boolean;
}): Promise<void> {
  if (opts.orphans) {
    const { url, key } = getConfig();
    const owner = currentOwner();
    console.log(`[clean --orphans] terminating all instances owned by '${owner}'...`);
    const listRes = await fetch(`${url}/v1/gpu/list?probe=false`, { headers: headers(key) });
    if (!listRes.ok) { console.error(`list failed (HTTP ${listRes.status})`); return; }
    const listData: any = await listRes.json();
    const all: any[] = Array.isArray(listData) ? listData : (listData.instances || []);
    const mine = all.filter((i: any) => {
      const lbl = i.label ?? i.instanceName ?? '';
      if (lbl === i.instanceId || lbl === i.podId) return false;
      return String(lbl).startsWith(`${owner}/`);
    });
    if (mine.length === 0) { console.log(`  no instances owned by '${owner}' running.`); return; }
    console.log(`  found ${mine.length} owned instance(s):`);
    for (const inst of mine) {
      const id = inst.instanceId || inst.podId;
      console.log(`    terminating ${id} (${inst.label || inst.instanceName})`);
      const termRes = await fetch(`${url}/v1/gpu/terminate`, {
        method: 'POST', headers: headers(key),
        body: JSON.stringify({ instanceId: id, provider: inst.provider }),
      });
      console.log(`      → ${termRes.ok ? c.green + 'OK' : c.red + 'FAIL'} ${c.reset}(HTTP ${termRes.status})`);
    }
    // Wipe state if it pointed at one of these
    const saved = loadJobState();
    if (saved && mine.some((i: any) => (i.instanceId || i.podId) === saved.instanceId)) {
      try { unlinkSync(jobStatePath()); } catch { /* ignore */ }
    }
    return;
  }
  const s = requireJobState();
  const sshArgs = ['-p', String(s.sshPort), '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'LogLevel=ERROR', `root@${s.sshHost}`];

  // Kill any running python (the most common stuck process for ML jobs)
  console.log(`[clean] killing python procs on ${s.sshHost}...`);
  spawnSync('ssh', [...sshArgs, 'pkill -9 -f python || true; pkill -9 -f train || true'], { stdio: 'inherit' });

  // Free GPU memory (reset compute mode + nvidia-smi report)
  console.log('[clean] freeing GPU memory...');
  spawnSync('ssh', [...sshArgs, 'nvidia-smi --gpu-reset 2>/dev/null || nvidia-smi'], { stdio: 'inherit' });

  if (!opts.keepWorkspace) {
    console.log('[clean] wiping /workspace...');
    spawnSync('ssh', [...sshArgs, 'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; mkdir -p /workspace'], { stdio: 'inherit' });
  } else {
    console.log('[clean] keeping /workspace (--keep-workspace)');
  }

  if (opts.cache) {
    console.log('[clean] clearing pip + HF caches...');
    spawnSync('ssh', [...sshArgs, 'rm -rf /root/.cache/pip /root/.cache/huggingface /tmp/* 2>/dev/null || true'], { stdio: 'inherit' });
  }

  console.log(`${c.green}✓ clean done${c.reset} — instance ${s.instanceId} ready for re-launch.`);
  console.log(`  next: ai-gateway gpu jobs relaunch  (or: jobs sync && jobs exec ...)`);
}

// jobs relaunch: re-run saved --main WITHOUT re-syncing. Use after `jobs clean`
// or when nothing local changed (fixed something on the remote via SSH).
async function cmdGpuJobsRelaunch(mainOverride?: string): Promise<void> {
  const s = requireJobState();
  const cmd = mainOverride || (s.main as string);
  console.log(`[relaunch] ${s.sshHost} ← ${cmd.slice(0, 80)}${cmd.length > 80 ? '...' : ''}`);
  const r = spawnSync('ssh', ['-p', String(s.sshPort),
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR',
    `root@${s.sshHost}`, `cd /workspace && ${cmd}`], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${c.yellow}Relaunch failed (exit=${r.status}). Instance still alive — fix and re-relaunch.${c.reset}`);
  }
  process.exit(r.status || 0);
}

// jobs retry: re-sync local --path AND re-run saved --main on the saved instance.
// Common after editing local files to fix the failure that kept the box alive.
async function cmdGpuJobsRetry(opts: { skipSync?: boolean; mainOverride?: string }): Promise<void> {
  const s = requireJobState();
  if (!opts.skipSync && s.localPath) {
    console.log(`${c.cyan}[1/2]${c.reset} re-syncing ${s.localPath} → /workspace`);
    const sync = spawnSync('rsync', ['-az', '--delete', '-e',
      `ssh -p ${s.sshPort} -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR`,
      `${(s.localPath as string).replace(/\/$/, '')}/`, `root@${s.sshHost}:/workspace/`,
    ], { stdio: 'inherit' });
    if (sync.status !== 0) { console.error('rsync failed'); process.exit(sync.status || 1); }
  }
  const cmd = opts.mainOverride || (s.main as string);
  console.log(`${c.cyan}[2/2]${c.reset} re-running on ${s.sshHost}: ${cmd.slice(0, 80)}${cmd.length > 80 ? '...' : ''}`);
  const r = spawnSync('ssh', ['-p', String(s.sshPort),
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR',
    `root@${s.sshHost}`, `cd /workspace && ${cmd}`], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${c.yellow}Retry failed (exit=${r.status}). Instance still alive — fix and re-retry.${c.reset}`);
  }
  process.exit(r.status || 0);
}

async function cmdGpuResume(instanceId?: string, opts?: { provider?: string; deployId?: string }) {
  const { url, key } = getConfig();
  const body: Record<string, unknown> = {};
  if (instanceId) body.podId = instanceId;
  if (opts?.provider) body.provider = opts.provider;
  if (opts?.deployId) body.deployId = opts.deployId;
  const res = await fetch(`${url}/v1/gpu/resume`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  if (res.status === 404) {
    console.log('GPU endpoints not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  console.log(data.message || 'GPU resumed.');
}

async function cmdGpuOffers(opts: { gpu?: string; limit?: number; provider?: string }) {
  const { url, key } = getConfig();
  const params = new URLSearchParams();
  if (opts.gpu) params.set('gpuTypes', opts.gpu);
  if (opts.provider) params.set('provider', opts.provider);
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const res = await fetch(`${url}/v1/gpu/offers${query ? `?${query}` : ''}`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('GPU endpoints not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  const offers: any[] = data.offers ?? [];
  if (offers.length === 0) {
    console.log('No GPU offers available.');
    return;
  }
  console.log(`${offers.length} offers (showing top ${Math.min(opts.limit || 10, offers.length)} by price):\n`);
  const sorted = [...offers].sort((a: any, b: any) => a.pricePerHr - b.pricePerHr);
  console.log(`  ${'GPU'.padEnd(30)} ${'$/hr'.padStart(7)} ${'VRAM'.padStart(6)} ${'Provider'.padEnd(10)} Region`);
  console.log(`  ${'─'.repeat(30)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(10)} ──────`);
  for (const o of sorted.slice(0, opts.limit || 10)) {
    const gpu = (o.gpuName || o.gpuType || '?').slice(0, 30);
    const price = `$${Number(o.pricePerHr).toFixed(2)}`;
    const vram = o.vram ? `${o.vram}GB` : '?';
    const prov = (o.provider || '?').slice(0, 10);
    const region = o.region || '';
    console.log(`  ${gpu.padEnd(30)} ${price.padStart(7)} ${vram.padStart(6)} ${prov.padEnd(10)} ${region}`);
  }
}

async function cmdMetrics(format: string) {
  const { url, key } = getConfig();
  const fmt = format === 'json' ? '?format=json' : '';
  const res = await fetch(`${url}/metrics${fmt}`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('Metrics endpoint not available on this gateway (proxy-only mode).');
    console.log('Metrics require the full server (server/ws-server.ts).');
    return;
  }
  console.log(await res.text());
}

async function cmdImage(prompt: string, opts: { model?: string; output?: string }) {
  const { url, key } = getConfig();
  const body = { prompt, model: opts.model || 'fal-ai/flux/schnell' };
  const s = spinner('Generating image...');
  const res = await fetch(`${url}/v1/images/generate`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  s.stop();
  if (!res.ok) {
    const err = await res.text();
    console.error(`${c.red}Error ${res.status}${c.reset}: ${err.slice(0, 200)}`);
    process.exit(1);
  }
  const imgBuffer = Buffer.from(await res.arrayBuffer());
  const outPath = opts.output || 'output.jpg';
  writeFileSync(outPath, imgBuffer);
  console.log(`${c.green}✓${c.reset} Image saved to ${c.bold}${outPath}${c.reset} (${(imgBuffer.length / 1024).toFixed(0)} KB)`);
}

// ── New commands ──────────────────────────────────────────────────────────

async function cmdServices(opts: { json?: boolean }) {
  const { url, key } = getConfig();
  const s = spinner('Fetching service status...');
  const [healthRes, configRes] = await Promise.all([
    fetch(`${url}/health`, { headers: headers(key), signal: AbortSignal.timeout(10000) }).catch(() => null),
    fetch(`${url}/v1/config/providers`, { headers: headers(key), signal: AbortSignal.timeout(10000) }).catch(() => null),
  ]);
  s.stop();

  if (!healthRes?.ok) {
    console.error(`${c.red}✗${c.reset} Gateway unreachable at ${url}`);
    process.exit(1);
  }

  const health = await healthRes.json();
  const config = configRes?.ok ? await configRes.json() : null;

  if (opts.json) {
    console.log(JSON.stringify({ health, config }, null, 2));
    return;
  }

  // ── Overall status
  const statusColor = health.status === 'ok' ? c.green : health.status === 'degraded' ? c.yellow : c.red;
  const statusIcon = health.status === 'ok' ? '●' : health.status === 'degraded' ? '▲' : '✗';
  const uptimeStr = health.uptime_sec != null ? `  ${c.dim}uptime ${fmtSec(health.uptime_sec)}${c.reset}` : '';
  console.log(`${statusColor}${statusIcon}${c.reset} Gateway: ${c.bold}${health.status}${c.reset}${uptimeStr}`);
  if (health.reason) console.log(`  ${c.yellow}reason: ${health.reason}${c.reset}`);
  if (health.connections) {
    console.log(`  Connections: active=${health.connections.active}, peak=${health.connections.peak}`);
  }
  console.log('');

  // ── Pipeline components (STT, LLM, TTS)
  const components = health.components || {};
  const hasComponents = ['stt', 'llm', 'tts'].some(s => components[s]);
  if (hasComponents) {
    console.log(`${c.bold}Pipeline${c.reset}`);
  }
  for (const stage of ['stt', 'llm', 'tts']) {
    const comp = components[stage];
    if (!comp) continue;
    const icon = comp.status === 'ok' ? `${c.green}●${c.reset}` : `${c.yellow}▲${c.reset}`;
    const fb = comp.fallback ? ` ${c.dim}(fallback)${c.reset}` : '';
    console.log(`  ${icon} ${stage.toUpperCase().padEnd(4)} → ${comp.provider}${fb}`);
  }
  console.log('');

  // ── GPU
  const gpu = components.gpu;
  if (gpu) {
    console.log(`${c.bold}GPU${c.reset}`);
    const gpuIcon = gpu.status === 'ready' ? `${c.green}●${c.reset}`
      : gpu.status === 'idle' ? `${c.dim}○${c.reset}`
      : gpu.status === 'stopped' ? `${c.yellow}■${c.reset}`
      : gpu.status === 'error' ? `${c.red}✗${c.reset}`
      : `${c.cyan}◌${c.reset}`;
    let detail = gpu.status;
    if (gpu.endpoint) detail += `  ${c.dim}${gpu.endpoint}${c.reset}`;
    if (gpu.idle_sec) detail += `  ${c.dim}idle ${fmtSec(gpu.idle_sec)}${c.reset}`;
    if (gpu.healthy === false) detail += `  ${c.red}unhealthy${c.reset}`;
    console.log(`  ${gpuIcon} ${detail}`);
    console.log('');
  }

  // ── AI Providers (API key status)
  const providers = health.providers || {};
  const providerNames = Object.keys(providers);
  if (providerNames.length > 0) {
    console.log(`${c.bold}AI Providers${c.reset}`);
    for (const name of providerNames) {
      const available = providers[name];
      const icon = available ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
      const label = available ? 'configured' : `${c.dim}no key${c.reset}`;
      console.log(`  ${icon} ${name.padEnd(12)} ${label}`);
    }
    console.log('');
  }

  // ── Provider balances
  const balances = health.providerBalances || [];
  if (balances.length > 0) {
    console.log(`${c.bold}Balances${c.reset}`);
    for (const b of balances) {
      const icon = b.low ? `${c.red}▲${c.reset}` : `${c.green}●${c.reset}`;
      const bal = b.balance != null ? `$${Number(b.balance).toFixed(2)}` : '?';
      const warn = b.low ? ` ${c.red}LOW${c.reset}` : '';
      console.log(`  ${icon} ${(b.provider || b.name || '?').padEnd(12)} ${bal}${warn}`);
    }
    console.log('');
  }

  // ── Provider performance
  const perf = health.providerPerformance || {};
  const perfNames = Object.keys(perf);
  if (perfNames.length > 0) {
    console.log(`${c.bold}Provider Performance${c.reset}`);
    console.log(`  ${'Provider'.padEnd(14)} ${'Avg'.padStart(7)} ${'Reqs'.padStart(6)} ${'Errors'.padStart(7)} ${'In Tok'.padStart(8)} ${'Out Tok'.padStart(8)}`);
    console.log(`  ${'─'.repeat(14)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
    for (const name of perfNames) {
      const p = perf[name];
      const avg = p.avgLatencyMs ? `${p.avgLatencyMs}ms` : '-';
      const errPct = p.errorRate > 0 ? `${(p.errorRate * 100).toFixed(1)}%` : '0%';
      console.log(`  ${name.padEnd(14)} ${avg.padStart(7)} ${String(p.requests || 0).padStart(6)} ${errPct.padStart(7)} ${String(p.inputTokens || 0).padStart(8)} ${String(p.outputTokens || 0).padStart(8)}`);
    }
    console.log('');
  }

  // ── Circuit breakers
  const breakers = health.circuitBreakers;
  if (breakers && typeof breakers === 'object' && Object.keys(breakers).length > 0) {
    const openBreakers = Object.entries(breakers).filter(([_, v]: [string, any]) => v.state !== 'closed');
    if (openBreakers.length > 0) {
      console.log(`${c.bold}Circuit Breakers${c.reset}`);
      for (const [name, v] of openBreakers as [string, any][]) {
        const icon = v.state === 'open' ? `${c.red}✗${c.reset}` : `${c.yellow}▲${c.reset}`;
        console.log(`  ${icon} ${name}: ${v.state} (failures: ${v.failures || 0})`);
      }
      console.log('');
    }
  }

  // ── Fallback chains from config
  if (config) {
    const chains: [string, unknown[]][] = [];
    for (const key of ['pipelineStt', 'pipelineLlm', 'pipelineTts']) {
      const chain = config[key];
      if (Array.isArray(chain) && chain.length > 0) chains.push([key, chain]);
    }
    if (chains.length > 0) {
      console.log(`${c.bold}Fallback Chains${c.reset}`);
      for (const [key, entries] of chains) {
        const stage = key.replace('pipeline', '').toUpperCase();
        const list = entries.map((e: any) => {
          if (typeof e === 'string') return e;
          return e.providerId || e.provider || e.id || '?';
        });
        console.log(`  ${stage.padEnd(4)} ${list.join(` ${c.dim}→${c.reset} `)}`);
      }
      console.log('');
    }
  }

  // ── Budget
  if (health.budget) {
    const b = health.budget;
    const icon = b.exceeded ? `${c.red}▲${c.reset}` : `${c.green}●${c.reset}`;
    const limit = b.dailyLimitUsd != null ? ` / $${b.dailyLimitUsd}` : '';
    const warn = b.exceeded ? ` ${c.red}EXCEEDED${c.reset}` : '';
    console.log(`${c.bold}Budget${c.reset}  ${icon} $${b.dailySpendUsd} today${limit}${warn}`);
  }

  // ── Latency
  if (health.latency && health.latency.samples > 0) {
    const l = health.latency;
    console.log(`${c.bold}Latency${c.reset}  p50=${l.p50_ms}ms  p95=${l.p95_ms}ms  p99=${l.p99_ms}ms  (${l.samples} samples)`);
  }
}

function fmtSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

async function cmdConfig() {
  const { url, key } = getConfig();
  console.log(`Gateway URL:  ${url}`);
  console.log(`API Key:      ${key ? key.slice(0, 8) + '...' + key.slice(-4) : '(not set)'}`);
  console.log('');
  // Test connectivity + identify user
  try {
    const h: Record<string, string> = {};
    if (key) h['Authorization'] = `Bearer ${key}`;
    const res = await fetch(`${url}/health`, { headers: h, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      console.log(`Status:       connected ✓`);
    } else {
      console.log(`Status:       HTTP ${res.status}`);
    }
  } catch {
    console.log(`Status:       unreachable ✗`);
  }
}

async function cmdWhoami() {
  const { url, key } = getConfig();
  if (!key) {
    console.log('No API key configured. Set AI_GATEWAY_KEY.');
    return;
  }
  // Make a lightweight request and read the X-User-Id header from response
  const res = await fetch(`${url}/v1/models`, {
    headers: headers(key),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.error(`Error ${res.status}: ${(await res.text()).slice(0, 100)}`);
    process.exit(1);
  }
  // The proxy sets X-User-Id on every authenticated response
  // For now, parse the key format to show the userId
  const keyParts = key.split(':');
  if (keyParts.length >= 2) {
    console.log(`User:    ${keyParts[1]}`);
    if (keyParts.length >= 3) console.log(`Label:   ${keyParts.slice(2).join(':')}`);
    console.log(`Key:     ${keyParts[0].slice(0, 8)}...`);
  } else {
    console.log(`User:    default`);
    console.log(`Key:     ${key.slice(0, 8)}...`);
  }
  console.log(`Gateway: ${url}`);
  console.log(`Auth:    valid ✓`);
}

async function cmdPing(count: number) {
  const { url } = getConfig();
  const times: number[] = [];
  for (let i = 1; i <= count; i++) {
    const t0 = Date.now();
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
      const ms = Date.now() - t0;
      times.push(ms);
      console.log(`  ${i}: ${ms}ms`);
    } catch {
      console.log(`  ${i}: timeout`);
    }
  }
  if (times.length > 0) {
    times.sort((a, b) => a - b);
    const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
    const p50 = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)] ?? times[times.length - 1];
    console.log(`\n  avg=${avg}ms  p50=${p50}ms  p95=${p95}ms  (${times.length}/${count} ok)`);
  }
}

async function cmdTranslate(text: string, opts: { from?: string; to?: string; model?: string }) {
  const { url, key } = getConfig();
  const from = opts.from || 'auto';
  const to = opts.to || 'en';
  const sysPrompt = from === 'auto'
    ? `Detect the language and translate to ${to}. Reply only with the translation.`
    : `Translate from ${from} to ${to}. Reply only with the translation.`;
  const body = {
    model: opts.model || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: text },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  };
  const data = await fetchJSON(`${url}/v1/chat/completions`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  console.log(data.choices[0].message.content);
}

async function cmdVoices() {
  console.log('Available TTS voices:\n');
  console.log('  canopylabs/orpheus-v1-english:');
  console.log('    autumn   — Female');
  console.log('    diana    — Female');
  console.log('    hannah   — Female');
  console.log('    austin   — Male');
  console.log('    daniel   — Male');
  console.log('    troy     — Male');
  console.log('');
  console.log('  canopylabs/orpheus-arabic-saudi:');
  console.log('    autumn, diana, hannah, austin, daniel, troy');
}

async function cmdBenchmark(opts: { count?: number }) {
  const { url, key } = getConfig();
  const count = opts.count || 5;
  console.log(`Running ${count} requests per endpoint...\n`);

  const bench = async (name: string, fn: () => Promise<void>): Promise<number[]> => {
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      const t0 = Date.now();
      try { await fn(); times.push(Date.now() - t0); }
      catch { times.push(-1); }
    }
    return times;
  };

  const chatTimes = await bench('chat', async () => {
    await fetchJSON(`${url}/v1/chat/completions`, {
      method: 'POST', headers: headers(key),
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }], max_tokens: 3 }),
    });
  });

  // Generate silence WAV for STT
  const silenceWav = (() => {
    const { execSync } = require('child_process');
    execSync(`python3 -c "import wave,struct,io; b=io.BytesIO(); w=wave.open(b,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(struct.pack('<'+'h'*16000,*([0]*16000))); w.close(); open('/tmp/_bench.wav','wb').write(b.getvalue())"`);
    return readFileSync('/tmp/_bench.wav');
  })();

  const sttTimes = await bench('stt', async () => {
    const form = new FormData();
    form.append('file', new Blob([silenceWav]), 'audio.wav');
    form.append('model', 'whisper-large-v3-turbo');
    const h: Record<string, string> = {};
    if (key) h['Authorization'] = `Bearer ${key}`;
    await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', headers: h, body: form });
  });

  const ttsTimes = await bench('tts', async () => {
    await fetch(`${url}/v1/audio/speech`, {
      method: 'POST', headers: headers(key),
      body: JSON.stringify({ model: 'canopylabs/orpheus-v1-english', input: 'test', voice: 'autumn' }),
    });
  });

  const report = (name: string, times: number[]) => {
    const ok = times.filter(t => t >= 0).sort((a, b) => a - b);
    if (ok.length === 0) return `  ${name.padEnd(8)} — all failed`;
    const p50 = ok[Math.floor(ok.length / 2)];
    const p95 = ok[Math.floor(ok.length * 0.95)] ?? ok[ok.length - 1];
    const avg = Math.round(ok.reduce((s, t) => s + t, 0) / ok.length);
    const fail = times.length - ok.length;
    return `  ${name.padEnd(8)} avg=${String(avg).padStart(5)}ms  p50=${String(p50).padStart(5)}ms  p95=${String(p95).padStart(5)}ms  ${fail > 0 ? `(${fail} failed)` : ''}`;
  };

  console.log(report('chat', chatTimes));
  console.log(report('stt', sttTimes));
  console.log(report('tts', ttsTimes));
}

async function cmdLatencyHosts(opts: { gpu?: string; limit?: number; sort?: string }) {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/gpu/latency/hosts`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('Latency database not available (proxy-only mode).');
    console.log('Requires the full server with Prisma/Neon database.');
    return;
  }
  const data = await res.json();
  const hosts: any[] = Array.isArray(data) ? data : data.hosts || [];
  if (hosts.length === 0) {
    console.log('No host latency data recorded yet.');
    console.log('Run: ai-gateway gpu latency probe   to start probing.');
    return;
  }

  let filtered = hosts;
  if (opts.gpu) {
    const q = opts.gpu.toLowerCase();
    filtered = hosts.filter((h: any) =>
      (h.gpuName || h.gpuType || '').toLowerCase().includes(q));
  }

  // Sort: latency (default), reputation, price
  const sortField = opts.sort || 'latency';
  filtered.sort((a: any, b: any) => {
    if (sortField === 'reputation') return (b.reputationScore ?? 0) - (a.reputationScore ?? 0);
    return (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity);
  });

  const limit = opts.limit || 15;
  const shown = filtered.slice(0, limit);

  console.log(`${filtered.length} hosts (showing top ${shown.length} by ${sortField}):\n`);
  console.log(`  ${'Host'.padEnd(18)} ${'GPU'.padEnd(25)} ${'Median'.padStart(8)} ${'P90'.padStart(8)} ${'Score'.padStart(6)} ${'Provider'.padEnd(10)} Region`);
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(25)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(10)} ──────`);
  for (const h of shown) {
    const host = (h.hostIp || h.hostId || '?').slice(0, 18);
    const gpu = (h.gpuName || h.gpuType || '?').slice(0, 25);
    const med = h.medianMs != null ? `${Math.round(h.medianMs)}ms` : '?';
    const p90 = h.p90Ms != null ? `${Math.round(h.p90Ms)}ms` : '?';
    const score = h.reputationScore != null ? h.reputationScore.toFixed(2) : '?';
    const prov = (h.provider || '?').slice(0, 10);
    const region = h.geolocation || h.region || '';
    console.log(`  ${host.padEnd(18)} ${gpu.padEnd(25)} ${med.padStart(8)} ${p90.padStart(8)} ${score.padStart(6)} ${prov.padEnd(10)} ${region}`);
  }
}

async function cmdLatencyProbe() {
  const { url, key } = getConfig();
  console.log('Triggering latency probe cycle...');
  const res = await fetch(`${url}/v1/gpu/latency/probe`, {
    method: 'POST', headers: headers(key),
  });
  if (res.status === 404) {
    console.log('Latency probing not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  console.log(typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
}

async function cmdGpuBest(opts: { gpu?: string; count?: number }) {
  const { url, key } = getConfig();
  // Fetch offers and latency data, combine them
  const [offersRes, latencyRes] = await Promise.all([
    fetch(`${url}/v1/gpu/offers`, { headers: headers(key) }).catch(() => null),
    fetch(`${url}/v1/gpu/latency/hosts`, { headers: headers(key) }).catch(() => null),
  ]);

  if (offersRes?.status === 404) {
    console.log('GPU endpoints not available (proxy-only mode).');
    return;
  }

  const offersRaw = offersRes ? await offersRes.json().catch(() => null) : null;
  const offers: any[] = Array.isArray(offersRaw)
    ? offersRaw
    : Array.isArray(offersRaw?.offers) ? offersRaw.offers : [];

  const latencyRaw = latencyRes?.ok ? await latencyRes.json().catch(() => null) : null;
  const latencyData: any[] = Array.isArray(latencyRaw)
    ? latencyRaw
    : Array.isArray(latencyRaw?.hosts) ? latencyRaw.hosts : [];

  if (offers.length === 0 && latencyData.length === 0) {
    console.log('No GPU data available. Need the full server with GPU provider keys.');
    return;
  }

  // Build a latency lookup by GPU name
  const latencyByGpu = new Map<string, { medianMs: number; score: number }>();
  for (const h of latencyData) {
    const name = (h.gpuName || h.gpuType || '').toLowerCase().replace(/nvidia|geforce/gi, '').trim();
    const existing = latencyByGpu.get(name);
    if (!existing || (h.medianMs ?? Infinity) < existing.medianMs) {
      latencyByGpu.set(name, {
        medianMs: h.medianMs ?? Infinity,
        score: h.reputationScore ?? 0.5,
      });
    }
  }

  let filtered = offers;
  if (opts.gpu) {
    const q = opts.gpu.toLowerCase();
    filtered = offers.filter((o: any) =>
      (o.gpuName || o.gpuType || '').toLowerCase().includes(q));
  }

  // Score each offer: quality = latency*0.6 + reputation*0.3 + price_rank*0.1
  const scored = filtered.map((o: any) => {
    const name = (o.gpuName || o.gpuType || '').toLowerCase().replace(/nvidia|geforce/gi, '').trim();
    const lat = latencyByGpu.get(name);
    const tcpMs = lat?.medianMs ?? null;
    const tcpScore = tcpMs != null ? Math.max(0, Math.min(1, 1 - (tcpMs - 30) / 270)) : 0.3;
    const repScore = lat?.score ?? 0.5;
    const quality = tcpScore * 0.6 + repScore * 0.3 + 0.1;
    const effectivePrice = o.pricePerHr / Math.max(quality, 0.1);
    return { ...o, tcpMs, tcpScore, repScore, quality, effectivePrice };
  });

  scored.sort((a: any, b: any) => a.effectivePrice - b.effectivePrice);

  const count = opts.count || 10;
  const shown = scored.slice(0, count);

  console.log(`Best GPU offers for real-time (${scored.length} total, top ${shown.length}):\n`);
  console.log(`  ${'#'.padStart(2)} ${'GPU'.padEnd(28)} ${'$/hr'.padStart(6)} ${'TCP'.padStart(6)} ${'Qual'.padStart(5)} ${'Eff$'.padStart(6)} ${'Provider'.padEnd(8)} Region`);
  console.log(`  ${'─'.repeat(2)} ${'─'.repeat(28)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(8)} ──────`);
  for (let i = 0; i < shown.length; i++) {
    const o = shown[i];
    const gpu = (o.gpuName || o.gpuType || '?').slice(0, 28);
    const price = `$${Number(o.pricePerHr).toFixed(2)}`;
    const tcp = o.tcpMs != null ? `${Math.round(o.tcpMs)}ms` : '?';
    const qual = o.quality.toFixed(2);
    const eff = `$${o.effectivePrice.toFixed(2)}`;
    const prov = (o.provider || '?').slice(0, 8);
    const region = o.region || '';
    console.log(`  ${String(i + 1).padStart(2)} ${gpu.padEnd(28)} ${price.padStart(6)} ${tcp.padStart(6)} ${qual.padStart(5)} ${eff.padStart(6)} ${prov.padEnd(8)} ${region}`);
  }
  console.log(`\n  Scoring: quality = TCP_latency×0.6 + reputation×0.3 + base×0.1`);
  console.log(`  Eff$ = price / quality (lower = better value for real-time)`);
}

// ── GPU Dev Mode Commands ──────────────────────────────────────────────────

/** Options for targeting a specific GPU instance in multi-GPU setups. */
interface GpuTargetOpts {
  instance?: string;   // --instance <id>
  image?: string;      // --image <name> (partial match on dockerImage)
}

type GpuInstanceInfo = { instanceId: string; sshHost: string; sshPort: number; endpoint: string; status: string; dockerImage: string };

/** Prompt user to pick from a numbered list. Returns 0-based index. */
async function promptChoice(prompt: string, count: number): Promise<number> {
  process.stdout.write(`\n${prompt} `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d: string) => resolve(d.trim()));
    setTimeout(() => { console.error('\nTimeout — no selection made.'); process.exit(1); }, 30_000);
  });
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= count) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  return idx;
}

/** Prompt user for a yes/no confirmation. Returns true if yes. */
async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(`${prompt} `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d: string) => resolve(d.trim().toLowerCase()));
    setTimeout(() => resolve('n'), 30_000);
  });
  return answer === 'y' || answer === 'yes';
}

/** Prompt user for free-text input. Returns trimmed string. */
async function promptInput(prompt: string): Promise<string> {
  process.stdout.write(`${prompt} `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d: string) => resolve(d.trim()));
    setTimeout(() => resolve(''), 60_000);
  });
  return answer;
}

/**
 * Resolve which GPU instance to target for dev-mode commands (ssh/patch/commit).
 *
 * Resolution order:
 *   1. --instance <id>  → exact match by instanceId
 *   2. --image <name>   → partial match on dockerImage
 *   3. If 1 running instance → auto-select
 *   4. If multiple → list and prompt user to pick
 *   5. If 0 → fall back to legacy /v1/gpu/status single-instance endpoint
 */
async function resolveGpuInstance(opts?: GpuTargetOpts): Promise<GpuInstanceInfo> {
  const { url, key } = getConfig();

  // Try to fetch the full list first
  let instances: any[] = [];
  try {
    const listRes = await fetch(`${url}/v1/gpu/list`, { headers: headers(key), signal: AbortSignal.timeout(5000) });
    if (listRes.ok) {
      const listData = await listRes.json() as any;
      const all = Array.isArray(listData) ? listData : (listData.instances || []);
      // Filter to instances we can actually SSH into. Default: ready/warming/running.
      // When the caller passed --instance explicitly OR set CLAUDEME_GPU_ALLOW_BOOTING=1
      // we ALSO accept 'booting' / 'loading' provided the instance reports an SSH host
      // — Vast often marks an instance 'booting' for several minutes after the SSH
      // daemon is already accepting connections, and gating the dev tools on the
      // gateway-side status check made `gpu dev exec`/`save`/`restore` unusable for
      // that whole window. Status check still happens at the SSH layer (connection
      // refused → exit 255), so this just removes a paper gate.
      const passive = ['ready', 'warming', 'running'];
      const active = ['booting', 'loading'];
      const allowBooting = !!opts?.instance || process.env.CLAUDEME_GPU_ALLOW_BOOTING === '1';
      instances = all.filter((i: any) => {
        if (passive.includes(i.status)) return true;
        if (allowBooting && active.includes(i.status) && i.sshHost && i.sshPort) return true;
        return false;
      });
    }
  } catch { /* list endpoint may not exist — fall back below */ }

  // If we have instances from the list, do multi-GPU resolution
  if (instances.length > 0) {
    let selected: any;

    if (opts?.instance) {
      // Exact match by instanceId
      selected = instances.find((i: any) =>
        (i.instanceId || i.podId || '') === opts.instance
      );
      if (!selected) {
        console.error(`No running instance with ID "${opts.instance}".`);
        console.error('Running instances:');
        for (const i of instances) console.error(`  ${i.instanceId || i.podId}  ${i.dockerImage || ''}`);
        process.exit(1);
      }
    } else if (opts?.image) {
      // Partial match on dockerImage
      const needle = opts.image.toLowerCase();
      const matches = instances.filter((i: any) =>
        (i.dockerImage || '').toLowerCase().includes(needle)
      );
      if (matches.length === 0) {
        console.error(`No running instance matching image "${opts.image}".`);
        console.error('Running instances:');
        for (const i of instances) console.error(`  ${i.instanceId || i.podId}  ${i.dockerImage || ''}`);
        process.exit(1);
      }
      if (matches.length === 1) {
        selected = matches[0];
      } else {
        console.log(`Multiple instances match image "${opts.image}":\n`);
        for (let idx = 0; idx < matches.length; idx++) {
          const m = matches[idx];
          console.log(`  ${c.bold}${idx + 1}${c.reset}) ${m.instanceId || m.podId}  ${c.dim}${m.dockerImage}${c.reset}  [${m.status}]`);
        }
        const pick = await promptChoice('Select instance [number]:', matches.length);
        selected = matches[pick];
      }
    } else if (instances.length === 1) {
      // Auto-select the only running instance
      selected = instances[0];
    } else {
      // Multiple instances, no filter — prompt
      console.log(`${c.yellow}Multiple GPU instances running:${c.reset}\n`);
      for (let idx = 0; idx < instances.length; idx++) {
        const i = instances[idx];
        const id = i.instanceId || i.podId || '?';
        const img = i.dockerImage || '(unknown image)';
        const gpu = i.gpuType || i.gpuName || '';
        console.log(`  ${c.bold}${idx + 1}${c.reset}) ${id}  ${c.cyan}${img}${c.reset}  ${c.dim}${gpu}${c.reset}  [${i.status}]`);
      }
      console.log(`\n${c.dim}Tip: use --instance <id> or --image <name> to skip this prompt.${c.reset}`);
      const pick = await promptChoice('Select instance [number]:', instances.length);
      selected = instances[pick];
    }

    // Validate SSH info. Vast.ai's /v1/gpu/list often omits sshHost/sshPort
    // for instances still in `booting`/`loading` even after Vast itself has
    // assigned them — those fields show up in /v1/gpu/status first. So when
    // they're missing, hit the singleton status endpoint as a fallback for
    // the active deploy and merge the SSH coords in.
    let sshHost = selected.sshHost;
    let sshPort = selected.sshPort;
    if (!sshHost || !sshPort) {
      try {
        const sres = await fetch(`${url}/v1/gpu/status`, { headers: headers(key), signal: AbortSignal.timeout(5000) });
        if (sres.ok) {
          const sdata = await sres.json() as any;
          const sId = sdata.podId || sdata.instanceId;
          if (sId === (selected.instanceId || selected.podId) && sdata.sshHost && sdata.sshPort) {
            sshHost = sdata.sshHost;
            sshPort = sdata.sshPort;
          }
        }
      } catch { /* leave undefined → error below */ }
    }
    if (!sshHost || !sshPort) {
      console.error('SSH connection info not available for this instance.');
      console.error(`  instanceId: ${selected.instanceId || selected.podId}`);
      console.error(`  sshHost: ${sshHost || '(none)'}`);
      console.error(`  sshPort: ${sshPort || '(none)'}`);
      process.exit(1);
    }

    return {
      instanceId: selected.instanceId || selected.podId || '',
      sshHost,
      sshPort,
      endpoint: selected.endpoint || '',
      status: selected.status || '',
      dockerImage: selected.dockerImage || '',
    };
  }

  // Fallback: use legacy single-instance /v1/gpu/status endpoint
  const res = await fetch(`${url}/v1/gpu/status`, { headers: headers(key), signal: AbortSignal.timeout(5000) });
  if (res.status === 404) {
    console.error('GPU endpoints not available (proxy-only mode).');
    console.error('GPU management requires the full server (server/ws-server.ts).');
    process.exit(1);
  }
  const data = await res.json() as any;
  // Same status-gate relaxation as the list path: when --instance is set or
  // the env flag is on, allow `booting`/`loading` so dev tools (exec, save,
  // restore) work during the multi-minute SSH-handover window.
  const okPassive = data.status === 'ready' || data.status === 'warming';
  const allowBooting2 = !!opts?.instance || process.env.CLAUDEME_GPU_ALLOW_BOOTING === '1';
  const okBooting = allowBooting2 && (data.status === 'booting' || data.status === 'loading') && data.sshHost && data.sshPort;
  if (!okPassive && !okBooting) {
    console.error(`GPU is not running (status: ${data.status || 'idle'}).`);
    console.error('Deploy a GPU first: ai-gateway gpu deploy');
    process.exit(1);
  }
  if (!data.sshHost || !data.sshPort) {
    console.error('SSH connection info not available for this deployment.');
    console.error(`  sshHost: ${data.sshHost || '(none)'}`);
    console.error(`  sshPort: ${data.sshPort || '(none)'}`);
    process.exit(1);
  }
  return {
    instanceId: data.instanceId || data.podId || '',
    sshHost: data.sshHost,
    sshPort: data.sshPort,
    endpoint: data.endpoint || '',
    status: data.status,
    dockerImage: data.dockerImage || '',
  };
}

/**
 * Persistent known_hosts file used by all `ai-gateway` SSH/SCP invocations.
 * Trust-on-first-use with `accept-new` is a meaningful improvement over the
 * old `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null` pair, which
 * silently accepted any key on every connection. When an ephemeral cloud IP
 * gets recycled the operator will see a mismatch and must prune the stale
 * entry manually — intentional, since that mismatch is the only signal of a
 * potential MITM.
 */
const SSH_KNOWN_HOSTS = resolve(
  process.env.HOME || '.',
  '.babelcast',
  'known_hosts',
);

/** Ensure ~/.babelcast/ exists so ssh can persist accepted host keys. */
function ensureKnownHostsDir(): void {
  try {
    const dir = dirname(SSH_KNOWN_HOSTS);
    if (!existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
  } catch { /* best effort */ }
}

/** Build common SSH args for connecting to the GPU container. */
function sshArgs(sshHost: string, sshPort: number): string[] {
  ensureKnownHostsDir();
  return [
    '-p', String(sshPort),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    `root@${sshHost}`,
  ];
}

/**
 * gpu ssh [command] — Open interactive SSH or run a remote command.
 * Supports --instance <id> and --image <name> for multi-GPU targeting.
 */
async function cmdGpuSsh(command?: string, target?: GpuTargetOpts) {
  const info = await resolveGpuInstance(target);
  console.log(`${c.cyan}SSH${c.reset} → ${info.sshHost}:${info.sshPort}`);

  if (command) {
    // Non-interactive: run command and return output
    const proc = spawn('ssh', [...sshArgs(info.sshHost, info.sshPort), command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    await new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (code !== 0) {
          console.error(`\n${c.red}SSH exited with code ${code}${c.reset}`);
          process.exit(code || 1);
        }
        resolve();
      });
      proc.on('error', (err) => {
        console.error(`SSH error: ${err.message}`);
        process.exit(1);
      });
    });
  } else {
    // Interactive SSH session — pass through stdio
    const proc = spawn('ssh', sshArgs(info.sshHost, info.sshPort), {
      stdio: 'inherit',
    });
    await new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          process.exit(code);
        }
        resolve();
      });
      proc.on('error', (err) => {
        console.error(`SSH error: ${err.message}`);
        process.exit(1);
      });
    });
  }
}

/**
 * gpu patch <local-file> [remote-path] — Copy a file to the running container
 * and restart the server process.
 * Supports --instance <id> and --image <name> for multi-GPU targeting.
 */
async function cmdGpuPatch(localFile: string, remotePath?: string, opts?: { noRestart?: boolean }, target?: GpuTargetOpts) {
  const info = await resolveGpuInstance(target);

  // Validate local file exists
  if (!existsSync(localFile)) {
    console.error(`Local file not found: ${localFile}`);
    process.exit(1);
  }

  // Default remote path: same as local file name, placed in /app/
  const resolvedRemote = remotePath || `/app/${resolve(localFile).split('/').pop()}`;
  console.log(`${c.cyan}PATCH${c.reset} ${localFile} → ${info.sshHost}:${resolvedRemote}`);

  // Step 1: SCP the file
  ensureKnownHostsDir();
  const spin = spinner('Copying file...');
  const scpProc = spawn('scp', [
    '-P', String(info.sshPort),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    localFile,
    `root@${info.sshHost}:${resolvedRemote}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let scpErr = '';
  scpProc.stderr?.on('data', (d: Buffer) => { scpErr += d.toString(); });
  const scpOk = await new Promise<boolean>((resolve) => {
    scpProc.on('exit', (code) => resolve(code === 0));
    scpProc.on('error', () => resolve(false));
  });
  spin.stop();

  if (!scpOk) {
    console.error(`${c.red}SCP failed${c.reset}: ${scpErr || 'unknown error'}`);
    process.exit(1);
  }
  console.log(`${c.green}✓${c.reset} File copied.`);

  if (opts?.noRestart) {
    console.log(`${c.dim}Skipping server restart (--no-restart).${c.reset}`);
    return;
  }

  // Step 2: Restart the server (kill python3 processes, re-run onstart)
  console.log(`${c.yellow}Restarting server...${c.reset}`);
  const restartCmd = `bash -c 'pkill -f "python3.*server" 2>/dev/null; pkill -f "python3.*app" 2>/dev/null; if [ -f /onstart.sh ]; then nohup bash /onstart.sh > /var/log/onstart.log 2>&1 & elif [ -f /start.sh ]; then nohup bash /start.sh > /var/log/start.log 2>&1 & elif [ -f /app/start.sh ]; then nohup bash /app/start.sh > /var/log/start.log 2>&1 & else echo "No startup script found — killed processes but could not restart."; fi; echo "restart-initiated"'`;
  const restartProc = spawn('ssh', [...sshArgs(info.sshHost, info.sshPort), restartCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let restartOut = '';
  restartProc.stdout?.on('data', (d: Buffer) => { restartOut += d.toString(); });
  restartProc.stderr?.on('data', (d: Buffer) => { /* suppress SSH warnings */ });
  await new Promise<void>((resolve) => {
    restartProc.on('exit', () => resolve());
    restartProc.on('error', () => resolve());
  });

  if (!restartOut.includes('restart-initiated')) {
    console.error(`${c.yellow}Warning: restart command may not have run correctly.${c.reset}`);
  }

  // Step 3: Wait for /health to respond (skip for SSH-only hosts with no HTTP endpoint)
  if (!info.endpoint) {
    console.log(`${c.yellow}No HTTP endpoint available (SSH-only host).${c.reset}`);
    console.log(`Skipping health check. Verify manually: ai-gateway gpu ssh "curl -s localhost:8000/health"`);
    return;
  }
  const healthUrl = info.endpoint.replace(/\/$/, '') + '/health';
  console.log(`Waiting for ${healthUrl} ...`);
  const healthSpin = spinner('Waiting for health...');
  let healthy = false;
  for (let i = 0; i < 60; i++) { // up to 60s
    await new Promise(r => setTimeout(r, 1000));
    try {
      const hRes = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (hRes.ok) { healthy = true; break; }
    } catch { /* not ready yet */ }
  }
  healthSpin.stop();

  if (healthy) {
    console.log(`${c.green}✓${c.reset} Server is healthy. Patch applied successfully.`);
  } else {
    console.error(`${c.yellow}Warning: /health did not respond within 60s.${c.reset}`);
    console.error('  The server may still be starting. Check with: ai-gateway gpu ssh "cat /var/log/onstart.log"');
  }
}

/** Run a shell command and return { stdout, stderr, code }. */
function execCmd(cmd: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts?.cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

/**
 * gpu commit — Show modified files on the running container (vs Docker image layer),
 * download them locally, git add + git commit, and optionally push.
 * Supports --instance <id>, --image <name> for multi-GPU targeting.
 * Supports -m "message" for the commit message.
 */
async function cmdGpuCommit(target?: GpuTargetOpts, opts?: { message?: string }) {
  const info = await resolveGpuInstance(target);
  console.log(`${c.cyan}COMMIT${c.reset} — inspecting changes on ${info.sshHost}:${info.sshPort}`);
  console.log(`${c.dim}Docker image: ${info.dockerImage || '(unknown)'}${c.reset}\n`);

  // Step 1: Find modified files in /app (comparing overlay filesystem timestamps)
  // Use find to list recently modified files (modified after container creation).
  // On Vast.ai containers, /app is the usual working directory.
  const findCmd = `find /app -type f -newer /proc/1/cmdline -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/__pycache__/*' -not -path '*.pyc' -not -name '*.log' 2>/dev/null | head -50`;

  const findProc = spawn('ssh', [...sshArgs(info.sshHost, info.sshPort), findCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let findOut = '';
  findProc.stdout?.on('data', (d: Buffer) => { findOut += d.toString(); });
  await new Promise<void>((resolve) => {
    findProc.on('exit', () => resolve());
    findProc.on('error', () => resolve());
  });

  const files = findOut.trim().split('\n').filter(f => f.trim());

  if (files.length === 0) {
    console.log('No modified files detected in /app.');
    console.log(`${c.dim}Tip: This detection uses file timestamps. If you patched before the container process started, files may not appear.${c.reset}`);
    return;
  }

  console.log(`Modified files (${files.length}):\n`);
  for (const f of files) {
    console.log(`  ${c.yellow}M${c.reset} ${f}`);
  }

  // Step 2: Ask for confirmation
  console.log('');
  if (isTTY) {
    const proceed = await promptYesNo(`Download ${files.length} file(s) to ./gpu-commit/ ? [y/N]`);
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  } else {
    console.log(`${c.dim}Non-interactive mode — downloading automatically.${c.reset}`);
  }

  // Step 3: Download files
  const outDir = resolve(process.cwd(), 'gpu-commit');
  require('fs').mkdirSync(outDir, { recursive: true });

  ensureKnownHostsDir();
  let downloaded = 0;
  const downloadedPaths: string[] = [];
  for (const remoteFile of files) {
    // Preserve directory structure under gpu-commit/
    const relativePath = remoteFile.startsWith('/app/') ? remoteFile.slice(5) : remoteFile.slice(1);
    const localDest = resolve(outDir, relativePath);
    const localDir = dirname(localDest);
    require('fs').mkdirSync(localDir, { recursive: true });

    const dl = spawn('scp', [
      '-P', String(info.sshPort),
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
      '-o', 'LogLevel=ERROR',
      `root@${info.sshHost}:${remoteFile}`,
      localDest,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const ok = await new Promise<boolean>((resolve) => {
      dl.on('exit', (code) => resolve(code === 0));
      dl.on('error', () => resolve(false));
    });

    if (ok) {
      downloaded++;
      downloadedPaths.push(localDest);
      console.log(`  ${c.green}✓${c.reset} ${relativePath}`);
    } else {
      console.log(`  ${c.red}✗${c.reset} ${relativePath} (download failed)`);
    }
  }

  console.log(`\n${c.green}${downloaded}/${files.length}${c.reset} files saved to ${c.bold}gpu-commit/${c.reset}`);

  if (downloaded === 0) {
    console.log('No files downloaded — skipping git operations.');
    return;
  }

  // Step 4: Git add + commit
  // Determine commit message
  let commitMsg = opts?.message || '';
  if (!commitMsg && isTTY) {
    commitMsg = await promptInput(`\n${c.bold}Commit message:${c.reset}`);
  }
  if (!commitMsg) {
    // Build a default message from the image name
    const imgShort = info.dockerImage ? info.dockerImage.split('/').pop()?.split(':')[0] || 'gpu' : 'gpu';
    commitMsg = `fix(${imgShort}): update ${downloaded} file(s) from GPU container`;
  }

  // Determine git repo root (look upward from cwd)
  const gitRootResult = await execCmd('git', ['rev-parse', '--show-toplevel']);
  if (gitRootResult.code !== 0) {
    console.log(`\n${c.dim}Not a git repository — skipping git operations.`);
    console.log(`Next steps:`);
    console.log(`  1. Review the files in gpu-commit/`);
    console.log(`  2. Copy them to your Docker source directory`);
    console.log(`  3. Rebuild: ai-gateway docker build <dir> --name <image>${c.reset}`);
    return;
  }
  const gitRoot = gitRootResult.stdout.trim();

  // git add the downloaded files
  console.log(`\n${c.cyan}git add${c.reset} ${downloaded} file(s)...`);
  const addResult = await execCmd('git', ['add', ...downloadedPaths], { cwd: gitRoot });
  if (addResult.code !== 0) {
    console.error(`${c.red}git add failed:${c.reset} ${addResult.stderr}`);
    return;
  }
  console.log(`${c.green}✓${c.reset} Files staged.`);

  // git commit
  console.log(`${c.cyan}git commit${c.reset} -m "${commitMsg}"`);
  const commitResult = await execCmd('git', ['commit', '-m', commitMsg], { cwd: gitRoot });
  if (commitResult.code !== 0) {
    console.error(`${c.red}git commit failed:${c.reset} ${commitResult.stderr || commitResult.stdout}`);
    return;
  }
  console.log(`${c.green}✓${c.reset} Committed.`);
  if (commitResult.stdout) process.stdout.write(commitResult.stdout);

  // Step 5: Ask to push
  if (isTTY) {
    const shouldPush = await promptYesNo(`\nPush to origin/main? [y/N]`);
    if (shouldPush) {
      console.log(`${c.cyan}git push${c.reset} origin main...`);
      const pushResult = await execCmd('git', ['push', 'origin', 'main'], { cwd: gitRoot });
      if (pushResult.code !== 0) {
        console.error(`${c.red}git push failed:${c.reset} ${pushResult.stderr || pushResult.stdout}`);
      } else {
        console.log(`${c.green}✓${c.reset} Pushed to origin/main.`);
        // Check if Docker image has a CI workflow that will rebuild
        if (info.dockerImage) {
          const imgShort = info.dockerImage.split('/').pop()?.split(':')[0] || '';
          console.log(`\n${c.dim}If "${imgShort}" has a CI workflow, the Docker image will rebuild automatically.`);
          console.log(`Check: https://github.com/<org>/<repo>/actions${c.reset}`);
        }
      }
    } else {
      console.log(`${c.dim}Skipped push. You can push later with: git push origin main${c.reset}`);
    }
  }
}

// ── GPU dev mode — scratch machine for fast iteration ────────────────────────
// Deploys a minimal CUDA + Python + SSH image, then `exec`/`push`/`pull`/`snapshot`.
// Auto-pauses on idle (configurable via `ai-gateway gpu stop` — preserves state).

const GPU_DEV_DEFAULT_IMAGE = 'marcosremar/gpu-dev:latest';

const GPU_DEV_HELP = `
ai-gateway gpu dev — Scratch GPU machine for fast iteration

Deploys a minimal base image (CUDA + Python + SSH) so you can iterate on
commands/scripts without rebuilding a full Docker image every time. When
you're satisfied, 'snapshot' captures the state into a named image.

Usage:
  ai-gateway gpu dev <subcommand> [options]

Subcommands:
  start                        Deploy the dev base image (${GPU_DEV_DEFAULT_IMAGE})
    --base-image <image>         Override the base image
    --gpu-types <types>          Comma-separated GPU type filter
    --storage <gb>               Disk size (default: provider default)
    --env K=V,K2=V2              Env vars
  stop                         Pause the dev machine (preserves state)
  status                       Show dev machine status
  info                         Show python/torch/cuda info (via /info endpoint)

  sh                           Open interactive SSH shell
  exec "<command>"             Run a shell command over SSH

  push <local> [remote]        Upload a file to the container
    --no-restart                 Don't restart the server after upload
  pull <remote> [local]        Download a file from the container

  snapshot [-m "msg"]          Download modified files + git commit + push
                               (alias for 'gpu commit')

  save <name>                  Tar key paths from the running container into
                               a local snapshot at ~/.ai-gateway/snapshots/.
                               Survives Vast preemption — restore on any new
                               instance with the same Docker layout.
    --include p1,p2,...          Override the default paths to capture
    --exclude e1,e2,...          Tar exclude patterns (e.g. "*.log,*.tmp")
    --notes "..."                Free-form note saved in the sidecar JSON
  save list                    Show local snapshots (size + age + origin)
  save delete <name>           Remove a local snapshot

  restore <name>               Stream a saved tar back into the container.
                               Files extract at their original absolute paths;
                               existing files are overwritten in place.

  serve <remote-port>          Open local SSH tunnel for preview
    --local <port>               Local port (defaults to remote port)
    --bind <host>                Bind address (default: 127.0.0.1)

Multi-GPU targeting (applies to sh/exec/push/pull/snapshot/serve):
  --instance <id>              Target a specific instance by ID
  --image <name>               Target by Docker image name (partial match)

Typical workflow:
  ai-gateway gpu dev start                   # deploy scratch machine
  ai-gateway gpu dev info                    # verify GPU + torch work
  ai-gateway gpu dev exec "git clone https://github.com/org/repo /app/proj"
  ai-gateway gpu dev exec "cd /app/proj && pip install -r requirements.txt"
  ai-gateway gpu dev push test_script.py /app/test_script.py
  ai-gateway gpu dev exec "cd /app && python3 test_script.py"
  ai-gateway gpu dev pull /app/output.json ./output.json
  ai-gateway gpu dev serve 8080              # preview a web server at http://localhost:8080
  ai-gateway gpu dev snapshot -m "feat(foo): working prototype"
  ai-gateway gpu stop                        # pause — resume is fast (~20s)

Notes:
  - The dev machine auto-pauses after 15 min of HTTP inactivity (default).
  - 'stop' preserves state — 'resume' brings it back without re-pulling.
  - Install your own dependencies via 'exec "pip install ..."' etc.
  - To promote to a real Docker image, use 'snapshot' (commits source changes)
    or build a Dockerfile and push via CI.
`;

async function cmdGpuDevStart(opts: { image?: string; gpuTypes?: string; storageGb?: number; env?: string; label?: string }) {
  const image = opts.image || GPU_DEV_DEFAULT_IMAGE;
  console.log(`${c.cyan}Dev deploy${c.reset} — image: ${c.bold}${image}${c.reset}`);
  console.log(`${c.dim}Mode: pause-on-idle, auto-destroy disabled. Iterate with: exec / sh / push / pull / snapshot${c.reset}\n`);
  await cmdGpuDeploy({
    image,
    gpuTypes: opts.gpuTypes,
    storageGb: opts.storageGb,
    env: opts.env,
    label: opts.label,
    devMode: true,
    readinessProbe: 'ssh',
  });
}

/** Download a file from the running GPU container via scp. */
async function cmdGpuPull(remotePath: string, localPath?: string, target?: GpuTargetOpts) {
  const info = await resolveGpuInstance(target);
  const resolvedLocal = localPath || remotePath.split('/').pop() || 'downloaded';
  console.log(`${c.cyan}PULL${c.reset} ${info.sshHost}:${remotePath} → ${resolvedLocal}`);

  ensureKnownHostsDir();
  const spin = spinner('Downloading...');
  const scpProc = spawn('scp', [
    '-P', String(info.sshPort),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    `root@${info.sshHost}:${remotePath}`,
    resolvedLocal,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let scpErr = '';
  scpProc.stderr?.on('data', (d: Buffer) => { scpErr += d.toString(); });
  const scpOk = await new Promise<boolean>((resolve) => {
    scpProc.on('exit', (code) => resolve(code === 0));
    scpProc.on('error', () => resolve(false));
  });
  spin.stop();

  if (!scpOk) {
    console.error(`${c.red}SCP failed${c.reset}: ${scpErr || 'unknown error'}`);
    process.exit(1);
  }
  console.log(`${c.green}✓${c.reset} File saved to ${resolvedLocal}`);
}

/**
 * Open a local SSH tunnel forwarding a local port to a remote port on the GPU.
 * Runs in foreground until Ctrl+C, printing the local URL.
 */
async function cmdGpuDevServe(
  remotePort: number,
  opts: { localPort?: number; bind?: string },
  target?: GpuTargetOpts,
) {
  const info = await resolveGpuInstance(target);
  const localPort = opts.localPort || remotePort;
  const bind = opts.bind || '127.0.0.1';

  console.log(`${c.cyan}SSH tunnel${c.reset} ${bind}:${localPort} → ${info.sshHost}:${remotePort}`);
  console.log(`${c.dim}Local preview: ${c.reset}${c.bold}http://${bind}:${localPort}${c.reset}`);
  console.log(`${c.dim}Press Ctrl+C to stop.${c.reset}\n`);

  const tunnelProc = spawn('ssh', [
    '-N',  // no remote command
    '-L', `${bind}:${localPort}:localhost:${remotePort}`,
    ...sshArgs(info.sshHost, info.sshPort),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  // Forward SIGINT/SIGTERM to child so Ctrl+C closes tunnel cleanly
  const onSignal = () => { tunnelProc.kill('SIGTERM'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await new Promise<void>((resolve) => {
    tunnelProc.on('exit', (code) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (code !== 0 && code !== 130 && code !== null) {
        console.error(`${c.red}SSH tunnel exited with code ${code}${c.reset}`);
      }
      resolve();
    });
  });
}

/** Show GPU /info endpoint (python/torch/cuda). */
async function cmdGpuDevInfo(target?: GpuTargetOpts) {
  const info = await resolveGpuInstance(target);
  if (!info.endpoint) {
    console.error('No HTTP endpoint available on this instance.');
    process.exit(1);
  }
  const infoUrl = info.endpoint.replace(/\/$/, '') + '/info';
  try {
    const res = await fetch(infoUrl, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
  } catch (err) {
    console.error(`Failed to reach ${infoUrl}: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── State save/restore — preempt-resilient container snapshots ───────────────
//
// Vast.ai (and most spot GPU markets) preempt cheap instances within
// minutes-to-hours. Re-doing setup (bun install, pip venv, model cache,
// uploaded source tarballs) every time costs ~10 min of human time.
//
// `gpu dev save <name>` SSHes into the running instance, tars the paths
// listed in --include (defaults below), pipes the stream to a local file
// `~/.ai-gateway/snapshots/<name>.tar.gz`, and writes a sidecar `<name>.json`
// with provenance + sha256.
//
// `gpu dev restore <name>` reverses that — pipes the local tar over SSH
// into `tar -xzf -` on the new instance. Idempotent: existing files are
// overwritten, paths absent from the tar are left alone.
//
// We deliberately do NOT call any Vast.ai API (no `vastai cloud_copy`, no
// snapshots) — those need server-side cloud connections, S3 buckets, and
// scheduled jobs that complicate the first-time UX. Local-tar via SSH is
// O(disk + bandwidth), uses tools every container already has, and works
// on any provider with SSH (Vast, RunPod, Hyperstack, Lambda, …).

const SNAPSHOTS_DIR = resolve(
  process.env.HOME || '.',
  '.ai-gateway',
  'snapshots',
);

/** Default tarball roots covering the bench setup state. Override with --include. */
const DEFAULT_SAVE_PATHS: readonly string[] = [
  '/root/.bun',
  '/root/.claudeme',
  '/root/.cache/flashrank',
  '/workspace/.venv-coir',
  '/workspace/claudeme.json',
];

interface SnapshotSidecar {
  name: string;
  createdAt: string;
  instanceId: string | undefined;
  sshHost: string;
  sshPort: number;
  paths: string[];
  excluded: string[];
  sizeBytes: number;
  sha256: string;
  notes?: string;
}

function ensureSnapshotsDir(): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

function snapshotTarPath(name: string): string {
  return join(SNAPSHOTS_DIR, `${name}.tar.gz`);
}

function snapshotJsonPath(name: string): string {
  return join(SNAPSHOTS_DIR, `${name}.json`);
}

/**
 * gpu dev save <name> — Pull tar.gz of `paths` from the running instance.
 *
 *   ai-gateway gpu dev save bench-state
 *   ai-gateway gpu dev save bench-state --include /workspace/foo --exclude '*.log'
 *
 * Streams `tar` stdout straight from SSH into the local file so memory
 * stays bounded regardless of tarball size.
 */
async function cmdGpuDevSave(
  name: string,
  opts: { include?: string[]; exclude?: string[]; notes?: string },
  target?: GpuTargetOpts,
): Promise<void> {
  if (!name || /[/\s]/.test(name)) {
    console.error(`${c.red}Invalid snapshot name${c.reset}: "${name}". Use letters/digits/dash/underscore only.`);
    process.exit(1);
  }
  const info = await resolveGpuInstance(target);
  ensureSnapshotsDir();

  const paths = opts.include && opts.include.length > 0 ? opts.include : [...DEFAULT_SAVE_PATHS];
  const excludes = opts.exclude ?? [];

  // Build the remote tar command. We GZIP on the remote because compression
  // happens close to the source (less network bytes); we also strip leading
  // slashes via the default tar behaviour so paths restore relative to /.
  // `--ignore-failed-read` so missing default paths don't kill the whole
  // archive — useful when the same `gpu dev save` template runs on hosts
  // that didn't get every dep installed.
  const tarArgs = [
    '-czf', '-',
    '--ignore-failed-read',
    '--warning=no-file-changed',
    ...excludes.flatMap(e => ['--exclude', e]),
    ...paths,
  ];
  // Heredoc-style escape: paths must already not contain shell-meta chars.
  // We validate include/exclude args at parse time.
  const remoteCmd = `tar ${tarArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

  const tarPath = snapshotTarPath(name);
  console.log(`${c.cyan}SAVE${c.reset} ${info.sshHost}:${paths.join(', ')} → ${tarPath}`);

  const spin = spinner(`Streaming tar from ${info.sshHost}…`);
  const out = createWriteStream(tarPath);
  const sha = createHash('sha256');
  let sizeBytes = 0;

  const proc = spawn('ssh', [...sshArgs(info.sshHost, info.sshPort), remoteCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    sizeBytes += chunk.length;
    sha.update(chunk);
    out.write(chunk);
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stderrBuf += s;
    // tar prints noisy "no such file" lines for missing default paths;
    // surface only fatal-looking errors live.
    if (/error|cannot|denied/i.test(s) && !/no such file or directory/i.test(s)) {
      process.stderr.write(`${c.dim}[remote tar] ${s}${c.reset}`);
    }
  });

  const exitCode = await new Promise<number>((resolveP) => {
    proc.on('exit', code => resolveP(code ?? -1));
    proc.on('error', () => resolveP(-1));
  });
  out.end();
  await new Promise<void>(r => out.once('close', () => r()));
  spin.stop();

  if (exitCode !== 0 || sizeBytes === 0) {
    console.error(`${c.red}Save failed${c.reset} (exit ${exitCode}, ${sizeBytes} bytes). stderr tail:\n${stderrBuf.slice(-500)}`);
    try { unlinkSync(tarPath); } catch { /* best effort */ }
    process.exit(1);
  }

  const sidecar: SnapshotSidecar = {
    name,
    createdAt: new Date().toISOString(),
    instanceId: info.instanceId,
    sshHost: info.sshHost,
    sshPort: info.sshPort,
    paths,
    excluded: excludes,
    sizeBytes,
    sha256: sha.digest('hex'),
    notes: opts.notes,
  };
  writeFileSync(snapshotJsonPath(name), JSON.stringify(sidecar, null, 2));

  const human = sizeBytes >= 1e9 ? `${(sizeBytes / 1e9).toFixed(2)} GB`
    : sizeBytes >= 1e6 ? `${(sizeBytes / 1e6).toFixed(1)} MB`
    : `${(sizeBytes / 1e3).toFixed(1)} KB`;
  console.log(`${c.green}✓${c.reset} Saved ${c.bold}${name}${c.reset} — ${human} (${sidecar.sha256.slice(0, 12)}…)`);
}

/**
 * gpu dev restore <name> — Push a previously-saved tar.gz back into a
 * running instance and untar it at /. Defaults to the latest target
 * resolution; pass --instance to pick a specific new instance.
 *
 *   ai-gateway gpu dev restore bench-state --instance inst-12345
 */
async function cmdGpuDevRestore(
  name: string,
  target?: GpuTargetOpts,
): Promise<void> {
  const tarPath = snapshotTarPath(name);
  const jsonPath = snapshotJsonPath(name);
  if (!existsSync(tarPath)) {
    console.error(`${c.red}Snapshot not found${c.reset}: ${tarPath}`);
    console.error(`Run \`ai-gateway gpu dev save list\` to see available snapshots.`);
    process.exit(1);
  }
  const info = await resolveGpuInstance(target);
  let sidecar: SnapshotSidecar | null = null;
  try { sidecar = JSON.parse(readFileSync(jsonPath, 'utf-8')) as SnapshotSidecar; } catch { /* non-fatal */ }

  console.log(`${c.cyan}RESTORE${c.reset} ${tarPath} → ${info.sshHost}:${info.sshPort}`);
  if (sidecar) {
    const ageHours = (Date.now() - new Date(sidecar.createdAt).getTime()) / 3.6e6;
    console.log(`${c.dim}snapshot age: ${ageHours.toFixed(1)}h, paths: ${sidecar.paths.join(', ')}${c.reset}`);
  }

  // Verify sha256 if sidecar present — catches local tar corruption before
  // we waste minutes piping garbage over SSH.
  if (sidecar) {
    const spin = spinner('Verifying tarball checksum…');
    const sha = createHash('sha256');
    await new Promise<void>((resolveP, rejectP) => {
      const rs = createReadStream(tarPath);
      rs.on('data', chunk => sha.update(chunk));
      rs.on('end', () => resolveP());
      rs.on('error', rejectP);
    });
    spin.stop();
    const got = sha.digest('hex');
    if (got !== sidecar.sha256) {
      console.error(`${c.red}sha256 mismatch${c.reset} — tarball may be corrupt. Expected ${sidecar.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
      process.exit(1);
    }
  }

  // Two-stage restore: scp the tarball first (resilient — scp has its own
  // retry/keepalive), THEN run `tar -xzf` remotely. The streaming-stdin
  // approach (`cat tar | ssh tar -xzf -`) drops on flaky links during the
  // multi-minute transfer of a large tarball; observed live on Vast.ai.
  const remoteTar = `/tmp/ai-gateway-restore-${name}-${Date.now()}.tar.gz`;

  ensureKnownHostsDir();
  const scpSpin = spinner(`Uploading tar (scp) to ${info.sshHost}…`);
  const scpProc = spawn('scp', [
    '-P', String(info.sshPort),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'LogLevel=ERROR',
    tarPath,
    `root@${info.sshHost}:${remoteTar}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let scpErr = '';
  scpProc.stderr?.on('data', d => { scpErr += d.toString(); });
  const scpOk = await new Promise<boolean>(r => {
    scpProc.on('exit', code => r(code === 0));
    scpProc.on('error', () => r(false));
  });
  scpSpin.stop();
  if (!scpOk) {
    console.error(`${c.red}scp failed${c.reset}: ${scpErr.slice(-500) || 'unknown'}`);
    process.exit(1);
  }

  // Extract on remote. Cleans up the temp tar even on failure so we don't
  // leak GBs across retries.
  const xtractSpin = spinner('Extracting tar on remote…');
  const remoteCmd =
    `tar -xzf '${remoteTar}' -C / -p --no-same-owner; rc=$?; rm -f '${remoteTar}'; exit $rc`;
  const proc = spawn('ssh', [...sshArgs(info.sshHost, info.sshPort), remoteCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });
  const exitCode = await new Promise<number>((resolveP) => {
    proc.on('exit', code => resolveP(code ?? -1));
    proc.on('error', () => resolveP(-1));
  });
  xtractSpin.stop();

  if (exitCode !== 0) {
    console.error(`${c.red}Restore failed${c.reset} (exit ${exitCode}). stderr tail:\n${stderrBuf.slice(-500)}`);
    process.exit(1);
  }
  console.log(`${c.green}✓${c.reset} Restored ${c.bold}${name}${c.reset} on ${info.sshHost}.`);
}

/** gpu dev save list — print local snapshots with size + age. */
function cmdGpuDevSaveList(): void {
  ensureSnapshotsDir();
  const entries = readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.tar.gz'))
    .map(f => f.slice(0, -'.tar.gz'.length))
    .sort();
  if (entries.length === 0) {
    console.log(`${c.dim}No snapshots in ${SNAPSHOTS_DIR}.${c.reset}`);
    return;
  }
  console.log(`${c.bold}${entries.length} snapshot(s) in ${SNAPSHOTS_DIR}:${c.reset}\n`);
  for (const name of entries) {
    const tarPath = snapshotTarPath(name);
    const jsonPath = snapshotJsonPath(name);
    let size = 0;
    try { size = statSync(tarPath).size; } catch { /* skip */ }
    let createdAt = '—';
    let host = '—';
    try {
      const sc = JSON.parse(readFileSync(jsonPath, 'utf-8')) as SnapshotSidecar;
      createdAt = sc.createdAt.replace('T', ' ').slice(0, 16);
      host = sc.sshHost;
    } catch { /* missing sidecar */ }
    const human = size >= 1e9 ? `${(size / 1e9).toFixed(2)} GB`
      : size >= 1e6 ? `${(size / 1e6).toFixed(1)} MB`
      : `${(size / 1e3).toFixed(1)} KB`;
    console.log(`  ${c.cyan}${name.padEnd(24)}${c.reset} ${human.padStart(10)}  ${createdAt}  ${c.dim}${host}${c.reset}`);
  }
}

/** gpu dev save delete <name> — remove tar + sidecar. */
function cmdGpuDevSaveDelete(name: string): void {
  const tarPath = snapshotTarPath(name);
  const jsonPath = snapshotJsonPath(name);
  if (!existsSync(tarPath)) {
    console.error(`${c.red}No such snapshot${c.reset}: ${name}`);
    process.exit(1);
  }
  try { unlinkSync(tarPath); } catch { /* best effort */ }
  try { unlinkSync(jsonPath); } catch { /* best effort */ }
  console.log(`${c.green}✓${c.reset} Deleted ${name}`);
}

async function cmdGpuDev(args: string[]) {
  const sub = args[2];
  const target: GpuTargetOpts = {
    instance: getArg(args, '--instance'),
    image: getArg(args, '--image'),
  };

  switch (sub) {
    case 'start': {
      await cmdGpuDevStart({
        image: getArg(args, '--base-image'),
        gpuTypes: getArg(args, '--gpu-types'),
        storageGb: getArg(args, '--storage') ? parseInt(getArg(args, '--storage')!) : undefined,
        env: getArg(args, '--env'),
        label: getArg(args, '--label'),
      });
      break;
    }
    case 'stop':
      await cmdGpuStop({ deployId: getArg(args, '--deploy-id') });
      break;
    case 'status':
      await cmdGpuStatus();
      break;
    case 'sh':
    case 'shell':
      await cmdGpuSsh(undefined, target);
      break;
    case 'exec': {
      // Everything after 'gpu dev exec' (excluding --instance/--image flags) is the command
      const execSlice = args.slice(3);
      const execParts: string[] = [];
      for (let i = 0; i < execSlice.length; i++) {
        if ((execSlice[i] === '--instance' || execSlice[i] === '--image') && i + 1 < execSlice.length) {
          i++;
        } else {
          execParts.push(execSlice[i]);
        }
      }
      if (execParts.length === 0) {
        console.error('Usage: ai-gateway gpu dev exec "<command>"');
        process.exit(1);
      }
      await cmdGpuSsh(execParts.join(' '), target);
      break;
    }
    case 'push': {
      // gpu dev push <local> [remote]
      const pushSlice = args.slice(3);
      const pushPos: string[] = [];
      for (let i = 0; i < pushSlice.length; i++) {
        if (pushSlice[i] === '--instance' || pushSlice[i] === '--image') { i++; }
        else if (pushSlice[i] === '--no-restart') { /* skip */ }
        else { pushPos.push(pushSlice[i]); }
      }
      const localFile = pushPos[0];
      if (!localFile) {
        console.error('Usage: ai-gateway gpu dev push <local-file> [remote-path] [--no-restart]');
        process.exit(1);
      }
      await cmdGpuPatch(localFile, pushPos[1], { noRestart: hasFlag(args, '--no-restart') }, target);
      break;
    }
    case 'pull': {
      const pullSlice = args.slice(3);
      const pullPos: string[] = [];
      for (let i = 0; i < pullSlice.length; i++) {
        if (pullSlice[i] === '--instance' || pullSlice[i] === '--image') { i++; }
        else { pullPos.push(pullSlice[i]); }
      }
      const remoteFile = pullPos[0];
      if (!remoteFile) {
        console.error('Usage: ai-gateway gpu dev pull <remote-file> [local-path]');
        process.exit(1);
      }
      await cmdGpuPull(remoteFile, pullPos[1], target);
      break;
    }
    case 'snapshot':
    case 'commit': {
      const message = getArg(args, '-m') || getArg(args, '--message');
      await cmdGpuCommit(target, { message });
      break;
    }
    case 'save': {
      // gpu dev save <name> [--include p1,p2] [--exclude e1,e2] [--notes "..."]
      // gpu dev save list
      // gpu dev save delete <name>
      const sub2 = args[3];
      if (sub2 === 'list') { cmdGpuDevSaveList(); break; }
      if (sub2 === 'delete' || sub2 === 'rm') {
        const name = args[4];
        if (!name) {
          console.error('Usage: ai-gateway gpu dev save delete <name>');
          process.exit(1);
        }
        cmdGpuDevSaveDelete(name);
        break;
      }
      if (!sub2 || sub2.startsWith('-')) {
        console.error('Usage: ai-gateway gpu dev save <name> [--include p1,p2] [--exclude e1,e2] [--notes "..."]');
        process.exit(1);
      }
      const include = (getArg(args, '--include') ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const exclude = (getArg(args, '--exclude') ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const notes = getArg(args, '--notes');
      // Reject obvious shell-meta in include/exclude — these go into a
      // remote shell command and we don't want path injection.
      for (const p of [...include, ...exclude]) {
        if (/[`$;&|<>()\\\n]/.test(p)) {
          console.error(`${c.red}Invalid path${c.reset}: "${p}" contains shell-meta characters.`);
          process.exit(1);
        }
      }
      await cmdGpuDevSave(sub2, { include, exclude, notes }, target);
      break;
    }
    case 'restore': {
      // gpu dev restore <name>
      const name = args[3];
      if (!name || name.startsWith('-')) {
        console.error('Usage: ai-gateway gpu dev restore <name> [--instance <id>]');
        process.exit(1);
      }
      await cmdGpuDevRestore(name, target);
      break;
    }
    case 'info':
      await cmdGpuDevInfo(target);
      break;
    case 'serve': {
      // gpu dev serve <remote-port> [--local <n>] [--bind <host>]
      const serveSlice = args.slice(3);
      const servePos: string[] = [];
      let localPort: number | undefined;
      let bind: string | undefined;
      for (let i = 0; i < serveSlice.length; i++) {
        const a = serveSlice[i];
        if (a === '--instance' || a === '--image') { i++; }
        else if (a === '--local' && i + 1 < serveSlice.length) {
          const v = parseInt(serveSlice[++i], 10);
          if (!Number.isFinite(v) || v <= 0 || v > 65535) {
            console.error(`--local requires a valid port number (1-65535), got "${serveSlice[i]}"`);
            process.exit(1);
          }
          localPort = v;
        }
        else if (a === '--bind' && i + 1 < serveSlice.length) { bind = serveSlice[++i]; }
        else { servePos.push(a); }
      }
      const remotePort = parseInt(servePos[0] || '');
      if (!remotePort || Number.isNaN(remotePort)) {
        console.error('Usage: ai-gateway gpu dev serve <remote-port> [--local <n>] [--bind <host>]');
        process.exit(1);
      }
      await cmdGpuDevServe(remotePort, { localPort, bind }, target);
      break;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(GPU_DEV_HELP);
      break;
    default:
      console.error(`Unknown 'gpu dev' subcommand: ${sub}`);
      console.error(`Usage: ai-gateway gpu dev <start|sh|exec|push|pull|save|restore|snapshot|info|serve|stop|status>`);
      process.exit(1);
  }
}

// ── Hyperstack-specific commands (custom OS images + hibernate) ──────────────
// These talk directly to the Hyperstack API using HYPERSTACK_API_KEY; they
// are Hyperstack-only operations that don't fit the provider-agnostic
// `gpu <verb>` surface. The composite `build-bench-image` command uses the
// gateway's HTTP API for deploy/terminate and raw SSH for bootstrap.

const HYPERSTACK_IMAGES_CATALOG = resolve(
  process.env.HOME || '.',
  '.babelcast',
  'hyperstack-images.json',
);

function requireHyperstackKey(): string {
  const k = process.env.HYPERSTACK_API_KEY;
  if (!k) {
    console.error('HYPERSTACK_API_KEY is not set (required by `gpu hyperstack *`).');
    process.exit(1);
  }
  return k;
}

async function getHyperstackClient() {
  const { HyperstackClient } = await import('../src/modules/gateway/providers/gpu/hyperstack-client');
  return new HyperstackClient();
}

function saveCustomImage(img: { id: number; name: string; region?: string; createdAt?: string }) {
  const path = HYPERSTACK_IMAGES_CATALOG;
  const dir = resolve(path, '..');
  try { require('fs').mkdirSync(dir, { recursive: true }); } catch {}
  let catalog: Record<string, unknown> = { images: [] as unknown[] };
  if (existsSync(path)) {
    try { catalog = JSON.parse(readFileSync(path, 'utf8')); } catch { /* ignore */ }
  }
  const images = Array.isArray((catalog as any).images) ? (catalog as any).images : [];
  images.push({ ...img, savedAt: new Date().toISOString() });
  (catalog as any).images = images;
  (catalog as any).latest = { id: img.id, name: img.name, region: img.region };
  writeFileSync(path, JSON.stringify(catalog, null, 2));
  console.log(`${c.green}✓${c.reset} saved to ${path}`);
}

async function cmdGpuHyperstack(args: string[]) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help') {
    console.log(`
ai-gateway gpu hyperstack — Hyperstack Custom OS Images + VM hibernation

Usage:
  ai-gateway gpu hyperstack images list
  ai-gateway gpu hyperstack snapshots list
  ai-gateway gpu hyperstack snapshot create --vm-id <id> --name <name> [--description <d>]
  ai-gateway gpu hyperstack snapshot delete --id <id>
  ai-gateway gpu hyperstack image create-from-snapshot --snapshot-id <id> --name <name>
  ai-gateway gpu hyperstack hibernate --vm-id <id>
  ai-gateway gpu hyperstack resume --vm-id <id>
  ai-gateway gpu hyperstack build-bench-image [--gpu <flavor>] [--name <img>] [--region CANADA-1]

The composite \`build-bench-image\` command does the full flow end-to-end:
  1. Deploys a seed VM (cheapest GPU by default).
  2. SSH-bootstraps it with CRIU + cuda-checkpoint + /tmp/bench-venv
     (same script used by scripts/snapshot-bench/run-cross-vm-bench.ts).
  3. Stops the VM, snapshots it, promotes that snapshot to a Custom OS Image,
     writes the id+name to ~/.babelcast/hyperstack-images.json, terminates
     the seed VM.

Once you have a custom image, set HYPERSTACK_BENCH_IMAGE_ID=<id> in your
gateway env and future deploys skip the ~140s tool install (zero → ready in
~60s vs 5-7min from vanilla Ubuntu).

Requires HYPERSTACK_API_KEY in env.
`);
    return;
  }

  const apiKey = requireHyperstackKey();
  const client = await getHyperstackClient();
  const creds = { apiKey };

  switch (sub) {
    case 'images': {
      const verb = args[1];
      if (verb === 'list') {
        const images = await client.listImages(creds);
        for (const img of images) {
          const tag = img.type ? ` [${img.type}]` : '';
          const reg = img.region ? ` (${img.region})` : '';
          console.log(`${String(img.id).padStart(6)}  ${img.name}${reg}${tag}`);
        }
        console.log(`\n${images.length} image(s)`);
      } else {
        console.error('Usage: ai-gateway gpu hyperstack images list');
        process.exit(1);
      }
      break;
    }
    case 'snapshots': {
      const verb = args[1];
      if (verb === 'list') {
        const snaps = await client.listSnapshots(creds);
        for (const s of snaps) {
          const reg = s.region ? ` (${s.region})` : '';
          console.log(`${String(s.id).padStart(6)}  ${s.name}  status=${s.status}${reg}`);
        }
        console.log(`\n${snaps.length} snapshot(s)`);
      } else {
        console.error('Usage: ai-gateway gpu hyperstack snapshots list');
        process.exit(1);
      }
      break;
    }
    case 'snapshot': {
      const verb = args[1];
      if (verb === 'create') {
        const vmId = getArg(args, '--vm-id');
        const name = getArg(args, '--name');
        const description = getArg(args, '--description');
        if (!vmId || !name) {
          console.error('Usage: ai-gateway gpu hyperstack snapshot create --vm-id <id> --name <name> [--description <d>]');
          process.exit(1);
        }
        const snap = await client.createSnapshot(vmId, name, creds, description);
        console.log(JSON.stringify(snap, null, 2));
      } else if (verb === 'delete') {
        const id = getArg(args, '--id');
        if (!id) { console.error('Usage: ai-gateway gpu hyperstack snapshot delete --id <id>'); process.exit(1); }
        await client.deleteSnapshot(id, creds);
        console.log(`${c.green}✓${c.reset} deleted snapshot ${id}`);
      } else {
        console.error('Usage: ai-gateway gpu hyperstack snapshot <create|delete>');
        process.exit(1);
      }
      break;
    }
    case 'image': {
      const verb = args[1];
      if (verb === 'create-from-snapshot') {
        const snapshotId = getArg(args, '--snapshot-id');
        const name = getArg(args, '--name');
        if (!snapshotId || !name) {
          console.error('Usage: ai-gateway gpu hyperstack image create-from-snapshot --snapshot-id <id> --name <name>');
          process.exit(1);
        }
        const img = await client.createImageFromSnapshot(snapshotId, name, creds);
        console.log(JSON.stringify(img, null, 2));
        saveCustomImage(img);
      } else {
        console.error('Usage: ai-gateway gpu hyperstack image create-from-snapshot --snapshot-id <id> --name <name>');
        process.exit(1);
      }
      break;
    }
    case 'hibernate': {
      const vmId = getArg(args, '--vm-id');
      if (!vmId) { console.error('Usage: ai-gateway gpu hyperstack hibernate --vm-id <id>'); process.exit(1); }
      await client.hibernate(vmId, creds);
      console.log(`${c.green}✓${c.reset} hibernate requested for VM ${vmId}`);
      break;
    }
    case 'resume': {
      const vmId = getArg(args, '--vm-id');
      if (!vmId) { console.error('Usage: ai-gateway gpu hyperstack resume --vm-id <id>'); process.exit(1); }
      await client.hibernateRestore(vmId, creds);
      console.log(`${c.green}✓${c.reset} hibernate-restore requested for VM ${vmId}`);
      break;
    }
    case 'build-bench-image':
      await cmdGpuHyperstackBuildBenchImage({
        gpu: getArg(args, '--gpu'),
        name: getArg(args, '--name'),
        region: getArg(args, '--region'),
        preloadModels: getArg(args, '--preload-models'),
        noPreload: hasFlag(args, '--no-preload'),
      });
      break;
    default:
      console.error(`Unknown 'gpu hyperstack' subcommand: ${sub}`);
      console.error('Usage: ai-gateway gpu hyperstack <images|snapshots|snapshot|image|hibernate|resume|build-bench-image>');
      process.exit(1);
  }
}

async function cmdGpuHyperstackBuildBenchImage(opts: { gpu?: string; name?: string; region?: string; preloadModels?: string; noPreload?: boolean }) {
  const apiKey = requireHyperstackKey();
  const client = await getHyperstackClient();
  const creds = { apiKey };

  const region = opts.region ?? 'CANADA-1';
  const gpuTypes = opts.gpu ? [opts.gpu] : ['NVIDIA RTX A4000', 'NVIDIA L40'];
  const dateTag = new Date().toISOString().slice(0, 10);
  const imageName = opts.name ?? `ai-gateway-bench-${dateTag}`;

  console.log(`${c.bold}Building Hyperstack bench image${c.reset}`);
  console.log(`  gpu types:  ${gpuTypes.join(', ')}`);
  console.log(`  region:     ${region}`);
  console.log(`  image name: ${imageName}`);
  console.log('  mode:       direct Hyperstack API (bypasses gateway idle watchdog + auto-recovery)');
  console.log('');

  // Step 1 — deploy seed VM directly via HyperstackClient. We bypass the
  // gateway here on purpose: the gateway's idle watchdog auto-stops VMs
  // after 5 min of inactivity, which races with our install-then-snapshot
  // flow. This is a one-off tooling op; cost/state machinery is irrelevant
  // because we immediately terminate the seed after the snapshot.
  console.log(`${c.cyan}[1/6]${c.reset} deploying seed VM via Hyperstack API…`);
  const deployedAt = Date.now();
  const created = await client.createInstance(
    {
      gpuTypes,
      region,
      numGpus: 1,
      storageGb: 40,
      dockerImage: process.env.BENCH_IMAGE || 'marcosremar/babelcast-subtitle:latest',
      hfToken: process.env.HF_TOKEN || '',
      interruptible: false,
      deployEnv: {},
      dockerStartCmd: '',
      onstart: '',
      containerDiskInGb: 40,
      volumeId: '',
      preferSsd: false,
    } as any,
    creds,
  );
  const vmId: string = String(created.instanceId ?? created.id ?? '');
  if (!vmId) { console.error(`createInstance returned no id: ${JSON.stringify(created)}`); process.exit(1); }
  console.log(`  created vmId=${vmId}`);

  console.log(`${c.cyan}[2/6]${c.reset} waiting for VM ACTIVE + SSH :22 (up to 20 min)…`);
  const deadline = Date.now() + 20 * 60_000;
  let sshHost: string | undefined;
  let sshPort = 22;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 8_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === 'running') {
      const endpoint = await client.resolveInstanceEndpoint(vmId, creds).catch(() => null);
      if (endpoint) {
        try {
          const u = new URL(endpoint);
          sshHost = u.hostname;
          sshPort = 22;
        } catch {
          sshHost = endpoint.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
        }
        if (sshHost) break;
      }
    }
    if (st === 'deleted' || st === 'terminated' || st === 'error') {
      console.error(`\ndeploy failed, provider status=${st}`);
      process.exit(1);
    }
    process.stdout.write('.');
  }
  if (!sshHost) { console.error('\ntimed out waiting for VM/SSH'); process.exit(1); }
  console.log(`\n  vmId=${vmId} ssh=${sshHost}:${sshPort} (elapsed ${Math.round((Date.now()-deployedAt)/1000)}s)`);

  // Step 2 — bootstrap via the shared BOOTSTRAP_SCRIPT (same exact script the
  // bench driver uses per-VM). Keeping them in one module is the whole point.
  console.log(`${c.cyan}[3/6]${c.reset} SSH bootstrap (CRIU + cuda-checkpoint + bench-venv, ~2-3 min)…`);
  const { BOOTSTRAP_SCRIPT } = await import('../scripts/snapshot-bench/bootstrap');
  const { execFileSync } = await import('child_process');
  ensureKnownHostsDir();
  execFileSync('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=30',
    '-p', String(sshPort),
    `ubuntu@${sshHost}`,
    'bash', '-s',
  ], { input: BOOTSTRAP_SCRIPT, stdio: ['pipe', 'inherit', 'inherit'], timeout: 20 * 60_000 });

  // Step 3b — pre-download model weights into the custom image so future
  // deploys start with the full HF cache already on disk. Cuts first-request
  // cold load from ~4 min (download + shard + CUDA copy) down to ~20s
  // (cached read + CUDA copy). Also converts to sllm-store format when
  // serverless-llm-store is installed, so BENCH_LOADER=sllm works out of the
  // box. Opt-out via --no-preload for debugging / bootstrap-only image bakes.
  if (!opts.noPreload) {
    const defaultPreloads = ['microsoft/Phi-3.5-mini-instruct', 'openai/whisper-large-v3'];
    const models = opts.preloadModels
      ? opts.preloadModels.split(',').map((m) => m.trim()).filter((m) => m.length > 0)
      : defaultPreloads;
    if (models.length === 0) {
      console.log(`${c.cyan}[3b/6]${c.reset} preload skipped (empty --preload-models)`);
    } else {
      console.log(`${c.cyan}[3b/6]${c.reset} preloading model weights into image cache: ${models.join(', ')}…`);
      // Guard against shell metacharacters in HF ids — same policy as the
      // bench driver. HF ids are [a-zA-Z0-9/_.-] which is inherently safe.
      for (const m of models) {
        if (!/^[A-Za-z0-9/_.-]+$/.test(m)) {
          console.error(`  invalid HF id: ${m}`);
          process.exit(1);
        }
      }
      const listPy = models.map((m) => `"${m}"`).join(', ');
      const preloadScript = `
set -euo pipefail
# HF download — store in ~/.cache/huggingface so the image-level disk snapshot
# captures the weights at /home/ubuntu/.cache/huggingface/.
/home/ubuntu/bench-venv/bin/python -c "from huggingface_hub import snapshot_download; [snapshot_download(m, cache_dir='/home/ubuntu/.cache/huggingface') for m in [${listPy}]]"

# sllm-store conversion — soft failure. If serverless-llm-store isn't in the
# venv (PyPI transient, network hiccup), we keep building the image so the
# transformers path still works. BENCH_LOADER=sllm callers will notice.
export SLLM_STORE_DIR=/home/ubuntu/sllm-store
mkdir -p "$SLLM_STORE_DIR"
for MODEL in ${models.map((m) => `"${m}"`).join(' ')}; do
  SLUG="$(echo "$MODEL" | sed 's#/#__#g')"
  /home/ubuntu/bench-venv/bin/sllm-store convert --model "$MODEL" \\
    --output "$SLLM_STORE_DIR/$SLUG" || true
done
`;
      execFileSync('ssh', [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
        '-o', 'ConnectTimeout=30',
        '-p', String(sshPort),
        `ubuntu@${sshHost}`,
        'bash', '-s',
      ], { input: preloadScript, stdio: ['pipe', 'inherit', 'inherit'], timeout: 45 * 60_000 });
    }
  } else {
    console.log(`${c.cyan}[3b/6]${c.reset} preload skipped (--no-preload)`);
  }

  // Step 3 — stop the VM before snapshotting. Hyperstack snapshots are
  // storage-level (disk image), so running state would yield dirty pages.
  console.log(`${c.cyan}[4/6]${c.reset} stopping VM (required before snapshot)…`);
  try {
    await client.stopInstance(vmId, creds);
  } catch (e) {
    console.warn(`  stopInstance failed: ${e instanceof Error ? e.message : e} — continuing anyway`);
  }
  // Wait until the VM has fully stopped. Hyperstack's createSnapshot only
  // accepts ACTIVE or SHUTOFF — a VM still in `stopping` is rejected with
  // HTTP 400. `getInstanceStatus` returns `'stopped'` once shutdown is done.
  const stopDeadline = Date.now() + 5 * 60_000;
  let stopStatus: string | null = null;
  while (Date.now() < stopDeadline) {
    await new Promise(r => setTimeout(r, 5_000));
    stopStatus = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (stopStatus === 'stopped') break;
  }
  if (stopStatus !== 'stopped') {
    console.warn(`  VM status=${stopStatus} after 5 min — snapshot may fail`);
  } else {
    console.log(`  VM fully stopped.`);
  }

  // Step 4 — capture snapshot.
  console.log(`${c.cyan}[5/6]${c.reset} creating snapshot…`);
  const snap = await client.createSnapshot(
    vmId,
    `${imageName}-snap`,
    creds,
    `ai-gateway bench bootstrap (criu + cuda-checkpoint + venv) ${dateTag}`,
  );
  console.log(`  snapshot id=${snap.id} status=${snap.status}`);

  // Poll until the snapshot reaches a terminal non-creating state before
  // promoting. Hyperstack returns 4xx if you promote a still-creating snapshot.
  const snapDeadline = Date.now() + 20 * 60_000;
  while (Date.now() < snapDeadline) {
    await new Promise(r => setTimeout(r, 10_000));
    const all = await client.listSnapshots(creds).catch(() => []);
    const current = all.find((s) => s.id === snap.id);
    if (!current) break;
    const st = (current.status || '').toUpperCase();
    if (st === 'ACTIVE' || st === 'COMPLETED' || st === 'AVAILABLE') break;
    if (st === 'ERROR' || st === 'FAILED') {
      console.error(`snapshot failed: ${JSON.stringify(current)}`);
      process.exit(1);
    }
    process.stdout.write('.');
  }
  console.log('');

  // Step 5 — promote snapshot to custom image.
  console.log(`${c.cyan}[6/6]${c.reset} promoting snapshot to Custom OS Image…`);
  const img = await client.createImageFromSnapshot(snap.id, imageName, creds);
  console.log(`  image id=${img.id} name=${img.name}`);
  saveCustomImage({ id: img.id, name: img.name, region: img.region, createdAt: new Date().toISOString() });

  // Step 6 — terminate seed VM via Hyperstack API directly. Best-effort;
  // we prefer a dangling VM over losing the image we just built.
  console.log(`[cleanup] terminating seed VM ${vmId}…`);
  await client.deleteInstance(vmId, creds).catch((e) => {
    console.warn(`  terminate failed: ${e instanceof Error ? e.message : e}`);
  });

  console.log('');
  console.log(`${c.green}✓ Done.${c.reset}`);
  console.log(`  Set HYPERSTACK_BENCH_IMAGE_ID=${img.id} in your gateway env`);
  console.log(`  (or HYPERSTACK_BENCH_IMAGE_NAME=${img.name}) to use this image`);
  console.log(`  for all future Hyperstack deploys.`);
}

// ── Docker image builder commands ─────────────────────────────────────────────

async function cmdDockerAuth() {
  const { url, key } = getConfig();
  // Start device flow via gateway
  const s = spinner('Connecting to GitHub...');
  const res = await fetch(`${url}/v1/docker/auth`, { method: 'POST', headers: headers(key) });
  s.stop();

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    const msg = err?.error?.message ?? err?.error ?? await res.text();
    if (msg.includes('GITHUB_CLIENT_ID')) {
      console.error(`${c.red}✗${c.reset} GitHub Client ID not configured on the server.`);
      console.error(`\nTo set it up:`);
      console.error(`  1. Register an OAuth App at https://github.com/settings/applications/new`);
      console.error(`     (Authorization callback URL: http://localhost)`);
      console.error(`  2. Set AI_GATEWAY_GITHUB_CLIENT_ID=<client-id> in the server's .env`);
    } else {
      console.error(`${c.red}✗${c.reset} ${msg}`);
    }
    process.exit(1);
  }

  const data = await res.json() as any;
  console.log(`\n${c.bold}Connect your GitHub account${c.reset}`);
  console.log(`\n  1. Visit: ${c.cyan}${c.bold}${data.verificationUri}${c.reset}`);
  console.log(`  2. Enter code: ${c.bold}${c.yellow}${data.userCode}${c.reset}`);
  console.log(`\nWaiting for authorization (expires in ${Math.round(data.expiresIn / 60)} min)...`);

  // Poll
  const sessionId = data.sessionId;
  const pollInterval = (data.interval + 1) * 1000;
  const deadline = Date.now() + data.expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    const pollRes = await fetch(`${url}/v1/docker/auth/status?sessionId=${sessionId}`, { headers: headers(key) });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json() as any;

    if (pollData.status === 'complete') {
      console.log(`\n${c.green}✓${c.reset} Connected as ${c.bold}${pollData.username}${c.reset}`);
      console.log(`  Scopes: ${pollData.scope ?? 'repo, workflow, write:packages'}`);
      return;
    }
    if (pollData.status === 'expired') {
      console.error(`${c.red}✗${c.reset} Code expired — run auth again.`);
      process.exit(1);
    }
    if (pollData.status === 'error') {
      console.error(`${c.red}✗${c.reset} Auth error: ${pollData.error}`);
      process.exit(1);
    }
    process.stdout.write('.');
  }

  console.error(`\n${c.red}✗${c.reset} Timed out waiting for authorization.`);
  process.exit(1);
}

async function cmdDockerAuthStatus() {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/docker/auth/me`, { headers: headers(key) });
  if (!res.ok) { console.error('Error checking auth status'); process.exit(1); }
  const data = await res.json() as any;
  if (!data.authenticated) {
    console.log(`GitHub: ${c.dim}not connected${c.reset}`);
    console.log(`  Run: ai-gateway docker auth`);
  } else {
    console.log(`GitHub: ${c.green}connected${c.reset} as ${c.bold}${data.username}${c.reset}`);
    if (data.savedAt) console.log(`  Connected: ${new Date(data.savedAt).toLocaleString()}`);
  }
}

async function cmdDockerAuthLogout() {
  const { url, key } = getConfig();
  await fetch(`${url}/v1/docker/auth`, { method: 'DELETE', headers: headers(key) });
  console.log(`${c.green}✓${c.reset} GitHub account disconnected`);
}

async function cmdDockerBuild(dir: string, opts: {
  name?: string; tag?: string; repo?: string; public?: boolean;
  platforms?: string; wait?: boolean; deploy?: boolean; gpuTypes?: string;
}) {
  const { url, key } = getConfig();
  const body = {
    dirPath: dir,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.tag ? { tag: opts.tag } : {}),
    ...(opts.repo ? { repoName: opts.repo } : {}),
    ...(opts.platforms ? { platforms: opts.platforms } : {}),
    isPublic: opts.public ?? false,
  };

  const s = spinner('Starting build...');
  const res = await fetch(`${url}/v1/docker/build`, {
    method: 'POST',
    headers: { ...headers(key), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  s.stop();

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    const msg = err?.error?.message ?? err?.error ?? String(res.status);
    if (res.status === 401) {
      console.error(`${c.red}✗${c.reset} Not authenticated. Run: ai-gateway docker auth`);
    } else {
      console.error(`${c.red}✗${c.reset} ${msg}`);
    }
    process.exit(1);
  }

  const data = await res.json() as any;
  const buildId = data.buildId;

  console.log(`${c.green}✓${c.reset} Build started`);
  console.log(`  Build ID: ${c.bold}${buildId}${c.reset}`);
  console.log(`  Repo:     ${c.cyan}${data.repoUrl}${c.reset}`);

  // If deploy flag is set, we must wait for build to complete
  const shouldWait = opts.wait || opts.deploy;

  if (!shouldWait) {
    console.log(`\nTrack progress:`);
    console.log(`  ai-gateway docker status ${buildId}`);
    return;
  }

  console.log(`\nWaiting for build to complete...`);
  const deadline = Date.now() + 50 * 60_000;
  let builtImage: string | null = null;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000));
    const sr = await fetch(`${url}/v1/docker/builds/${buildId}`, { headers: headers(key) });
    if (!sr.ok) continue;
    const sd = await sr.json() as any;
    const build = sd.build;
    process.stdout.write(`  Status: ${build.status}${build.workflowRunUrl ? '' : ' (queuing...)'}       \r`);

    if (build.status === 'success') {
      console.log(`\n${c.green}✓${c.reset} Build complete!`);
      console.log(`  Image: ${c.bold}${build.image}${c.reset}`);
      builtImage = build.image;
      break;
    }
    if (build.status === 'failed') {
      console.error(`\n${c.red}✗${c.reset} Build failed: ${build.error}`);
      if (build.workflowRunUrl) console.error(`  Logs: ${build.workflowRunUrl}`);
      process.exit(1);
    }
  }

  if (!builtImage) {
    console.error(`\n${c.yellow}!${c.reset} Timed out — check: ai-gateway docker status ${buildId}`);
    process.exit(1);
  }

  // Auto-deploy if --deploy flag is set
  if (opts.deploy && builtImage) {
    console.log(`\n${c.cyan}→${c.reset} Auto-deploying image...`);
    await cmdGpuDeploy({
      image: builtImage,
      gpuTypes: opts.gpuTypes,
      onstart: undefined,
    });
  } else {
    console.log(`  Run:   ai-gateway gpu deploy --image ${builtImage}`);
  }
}

async function cmdDockerList() {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/docker/builds`, { headers: headers(key) });
  if (!res.ok) { console.error('Failed to fetch builds'); process.exit(1); }
  const data = await res.json() as any;
  const builds: any[] = data.builds ?? [];

  if (builds.length === 0) {
    console.log('No builds yet. Run: ai-gateway docker build <dir>');
    return;
  }

  const statusColor = (s: string) => {
    if (s === 'success') return c.green + s + c.reset;
    if (s === 'failed') return c.red + s + c.reset;
    if (s === 'building' || s === 'queued') return c.yellow + s + c.reset;
    return c.dim + s + c.reset;
  };

  console.log(`\nDocker image builds (${builds.length}):\n`);
  for (const b of builds) {
    const age = Math.round((Date.now() - b.createdAt) / 60_000);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
    console.log(`  ${c.bold}${b.id}${c.reset}  ${statusColor(b.status)}  ${ageStr}`);
    console.log(`    name: ${b.name}:${b.tag}   repo: ${b.repoUrl}`);
    if (b.image) console.log(`    image: ${c.cyan}${b.image}${c.reset}`);
    if (b.workflowRunUrl) console.log(`    build: ${b.workflowRunUrl}`);
    if (b.error) console.log(`    error: ${c.red}${b.error}${c.reset}`);
  }
}

async function cmdDockerImages() {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/docker/images`, { headers: headers(key) });
  if (!res.ok) { console.error('Failed to fetch images'); process.exit(1); }
  const data = await res.json() as any;
  const images: any[] = data.images ?? [];

  if (images.length === 0) {
    console.log('No successfully built images yet.');
    return;
  }

  console.log(`\nBuilt Docker images (${images.length}):\n`);
  for (const img of images) {
    const age = Math.round((Date.now() - (img.completedAt ?? img.createdAt)) / 60_000);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
    console.log(`  ${c.bold}${img.image}${c.reset}  ${c.dim}${ageStr}${c.reset}`);
    console.log(`    repo: ${img.repoUrl}`);
  }
  console.log(`\nTo deploy:`);
  console.log(`  ai-gateway gpu deploy --image <image>`);
}

async function cmdDockerStatus(buildId: string) {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/docker/builds/${buildId}`, { headers: headers(key) });
  if (res.status === 404) { console.error(`Build ${buildId} not found`); process.exit(1); }
  if (!res.ok) { console.error('Failed to fetch build'); process.exit(1); }
  const data = await res.json() as any;
  const b = data.build;

  const statusLine =
    b.status === 'success' ? `${c.green}✓ success${c.reset}` :
    b.status === 'failed'  ? `${c.red}✗ failed${c.reset}` :
    b.status === 'building' ? `${c.yellow}⟳ building${c.reset}` :
    b.status === 'queued'  ? `${c.yellow}… queued${c.reset}` :
    c.dim + b.status + c.reset;

  console.log(`\nBuild ${c.bold}${b.id}${c.reset}: ${statusLine}`);
  console.log(`  name:      ${b.name}:${b.tag}`);
  console.log(`  repo:      ${b.repoUrl}`);
  if (b.image) console.log(`  image:     ${c.cyan}${b.image}${c.reset}`);
  if (b.workflowRunUrl) console.log(`  workflow:  ${b.workflowRunUrl}`);
  if (b.error) console.log(`  error:     ${c.red}${b.error}${c.reset}`);
  console.log(`  created:   ${new Date(b.createdAt).toLocaleString()}`);
  if (b.completedAt) console.log(`  completed: ${new Date(b.completedAt).toLocaleString()}`);
}

// ── Argument parsing ──────────────────────────────────────────────────────

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function getArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function chatMessageArgs(args: string[], valuedFlags: Set<string>): string[] {
  const message: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (valuedFlags.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    message.push(arg);
  }
  return message;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  const HELP: Record<string, string> = {
    main: `
ai-gateway CLI — Parle AI Gateway

Usage:
  ai-gateway <command> [options]
  ai-gateway <command> help        Show help for a specific command
  ai-gateway help                  Show this help

Commands:
  health          Check gateway health and connection count
  services        Show all services, providers, and their status
  models          List all available models
  chat            Chat with an LLM (streaming by default, supports pipe)
  translate       Translate text between languages (supports pipe)
  detect-language Detect the language of a text
  transcribe      Transcribe an audio file (speech-to-text)
  speech          Run full speech pipeline (audio + optional text prompt)
  tts             Generate speech from text (text-to-speech)
  voices          List available TTS voices
  image           Generate an image from a text prompt
  media           Test image/audio media capabilities
  docker          Build Docker images via GitHub Actions and GHCR (auth, build, list)
  gpu             Manage GPU deployments (status, deploy, stop, logs, ssh, patch, commit)
  apps            List and manage app configurations
  profiles        Alias for 'apps'
  balance         Show provider account balances and daily GPU spend
  logs            Show recent request log
  metrics         Show gateway metrics (Prometheus or JSON)
  latency         GPU host latency analysis (hosts, probe, best)
  server          Manage local dev server (status, start, stop)
  config          Show current configuration and test connectivity
  whoami          Show which user this API key is associated with
  version         Show CLI version
  ping            Measure gateway latency (like ping)
  benchmark       Run a latency benchmark across all endpoints

Dev mode (localhost):
  When AI_GATEWAY_URL points to localhost, the CLI auto-starts the
  server if it's not running. No manual 'bun run serve.ts' needed.
  Use 'ai-gateway server stop' to shut it down.

Environment Variables:
  AI_GATEWAY_URL  Gateway URL (default: http://localhost:4000)
                  Example: https://parle-ai-gateway.fly.dev
  AI_GATEWAY_KEY  API key for Bearer token authentication
                  Required when the gateway has GATEWAY_API_KEYS set
  AIGW_APP_KEY    Per-app API key; enables @app/llm model resolution
  AIGW_APP_NAME   App/Profile ID registered in GATEWAY_API_KEYS

Model selection:
  ai-gateway chat defaults to @app/llm, resolved from authenticated App/Profile.
  Use -m openrouter/<model> to force OpenRouter by provider/model shorthand.

Examples:
  ai-gateway health
  ai-gateway chat "What is 2+2?"
  ai-gateway chat "Say OK only." -m openrouter/meta-llama/llama-3.1-8b-instruct --no-stream
  ai-gateway chat "Translate to French: hello" -m llama-3.3-70b-versatile
  ai-gateway transcribe meeting.wav -l en --prompt "product names: AI Gateway"
  ai-gateway speech meeting.wav --from pt --to en --prompt "classroom dialogue" -o dubbed.wav
  ai-gateway tts "Hello world" -o hello.wav -v daniel
  ai-gateway image "a cat on a keyboard" -o cat.jpg
`,
    chat: `
ai-gateway chat — Chat with an LLM

Usage:
  ai-gateway chat <message> [options]

Arguments:
  <message>                    The message to send (required)

Options:
  -m, --model <model>          Model to use
                               Default: @app/llm (authenticated app profile)
                               Provider shorthand allowed: openrouter/<model>, groq/<model>
                               Available: llama-3.1-8b-instant, llama-3.3-70b-versatile,
                               meta-llama/llama-4-scout-17b-16e-instruct
  --no-stream                  Return the full response at once instead of streaming
  --max-tokens <n>             Maximum tokens to generate (default: 1024, max: 128000)
  -i, --image <path>           Attach an image file; repeat for multiple images
                               Supported: PNG, JPG/JPEG, WEBP; max 20MB each

Notes:
  - Streaming is enabled by default — tokens appear as they're generated
  - Vision providers may ignore streaming; use --no-stream for predictable output
  - Image inputs require a vision-capable model and are sent as image_url parts
  - Token usage is shown at the end when streaming completes
  - Only models configured on the gateway are available (no proprietary models)
  - Temperature defaults to the model's default (typically ~0.7)

Examples:
  ai-gateway chat "What is 2+2?"
  ai-gateway chat "Explain quantum computing" -m llama-3.3-70b-versatile
  ai-gateway chat "Say OK" -m openrouter/meta-llama/llama-3.1-8b-instruct --no-stream --max-tokens 5
  ai-gateway chat "Compare these images" -m openrouter/google/gemini-2.5-flash -i ideal.jpg -i render.jpg --no-stream
`,
    transcribe: `
ai-gateway transcribe — Speech-to-text transcription

Usage:
  ai-gateway transcribe <file> [options]

Arguments:
  <file>                       Path to audio file (WAV, MP3, FLAC, etc.)
                               Max file size: 25MB

Options:
  -m, --model <model>          STT model to use
                               Default: whisper-large-v3-turbo
                               Available: whisper-large-v3, whisper-large-v3-turbo
  -l, --language <lang>        Language hint (BCP-47 code: en, fr, es, pt, de, ja, zh...)
                               Improves accuracy when the language is known
  --prompt <text>              STT context/hotwords for audio + text requests

Notes:
  - Identical audio files are cached for 5 minutes (X-Cache: HIT on repeat)
  - The gateway routes to Groq's hosted Whisper by default

Examples:
  ai-gateway transcribe recording.wav
  ai-gateway transcribe meeting.mp3 -l en --prompt "names: Marcos, BabelCast"
  ai-gateway transcribe audio.flac -m whisper-large-v3 -l fr
`,
    speech: `
ai-gateway speech — Full speech pipeline (STT → LLM → TTS)

Usage:
  ai-gateway speech <audio-file> [options]

Arguments:
  <audio-file>                 Path to audio file (WAV, MP3, FLAC, etc.)

Options:
  --from <lang>                Source language (default: fr)
  --to <lang>                  Target language (default: en)
  --prompt <text>              STT prompt/context for audio + text input
  --speaker <voice>            TTS voice/speaker hint
  --ref-text <text>            Voice clone reference text
  --reference-audio <file>     Voice clone reference audio file
  -o, --output <file>          Save returned audio when available
  --json                       Print full JSON response

Examples:
  ai-gateway speech meeting.wav --from pt --to en --prompt "classroom dialogue"
  ai-gateway speech phrase.wav --from es --to en -o dub.wav --json
`,
    media: `
ai-gateway media — Verify media capabilities

Usage:
  ai-gateway media test --image <path> --audio <path> [options]

Options:
  --image <path>               Image fixture for image+text chat test
  --audio <path>               Audio fixture for transcription test
  -m, --model <model>          Vision model (default: openrouter/google/gemini-2.5-flash)

Examples:
  ai-gateway media test --image web/e2e/screenshots/overview.png --audio tests-playwright/fixtures/samples/statement.wav
`,
    tts: `
ai-gateway tts — Text-to-speech generation

Usage:
  ai-gateway tts <text> [options]

Arguments:
  <text>                       Text to convert to speech (required)

Options:
  -m, --model <model>          TTS model to use
                               Default: canopylabs/orpheus-v1-english
                               Available: canopylabs/orpheus-v1-english,
                               canopylabs/orpheus-arabic-saudi
  -v, --voice <voice>          Voice name
                               Default: autumn
                               Available: autumn, diana, hannah (female)
                                          austin, daniel, troy (male)
  -o, --output <file>          Output file path (default: output.wav)

Notes:
  - Output format is WAV
  - Invalid voice names fall back to the default voice silently

Examples:
  ai-gateway tts "Hello world"
  ai-gateway tts "Good morning" -v daniel -o greeting.wav
  ai-gateway tts "مرحبا" -m canopylabs/orpheus-arabic-saudi
`,
    image: `
ai-gateway image — Generate an image from a text prompt

Usage:
  ai-gateway image <prompt> [options]

Arguments:
  <prompt>                     Text description of the image (required)

Options:
  -m, --model <model>          Image generation model
                               Default: fal-ai/flux/schnell
  -o, --output <file>          Output file path (default: output.jpg)

Notes:
  - Uses fal.ai FLUX Schnell by default (fast, ~3-5 seconds)
  - Output is JPEG format

Examples:
  ai-gateway image "a sunset over mountains"
  ai-gateway image "logo design, minimal, blue" -o logo.jpg
`,
    docker: `
ai-gateway docker — Build Docker images via GitHub Actions and GHCR

Usage:
  ai-gateway docker <subcommand> [options]

Subcommands:
  auth                         Connect your GitHub account (OAuth device flow)
  auth logout                  Disconnect GitHub account
  auth status                  Show connected GitHub user
  build <dir>                  Build a Docker image from a local directory
    --name <name>                Image name (default: directory name)
    --tag <tag>                  Docker tag (default: latest)
    --repo <repo>                GitHub repo name (default: ai-gateway-img-<name>)
    --public                     Create the GitHub repo as public (default: private)
    --platforms <platforms>      Build platforms (default: linux/amd64)
    --wait                       Wait for build to complete
    --deploy                     Auto-deploy after build succeeds
    --gpu-types <types>          GPU types for auto-deploy (e.g., "RTX 4090,A6000")
  list                         List all Docker image builds
  images                       List successfully built images (ready to deploy)
  status <buildId>             Show status of a specific build

Setup:
  1. Register a GitHub OAuth App at https://github.com/settings/applications/new
     (Authorization callback URL: http://localhost — device flow doesn't need it)
  2. Set env var: AI_GATEWAY_GITHUB_CLIENT_ID=<your-app-client-id>
  3. Run: ai-gateway docker auth
  4. Follow the link and enter the shown code in your browser

After auth, built images are available at:
  ghcr.io/<your-github-username>/<repo>:latest

Examples:
  ai-gateway docker auth
  ai-gateway docker build ./my-whisper-app --name whisper-custom --wait
  ai-gateway docker build ./my-llm --public --platforms linux/amd64,linux/arm64
  ai-gateway docker build ./babelcast-subtitle --deploy --gpu-types "NVIDIA GeForce RTX 4090"
  ai-gateway docker list
  ai-gateway gpu deploy --image ghcr.io/alice/ai-gateway-img-whisper:latest
`,
    gpu: `
ai-gateway gpu — Manage GPU deployments

Usage:
  ai-gateway gpu <subcommand> [options]

Subcommands:
  status                       Show current GPU deployment status
                               (podId, endpoint, gpuType, provider, cost/hr, health)
  list                         List ALL active GPU instances across providers
  offers                       Show available GPU offers with pricing
    --gpu <filter>               GPU type filter (e.g. "4090", "A100", "RTX 5090")
    --provider <name>             Provider filter: runpod, vast, tensordock, modal
    -n <count>                   Number of offers to show (default: 10)
  deploy                       Deploy a new GPU instance
    --image <docker-image>       Docker image (e.g. marcosremar/babelcast-subtitle:latest)
    --gpu-types <types>          Comma-separated GPU types
                                 (e.g. "NVIDIA GeForce RTX 4090,NVIDIA RTX A6000")
    --search-mode <high_quality|full>  Vast offer search profile (default: high_quality)
    --provider <name>            Restrict to one provider (vast, runpod, modal,
                                 hyperstack, tensordock). Skips tier cascade race.
  stop                         Stop (pause) the current GPU instance
  resume [instanceId]          Resume a stopped instance
    --provider <name>            Provider hint (runpod, vast, tensordock)
  terminate <instanceId>       Permanently destroy a specific instance
    --provider <name>            Provider hint (runpod, vast, tensordock)
  logs                         Fetch container stdout/stderr logs

Dev Mode (fast iteration on running containers):
  ssh [command]                Open interactive SSH to the container
                               If command given, run non-interactively
  patch <file> [remote-path]   Copy local file to container, restart server
    --no-restart                 Copy only, don't restart the server
  commit                       Download modified files, git add + commit + push
    -m "message"                 Commit message (prompted if omitted)
  pull <remote> [local]        Download a file from the container

Scratch dev machine (deploy minimal base + iterate):
  dev start                    Deploy a bare CUDA+Python+SSH image for iteration
  dev exec "<cmd>"             Run a command on the dev machine
  dev sh                       Interactive SSH shell
  dev push/pull/snapshot/info  See 'ai-gateway gpu dev help' for full list

Hyperstack-specific (Custom OS Images + hibernation):
  hyperstack images list              List stock + custom OS images
  hyperstack snapshots list           List VM snapshots
  hyperstack snapshot create --vm-id <id> --name <n>   Create a snapshot
  hyperstack snapshot delete --id <id>                 Delete a snapshot
  hyperstack image create-from-snapshot --snapshot-id <id> --name <n>
                                      Promote snapshot to reusable image
  hyperstack hibernate --vm-id <id>   Hibernate a VM (suspend-to-disk)
  hyperstack resume --vm-id <id>      Resume a hibernated VM
  hyperstack build-bench-image        Deploy seed VM → bootstrap → snapshot →
                                      promote to Custom OS Image (one-shot).
                                      Set HYPERSTACK_BENCH_IMAGE_ID to use it.

Auto-job (provision → run → pull → terminate):
  jobs run --main "<cmd>" (--repo <url> | --path <dir>) [opts]
                                      Picks cheapest matching offer, deploys,
                                      runs the command, pulls /workspace back,
                                      then ALWAYS terminates the instance.
                                      See 'ai-gateway gpu jobs help' for full opts.

  Multi-GPU targeting (applies to ssh, patch, pull, commit, dev):
    --instance <id>              Target a specific instance by ID
    --image <name>               Target by Docker image name (partial match)
                                 If multiple GPUs running and no flag given,
                                 you'll be prompted to pick one.

Notes:
  - GPU commands require the full server (server/ws-server.ts), not the
    lightweight proxy (serve.ts). If you see "proxy-only mode", the
    gateway was started with serve.ts which doesn't include GPU management.
  - Deploy is non-blocking — use 'gpu status' to poll until ready
  - Terminate is permanent and cannot be undone
  - Dev mode commands (ssh, patch, commit) use SSH to connect directly
    to the running container. SSH info is auto-discovered from deploy state.
  - When multiple GPUs are running, use --instance or --image to target one.

Examples:
  ai-gateway gpu status
  ai-gateway gpu list
  ai-gateway gpu offers --gpu 4090 -n 5
  ai-gateway gpu deploy --image marcosremar/babelcast-subtitle:latest
  ai-gateway gpu deploy --gpu-types "NVIDIA GeForce RTX 4090"
  ai-gateway gpu stop
  ai-gateway gpu resume
  ai-gateway gpu resume pod-abc123
  ai-gateway gpu terminate pod-abc123
  ai-gateway gpu terminate inst-456 --provider vast
  ai-gateway gpu logs

Dev mode examples:
  ai-gateway gpu ssh                              Open interactive shell
  ai-gateway gpu ssh "tail -20 /var/log/app.log"  Run a command remotely
  ai-gateway gpu ssh "nvidia-smi"                 Check GPU usage
  ai-gateway gpu ssh --image smplest-x "nvidia-smi"  Target specific GPU
  ai-gateway gpu patch server.py /app/server.py   Patch and restart
  ai-gateway gpu patch model.py                   Patches to /app/model.py
  ai-gateway gpu patch config.json --no-restart   Copy without restart
  ai-gateway gpu patch model.py --image wham      Patch specific GPU
  ai-gateway gpu pull /app/out.json ./out.json    Download file from container
  ai-gateway gpu commit                           Download + git commit
  ai-gateway gpu commit -m "fix: arm accuracy"    With commit message
  ai-gateway gpu commit --instance inst-123 -m "feat: add VPoser"
  ai-gateway gpu dev start                        Launch scratch dev machine
  ai-gateway gpu dev exec "nvidia-smi"            Run command in dev machine
  ai-gateway gpu dev help                         Full dev mode help
`,
    gpuFinetune: `
ai-gateway gpu finetune — Generic finetuning module (Fireworks-style automation)

Submit a job spec, get auto-provisioning + HF data/model download + encode +
train + checkpoint + push-to-HF — in one call. Sensible defaults per workload
type (text or audio). Crash-survivable via auto-resume + spot + budget cap.

Subcommands:
  submit | run    Provision + run finetune (one-shot, foreground)
                  Smoke runs FIRST by default → only proceeds to full if OK.
                  --no-smoke / --smoke (smoke-only) / --dry-run / --no-estimate
                  Preflight (HF reachable + token write + R2 creds + script)
                  runs before GPU spend. --skip-preflight bypass / --preflight-only diagnose
  status          Show saved instance info
  logs [-f]       Tail /workspace/.job.log
  metrics         GPU/VRAM/RAM/DISK/NET snapshot
  cancel          Terminate saved instance (--force)
  history         Show last 20 finetune runs with totals
  estimate        Predict total wall time + cost from spec (no spend)
  validate        Schema + live preflight (HF/R2/script, no spend). --no-preflight = schema only
  lr-find         Sequential mini-trains @ {1e-6..5e-4} → suggest best LR
  sweep --trials N  Parallel hyperparam search (N spot instances)
  deploy <ckpt>   Push ckpt to --push-to-hf or print local IARATTS_CKPT cmd
  list-runs       Past finetune submissions (~/.babelcast/finetune_runs/)
  plugins         Show available plugins (lora, qlora, grad-ckpt, flash-attn)
  watch-web       Open local web dashboard (stub — use 'gpu jobs watch' for now)
  compare         A/B WER test multiple ckpts via Whisper roundtrip
                  --ckpt <path> (repeatable)  --prompts <path>  --max N
                  --whisper-model base|small|medium|large-v3

Submit flags (all also work as spec.yaml keys):
  --persist-cache   [TODO] Mount persistent volume (skip re-download $$)
  --retry-on-preempt N  Auto-redeploy + resume on spot preempt (N retries)
  --incremental     [TODO not yet implemented] Hash dataset; skip encode if
                    unchanged from last run. datasetHash() helper exists but
                    no skip-decision wired into encode stage yet.
  --auto-fix        [TODO] On smoke failure, lookup KNOWN_BUGS + suggest/apply fix
  --plugin <name>   Apply plugin (lora|qlora|grad-ckpt|flash-attn)
  --watch-wer <p>   WER eval every 10min using <p>/eval prompts JSON
  --web             [TODO] Open local web dashboard while running (stub)

Round 4 (ideas from Axolotl/SkyPilot/Unsloth):
  --wandb-project <p>   W&B logging (auto-export WANDB_API_KEY from env)
  --notify-url <url>    POST {status,runId,ckpt} to URL on completion
  --providers a,b,c     Multi-cloud failover (try in order if 1st fails)
  --failover-on-preempt [TODO] Switch provider on spot preemption
  --ckpt-avg N          Polyak-average last N ckpts → model_avg.safetensors
  --export-gguf         [TODO] Post-train: convert ckpt to GGUF for llama.cpp/ollama
  spec.secrets:         Sensitive env vars (redacted from logs/state file)
  spec.evalsPerEpoch    [TODO] Run eval N times per epoch (vs every M steps)
  spec.earlyStopOnEval  [TODO] Stop if metric < threshold during eval
  spec.multiDataset     Combine N datasets with weights

Round 6 (3-repo HF organization):
  --hf-base <owner/name>   Auto-create 3 HF repos:
                             <name>-dataset (encoded.pt + manifest)
                             <name>          (weights = ckpts)
                             <name>-code     (training scripts) [if hfStructure=tri]
  --hf-structure flat|split|tri  flat=1 repo, split=2, tri=3 (default split if hfBase set)
  --from-hf <owner/name>   Resume from 3 HF repos:
                             - download <name>-dataset → skip encode
                             - download <name>-code    → /workspace
                             - download <name>         → use as --resume

Round 8 (quality automation + GPU fallback + Tier 2 power knobs):
  --quality auto|safe|fast Smart defaults derived from epochs/cadence/preset.
                             auto (default): torch.compile + plateau-stop (epochs ≥ 2)
                             safe: no auto-stop, no compile (debug)
                             fast: + pitch/speed augment (small dataset boost)
  --auto-stop-plateau N    Stop if loss doesn't improve for N steps (0 = off; auto sets N = saveEverySteps × 5)
  --torch-compile / --no-torch-compile  Force torch.compile flow_net on/off
  --augment-pitch          Pitch-shift ±2 semitones randomly (doubles encode dataset)
  --augment-speed          Speed-perturb 0.9-1.1× randomly (doubles encode dataset)
  --gpu-fallback / --no-gpu-fallback  Walk cheaper-GPU ladder (4090→3090→A5000→4080)
                             when primary unavailable @ --max-cost. Default ON for finetune.
  --image <ref>            Override docker image (default: marcosremar/gpu-dev:latest;
                             use ghcr.io/<user>/aigw-finetune-base:latest for ~3-4 min faster boot)

Spec-only — auto-prep (preset-driven dataset preprocessor):
  prepare: auto    (default)  Run preset's prepareScript on /root/data/metadata.jsonl
  prepare: skip               Skip prep; assume /root/data is encode-ready
  prepare: <shell command>    Custom prep command override

Round 8 — Tier 2 advanced (quality:auto handles 80% — leave unset unless tuning):
  --batch-size N           Per-step micro batch size (default 2)
  --grad-accum N           Gradient accumulation steps (effective batch = batch × accum)
  --weight-decay X         AdamW weight decay (default 0.01)
  --warmup-steps N         LR warmup before cosine decay (default 200)
  --freeze-backbone-layers N  Freeze first N transformer blocks (default 4; 0 = train all)
  --only-flow-net          MoshiVis-style: train ONLY flow_net + out_eos (LoRA-like surface)
  --curriculum linear      Sort training rows short→long instead of random shuffle
  --save-every-steps N     Checkpoint cadence (default 100; 5 in smoke)
  --seed N                 Random seed (reproducibility, default 42)
  --grad-clip X            Gradient norm clip threshold (default 1.0)
  --log-every-steps N      Print loss every N steps (default 25)

Submit forms:
  ai-gateway gpu finetune submit                  # auto-loads ./train.yaml
  ai-gateway gpu finetune submit -f train.yaml
  ai-gateway gpu finetune submit --script ./train.py --type audio --dataset hf://r ...

PRESETS (no user script needed — only train.yaml + dataset):
  type: flow-matching-tts      generic flow-matching TTS (kyutai/pocket-tts compatible)
  type: codec-tts              generic codec TTS via cross-entropy (VUI/Fluac)
  type: lora-llm               LoRA fine-tune for LLaMA/Mistral/Qwen 7B-32B
  type: <custom>               legacy mode — provide --script <path>

PROJECTS (preset + model + dataset bundled):
  project: pocket-tts          kyutai/pocket-tts + flow-matching-tts preset
  project: vui-ptbr            VUI 100M + codec-tts preset + PT-BR dataset
  Run 'ai-gateway gpu finetune presets' to list installed bundled trainers.

Spec keys (YAML or JSON):
  type        text | audio | custom         (default audio)
  script      path to your trainer python   (required)
  dataset     hf://owner/repo               (auto-downloaded → /root/data)
  model       hf://owner/repo               (auto-downloaded → /root/model)
  dataset-include  glob                     (e.g. "wav/*"; skip text/ etc)
  noHfTransfer     true|false               (workaround 429 on small-file datasets)
  epochs           N                        (default 4)
  lr               X                        (default 5e-5)
  numGpus          N                        (>1 → multi-GPU shard encode for audio)
  gpu              filter                   (default "4090")
  maxCost          $/h                      (default 0.4)
  maxSpend         $                        (default 5.0; force-kill if exceed)
  output           dir                      (default ./ckpts/run-<ts>)
  pushToHf         owner/repo               (upload final ckpt to HF)
  autoResume       true|false               (--resume from last ckpt)
  preferSpot       true|false               (default true)
  reuse            true|false               (skip provision if instance live)
  extraTrainArgs   "..."                    (appended to train cmd)
  extraDeps        "pkg1 pkg2"              (extra pip)
  aptPkgs          "pkg1 pkg2"              (extra apt)

Example spec.yaml:
  type: audio
  script: ./distill/finetune_pocket_tts.py
  dataset: hf://marcosremar2/gemini-dataset-erinome
  dataset-include: wav/*
  noHfTransfer: true
  model: hf://kyutai/pocket-tts
  epochs: 4
  lr: 5e-5
  numGpus: 1
  pushToHf: marcosremar2/iaratts-100M-erinome
  autoResume: true
  preferSpot: true
  maxSpend: 1.50

Example flag form (text LoRA on Llama):
  ai-gateway gpu finetune submit \\
    --script ./trainers/lora_llama.py \\
    --type text \\
    --dataset hf://my-user/my-instructions \\
    --model hf://meta-llama/Llama-3-8B \\
    --epochs 3 --lr 2e-4 \\
    --push-to-hf my-user/llama3-8b-lora-v1 \\
    --max-spend 3.00 --auto-resume

Defaults per type:
  text:   apt: pkg-config build-essential
          pip: huggingface-hub hf_transfer torch transformers datasets accelerate safetensors
  audio:  apt: pkg-config build-essential libsentencepiece-dev libsndfile1 ffmpeg
          pip: huggingface-hub hf_transfer torch torchaudio safetensors soundfile
  custom: apt: pkg-config build-essential
          pip: huggingface-hub hf_transfer torch safetensors

Pipeline (auto-generated remote command):
  1. apt-get install <type-specific deps + --apt-pkgs>
  2. pip install <type-specific deps + --extra-deps>
  3. hf download <dataset> --include <filter>
  4. hf download <model>
  5. (audio) python <script> encode --input ... --output /root/encoded.pt
     OR multi-GPU: bash encode_multi_gpu.sh ... when numGpus > 1
     (text) python <script> prepare --dataset ... --output /root/prepared.pt
  6. python <script> train --tokens ... --output /workspace/checkpoints
        --epochs N --learning-rate X [--resume /workspace/checkpoints]
  7. hf upload <pushToHf> /workspace/checkpoints (if pushToHf set)

Trainer interface (your script must implement):
  python <script> encode --input <jsonl> --output <pt>     (audio only)
  python <script> prepare --dataset <dir> --output <pt>    (text only)
  python <script> train --tokens <pt> --output <dir>
                        --epochs N --learning-rate X [--resume <ckpt-dir>]

If your script doesn't fit, override with --encode-cmd / --train-cmd in spec.
`,
    gpuTrain: `
ai-gateway gpu train — Training/finetuning-specific wrapper

Composes 'jobs run' with ML defaults: spot instances, $5 budget cap,
mid-run pull every 10min, stall watchdog, pull excludes for cache/dataset,
optional auto-resume from latest checkpoint, optional HF upload on success.

Usage:
  ai-gateway gpu train --script <path> [opts]

Required:
  --script <path>             Local Python script OR directory containing it.
                              Whole dir is rsynced; remote runs the file's basename.

Optional:
  --dataset hf://<repo-id>    Auto-downloaded to /root/data on the GPU
  --dataset-include <glob>    Restrict download to matching paths (e.g. "wav/*").
                              Skip text/ when you only need audio. Saves $ + time.
  --no-hf-transfer            Disable HF_TRANSFER parallel downloads. Use this
                              for datasets with thousands of small files (avoids
                              429 rate limits on huggingface.co).
  --model   hf://<repo-id>    Auto-downloaded to /root/model on the GPU
  --epochs N                  default 4
  --lr X                      default 5e-5
  --gpu <filter>              default "4090"
  --max-cost <usd>            $/h cap when picking offer (default 0.4)
  --max-spend <usd>           Hard $ cap; auto-kills if breached (default 5.00)
  --output <dir>              Local pull dest (default ./checkpoints/run-<ts>)
  --push-to-hf <repo-id>      Upload final /workspace/checkpoints to HF
  --auto-resume               Add '--resume /workspace/checkpoints' to script
  --prefer-spot               Interruptible instance (default ON, --no-spot to opt out)
  --no-spot                   Force on-demand (no spot)
  --reuse                     Skip provisioning if a live owner instance exists
  --extra-args "..."          Appended to the python <script> train command
  --image <ref>               Override docker image (default: marcosremar/gpu-dev:latest)
  --dry-run                   Print plan + cost without spending

Example:
  ai-gateway gpu train --script ./distill/finetune_pocket_tts.py \\
    --dataset hf://marcosremar2/gemini-dataset-erinome \\
    --model   hf://kyutai/pocket-tts \\
    --epochs 4 --lr 5e-5 \\
    --push-to-hf marcosremar2/iaratts-100M-erinome \\
    --max-spend 1.50 --auto-resume

Notes:
  - Auto-installs pkg-config + libsentencepiece-dev + torch wheels on remote
  - Crash → instance kept alive (default). Re-run with --reuse + --auto-resume
  - All 'gpu jobs *' subcommands work on the running train job
`,
    gpuJobs: `
ai-gateway gpu jobs — One-shot GPU jobs with crash-survivable debugging

Subcommands:
  run        Provision GPU, upload, run, pull, terminate
  status     Show saved instance info from last run
  ssh [cmd]  SSH into the saved instance (or run a one-shot command)
  sync [dir] Re-rsync local → /workspace on saved instance
             (defaults to the original --path; pass a dir to override)
  pull [dir] Re-rsync /workspace → local (defaults to original --output)
  exec "cmd" Run a command inside /workspace on the saved instance
  clean      Kill stuck procs + reset GPU mem + wipe /workspace on saved instance
             --keep-workspace  keep /workspace contents
             --cache           also wipe /root/.cache (pip + HF) and /tmp
             --orphans         instead, sweep ALL instances owned by you
  relaunch   Re-run saved --main WITHOUT re-syncing (fast restart after 'clean')
             --main "..." overrides the saved command
  retry      Re-sync local + re-run saved --main (one-step recovery after edits)
             --no-sync to skip rsync; --main "..." to override
  logs       Fetch /workspace/.job.log written by run's --main wrapper
             -f / --follow to tail; -n <lines> for length (default 200)
  cost       Print elapsed hours × pricePerHr (rough live spend)
  history    Show last N completed jobs (default 10) — ts, gpu, $, success
             -n N | --json | --totals
  watch      Live dashboard: cost + stall + GPU/VRAM/RAM/DISK/NET + log tail.
             Refreshes every <interval>s. NET shows live up/down speed + cumulative.
             --interval <sec> (default 10)  -n <log lines> (default 8)
  metrics    Average GPU/VRAM/RAM/DISK/NET over a window (default 60s).
             NET is shown as avg ↓/↑ speed (B/s, KB/s, MB/s, GB/s).
             --window <sec> (default 60)  --json (parseable)
  cleanup    Terminate the saved instance (--force to confirm)

──────────────────────────────────────────────────────────────────
ai-gateway gpu jobs run — Provision → upload → execute → pull → cleanup

Picks cheapest GPU matching --gpu under --max-cost, deploys, uploads workspace
(or git-clones --repo), runs --main inside /workspace.

After --main exits (zero or non-zero), ALWAYS pulls /workspace → --output
(rsync, 3 retries with backoff). The pull happens BEFORE the terminate
decision so failure cannot lose the work product.

Termination logic:
  - pull failed             → KEEP ALIVE (data still only on remote)
  - pull OK + job success   → terminate (unless --keep-alive)
  - pull OK + job failure   → KEEP ALIVE (unless --terminate-on-error)

Usage:
  ai-gateway gpu jobs run --main "<cmd>" (--repo <url> | --path <dir>) [opts]

Required:
  --main "<cmd>"             Shell command to run inside /workspace on the GPU
  --repo <git-url>            Git URL to clone into /workspace (depth 1)
    OR
  --path <local-dir>          Local dir to rsync up to /workspace

Options:
  --gpu <filter>              GPU type filter (default: "4090")
  --max-cost <usd>            Max $/hr cap (default: 0.5)
  --output <dir>              Where to pull /workspace back (default: ./job_output)
  --timeout <min>             Max minutes to wait for ready (default: 60)
  --image <docker-image>      Container image (default: marcosremar/gpu-dev:latest)
  --env "K=V K2=V2"           Env vars exported in the container
  --keep-alive                Never terminate (manual cleanup via 'jobs cleanup')
  --terminate-on-error        Force terminate even on failure (old default)
  --pull-every <min>          Mid-run checkpoint pull cadence (default: 10, 0=off)
                              Protects long jobs — if remote dies at 2h45 of 3h
                              you still have the latest checkpointed state local
  --dry-run                   Pick GPU + print plan + projected max cost.
                              Does NOT deploy or spend any money.
  --stall-min <min>           Warn if /workspace mtime unchanged for N min
                              (default: 30, 0=off). Detects hung machines —
                              user can SIGINT to abort while saving state.
  --max-spend <usd>           Hard $ cap. Polls every 60s; force-terminates
                              when elapsed × pricePerHr ≥ cap.
  --pull-exclude <pattern>    rsync --exclude pattern. Repeatable. Built-in
                              defaults: .cache/ .huggingface/ __pycache__/ *.pyc
  --prefer-spot               Request interruptible/spot instances (≈30-50%
                              cheaper, may be preempted; --auto-resume helps).
  --reuse-instance            If a live owner-tagged instance with same image
                              exists, skip provisioning + reuse it.
  --gpu-fallback              If primary GPU unavailable @ --max-cost, walk a
                              cheaper-GPU ladder (e.g. 4090→3090→A5000→4080).

Crash-recovery flow (default):
  1. Run fails. Instance stays alive, SSH info saved to ~/.babelcast/last_job.json
  2. Inspect:        ai-gateway gpu jobs ssh "tail -50 /var/log/syslog"
  3. Fix locally and re-push:
                     ai-gateway gpu jobs sync     # rsyncs local --path → /workspace
  4. Re-run:         ai-gateway gpu jobs retry    # sync + re-run saved --main
                     # OR for a fresh slate before re-running:
                     ai-gateway gpu jobs clean    # wipe workspace + free GPU
                     ai-gateway gpu jobs sync     # push current local state
                     ai-gateway gpu jobs relaunch # re-run saved --main (no resync)
  5. Pull results:   ai-gateway gpu jobs pull
  6. Done:           ai-gateway gpu jobs cleanup --force

Examples:
  ai-gateway gpu jobs run \\
    --path ./iaratts \\
    --main "pip install -r requirements.txt && python finetune_pocket_tts.py train" \\
    --gpu 4090 --max-cost 0.4 --output ./checkpoints

  # Job died → debug → retry → cleanup
  ai-gateway gpu jobs ssh
  ai-gateway gpu jobs sync
  ai-gateway gpu jobs exec "python finetune_pocket_tts.py train --resume"
  ai-gateway gpu jobs pull
  ai-gateway gpu jobs cleanup --force

Notes:
  - Default keeps instance alive on error → DO NOT FORGET 'jobs cleanup'
  - State persists in ~/.babelcast/last_job.json across CLI invocations
  - Owner-prefixed label so 'gpu list --mine' picks it up
  - rsync requires SSH access to the pod (provider must expose 22/tcp)
`,
    metrics: `
ai-gateway metrics — Show gateway metrics

Usage:
  ai-gateway metrics [options]

Options:
  --json                       Output in JSON format (for the web UI)
                               Default: Prometheus text exposition format

Metrics include:
  - gateway_requests_total           Total requests served
  - gateway_errors_total             Total errors
  - gateway_latency_p50/p95/p99_ms   Latency percentiles
  - gateway_requests_by_provider     Requests per provider (groq, gpu, fal...)
  - gateway_requests_by_stage        Requests per stage (stt, llm, tts)
  - gateway_tokens_input/output_total Token usage
  - gateway_daily_spend_usd          GPU cost tracking
  - gateway_gpu_ready                GPU availability (1=ready, 0=down)

Notes:
  - Metrics require the full server, not the lightweight proxy
  - Prometheus format is scrape-ready for Grafana / Prometheus

Examples:
  ai-gateway metrics
  ai-gateway metrics --json
`,
    services: `
ai-gateway services — Show all services, providers, and their status

Usage:
  ai-gateway services [options]

Options:
  --json                       Output raw JSON (health + config combined)

Shows a consolidated view of:
  - Overall gateway status and uptime
  - Pipeline components (STT, LLM, TTS) and which provider serves each
  - GPU deployment status
  - AI provider availability (which API keys are configured)
  - Provider account balances and low-balance alerts
  - Provider performance (latency, requests, error rate, token usage)
  - Open circuit breakers (if any)
  - Fallback chains (provider failover order)
  - Daily budget spend
  - Request latency percentiles

Examples:
  ai-gateway services
  ai-gateway services --json
`,
    apps: `
ai-gateway apps — List and manage app configurations

Usage:
  ai-gateway apps

Shows all configured apps with their active status, latency targets,
and GPU deploy image. The active app determines which pipeline chains
(STT → LLM → TTS) the gateway uses for requests.

Each app binds services (cloud APIs, Docker containers, serverless)
into a named pipeline configuration for a specific use case.

Notes:
  - 'ai-gateway profiles' is an alias for this command
  - Apps are stored in ~/.babelcast/provider-config.json
  - The active app's chains are copied to the top-level pipeline config

Examples:
  ai-gateway apps
`,
    health: `
ai-gateway health — Check gateway health

Usage:
  ai-gateway health

Output:
  Status: ok
  Connections: active=N, peak=M

Notes:
  - Returns the gateway process health and active connection count
  - A steadily rising 'active' count under constant load signals a leak
  - Does not check provider health (Groq, fal.ai may be down independently)
  - Does not require authentication
`,
    models: `
ai-gateway models — List available models

Usage:
  ai-gateway models

Output:
  Lists all model IDs configured on the gateway, grouped by capability:
  - Chat/LLM models (llama-3.1-8b-instant, llama-3.3-70b-versatile, etc.)
  - STT models (whisper-large-v3, whisper-large-v3-turbo)
  - TTS models (canopylabs/orpheus-v1-english, etc.)

Chat model shortcuts:
  - @app/llm resolves from the authenticated App/Profile (AIGW_APP_KEY → userId)
  - openrouter/<model> forces OpenRouter and sends <model> upstream
    Example: openrouter/meta-llama/llama-3.1-8b-instruct
  - Capabilities: llm=text chat, vision=image+text, stt=audio transcription, tts=speech output

Notes:
  - Only models configured on this gateway instance are shown
  - Proprietary models (gpt-4o, claude-3, etc.) are NOT available
    unless explicitly configured with their API keys
`,
    translate: `
ai-gateway translate — Translate text between languages

Usage:
  ai-gateway translate <text> [options]

Arguments:
  <text>                       Text to translate (required)

Options:
  --from <lang>                Source language (default: auto-detect)
  --to <lang>                  Target language (default: en)
  -m, --model <model>          LLM model for translation
                               Default: llama-3.3-70b-versatile

Examples:
  ai-gateway translate "Bonjour le monde"
  ai-gateway translate "Hello world" --to fr
  ai-gateway translate "Hola" --from es --to pt
`,
    voices: `
ai-gateway voices — List available TTS voices

Usage:
  ai-gateway voices

Shows all voice names for each TTS model with gender labels.
`,
    latency: `
ai-gateway latency — GPU host latency analysis

Usage:
  ai-gateway latency <subcommand> [options]

Subcommands:
  hosts                        Show all measured host latencies
    --gpu <filter>               Filter by GPU name (e.g. "4090", "A100")
    --sort <field>               Sort by: latency (default), reputation
    -n <count>                   Number of hosts to show (default: 15)
  probe                        Trigger a latency probe cycle NOW
  best                         Show best GPU offers ranked by real-time score
    --gpu <filter>               Filter by GPU name
    -n <count>                   Number of offers (default: 10)

The "best" command combines GPU offers with latency data to rank by
real-time suitability: quality = TCP_latency×0.6 + reputation×0.3

Examples:
  ai-gateway latency hosts
  ai-gateway latency hosts --gpu 4090 --sort reputation
  ai-gateway latency probe
  ai-gateway latency best
  ai-gateway latency best --gpu 4090 -n 5
`,
    whoami: `
ai-gateway whoami — Show which user this API key is associated with

Usage:
  ai-gateway whoami

Output:
  User:    marcos        (userId from the key format key:userId)
  Key:     abc12345...   (masked)
  Gateway: https://...   (current gateway URL)
  Auth:    valid ✓       (confirms the key is accepted)

Notes:
  - API keys can carry a userId: GATEWAY_API_KEYS="key1:marcos,key2:bot"
  - Plain keys without ":" map to userId "default"
  - The userId is logged with every request for attribution
`,
    config: `
ai-gateway config — Show current configuration

Usage:
  ai-gateway config

Shows:
  - Gateway URL (from AI_GATEWAY_URL env var)
  - API key (masked, from AI_GATEWAY_KEY env var)
  - Connection status (tests /health endpoint)
`,
    ping: `
ai-gateway ping — Measure gateway latency

Usage:
  ai-gateway ping [options]

Options:
  -n, --count <n>              Number of pings (default: 5)

Output:
  Per-request latency + summary with avg/p50/p95

Examples:
  ai-gateway ping
  ai-gateway ping -n 10
`,
    benchmark: `
ai-gateway benchmark — Run latency benchmark across endpoints

Usage:
  ai-gateway benchmark [options]

Options:
  -n, --count <n>              Requests per endpoint (default: 5)

Endpoints tested:
  - POST /v1/chat/completions (3-token response)
  - POST /v1/audio/transcriptions (1s silence)
  - POST /v1/audio/speech (short text)

Output:
  avg/p50/p95 per endpoint

Examples:
  ai-gateway benchmark
  ai-gateway benchmark -n 10
`,
  };

  // Per-command help: `ai-gateway chat help` or `ai-gateway chat --help`
  if (args[1] === 'help' || args[1] === '--help' || args[1] === '-h') {
    const sub = args[0];
    if (HELP[sub]) { console.log(HELP[sub]); return; }
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    // Show subcommand help if specified: `ai-gateway help chat`
    const sub = args[1];
    if (sub && HELP[sub]) { console.log(HELP[sub]); return; }
    console.log(HELP.main);
    return;
  }

  // Server management commands (don't need ensureLocalServer)
  if (cmd === 'server') {
    const sub = args[1];
    if (sub === 'help' || sub === '--help' || !sub) {
      console.log(HELP.server || `
ai-gateway server — Manage the local dev server

  ai-gateway server status   Show if the server is running
  ai-gateway server stop     Stop the auto-started server
  ai-gateway server start    Start the server in background
`);
      return;
    }
    switch (sub) {
      case 'status': await cmdServerStatus(); return;
      case 'stop': await cmdServerStop(); return;
      case 'start': await ensureLocalServer(); console.log('Server is running.'); return;
      default: console.error('Usage: ai-gateway server <status|start|stop>'); process.exit(1);
    }
  }

  // Auto-start local dev server if needed (only for localhost URLs)
  await ensureLocalServer();

  // ── Low balance warning ($5 threshold) ──
  // Check on every command so the user is always aware of billing risks.
  try {
    const { url: gwUrl } = getConfig();
    const hRes = await fetch(`${gwUrl}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (hRes?.ok) {
      const hData = await hRes.json().catch(() => null);
      const balances = hData?.providerBalances || [];
      const low = balances.filter((b: any) => b.balance != null && b.balance < 5 && b.balance >= 0);
      if (low.length > 0) {
        const names = low.map((b: any) => `${b.provider || b.name}: $${Number(b.balance).toFixed(2)}`).join(', ');
        console.error(`\n${c.red}${c.bold}⚠ LOW BALANCE WARNING${c.reset}${c.red} — ${names}`);
        console.error(`  Providers with <$5 may fail to deploy or auto-stop machines.${c.reset}\n`);
      }
    }
  } catch { /* best effort — don't block commands */ }

  try {
    switch (cmd) {
      case 'health':
        await cmdHealth();
        break;
      case 'services':
        await cmdServices({ json: hasFlag(args, '--json') });
        break;
      case 'models':
        await cmdModels();
        break;
      case 'version':
        await cmdVersion();
        break;
      case 'detect-language': {
        const text = args.slice(1).filter(a => !a.startsWith('-')).join(' ') || await readStdin();
        if (!text) { console.error('Usage: ai-gateway detect-language "text" or echo "text" | ai-gateway detect-language'); process.exit(1); }
        await cmdDetectLanguage(text);
        break;
      }
      case 'logs':
        await cmdLogs({
          limit: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
          format: hasFlag(args, '--json') ? 'json' : undefined,
        });
        break;
      case 'apps':
      case 'profiles':  // legacy alias
        await cmdApps(args[1]);
        break;
      case 'balance':
        await cmdBalance();
        break;
      case 'chat': {
        const imagePaths = [...getArgs(args, '-i'), ...getArgs(args, '--image')];
        let msg = chatMessageArgs(args, new Set(['-m', '--model', '--max-tokens', '-i', '--image'])).join(' ');
        // Support piped input: echo "hello" | ai-gateway chat
        if (!msg) msg = (await readStdin()) || '';
        if (!msg) { console.error('Usage: ai-gateway chat "your message" or echo "msg" | ai-gateway chat'); process.exit(1); }
        await cmdChat(msg, {
          model: getArg(args, '-m') || getArg(args, '--model'),
          stream: !hasFlag(args, '--no-stream'),
          maxTokens: getArg(args, '--max-tokens') ? parseInt(getArg(args, '--max-tokens')!) : undefined,
          imagePaths,
        });
        break;
      }
      case 'transcribe': {
        const file = args[1];
        if (!file || file.startsWith('-')) { console.error('Usage: ai-gateway transcribe <file>'); process.exit(1); }
        await cmdTranscribe(file, {
          model: getArg(args, '-m') || getArg(args, '--model'),
          language: getArg(args, '-l') || getArg(args, '--language'),
          prompt: getArg(args, '--prompt'),
        });
        break;
      }
      case 'speech': {
        const file = args[1];
        if (!file || file.startsWith('-')) { console.error('Usage: ai-gateway speech <audio-file>'); process.exit(1); }
        await cmdSpeech(file, {
          source: getArg(args, '--from') || getArg(args, '--source'),
          target: getArg(args, '--to') || getArg(args, '--target'),
          speaker: getArg(args, '--speaker'),
          prompt: getArg(args, '--prompt'),
          refText: getArg(args, '--ref-text'),
          referenceAudio: getArg(args, '--reference-audio'),
          output: getArg(args, '-o') || getArg(args, '--output'),
          json: hasFlag(args, '--json'),
        });
        break;
      }
      case 'media': {
        const sub = args[1];
        if (sub !== 'test') { console.error('Usage: ai-gateway media test --image <path> --audio <path>'); process.exit(1); }
        await cmdMediaTest({
          image: getArg(args, '--image'),
          audio: getArg(args, '--audio'),
          model: getArg(args, '-m') || getArg(args, '--model'),
        });
        break;
      }
      case 'tts': {
        let text = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        if (!text) text = (await readStdin()) || '';
        if (!text) { console.error('Usage: ai-gateway tts "your text" or echo "text" | ai-gateway tts'); process.exit(1); }
        await cmdTTS(text, {
          voice: getArg(args, '-v') || getArg(args, '--voice'),
          output: getArg(args, '-o') || getArg(args, '--output'),
          model: getArg(args, '-m') || getArg(args, '--model'),
        });
        break;
      }
      case 'image': {
        const prompt = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        if (!prompt) { console.error('Usage: ai-gateway image "your prompt"'); process.exit(1); }
        await cmdImage(prompt, {
          output: getArg(args, '-o') || getArg(args, '--output'),
          model: getArg(args, '-m') || getArg(args, '--model'),
        });
        break;
      }
      case 'app': {
        const sub = args[1];
        if (!sub || sub === 'help' || sub === '--help') {
          console.log(`
ai-gateway app — per-application API key management

  app init <app-name>      Generate a new API key for this app and store it
                           in the cwd .env (as AIGW_APP_KEY=...). Prints the
                           line to add to the gateway's GATEWAY_API_KEYS env.
  app whoami               Probe /health with the current key and print
                           the userId the gateway resolves us as (or admin).
  app key                  Print the currently configured AIGW_APP_KEY
                           (masked unless --reveal is given).

Per-app isolation:
  - Server-side: when GATEWAY_API_KEYS is set, each Bearer maps to a userId.
    Deploys auto-prefix the label with "<userId>/". gpu list filters to the
    caller's instances. gpu terminate refuses cross-app destruction.
  - Operator (loopback, no key): bypasses the filter — sees and can manage
    everything (admin mode for local dev).
`);
          break;
        }
        await cmdAppDispatch(sub, args.slice(2));
        break;
      }
      case 'docker': {
        const sub = args[1];
        if (!sub || sub === 'help' || sub === '--help') {
          console.log(HELP.docker || ''); break;
        }
        switch (sub) {
          case 'auth': {
            const authSub = args[2];
            if (authSub === 'logout' || authSub === 'revoke') { await cmdDockerAuthLogout(); break; }
            if (authSub === 'status' || authSub === 'me') { await cmdDockerAuthStatus(); break; }
            await cmdDockerAuth();
            break;
          }
          case 'build': {
            const dir = args[2];
            if (!dir || dir.startsWith('-')) {
              console.error('Usage: ai-gateway docker build <directory> [options]');
              process.exit(1);
            }
            const deployFlag = hasFlag(args, '--deploy');
            await cmdDockerBuild(dir, {
              name: getArg(args, '--name'),
              tag: getArg(args, '--tag'),
              repo: getArg(args, '--repo'),
              platforms: getArg(args, '--platforms'),
              public: hasFlag(args, '--public'),
              wait: hasFlag(args, '--wait') || deployFlag, // --deploy implies --wait
              deploy: deployFlag,
              gpuTypes: getArg(args, '--gpu-types'),
            });
            break;
          }
          case 'list': await cmdDockerList(); break;
          case 'images': await cmdDockerImages(); break;
          case 'status': {
            const buildId = args[2];
            if (!buildId) { console.error('Usage: ai-gateway docker status <buildId>'); process.exit(1); }
            await cmdDockerStatus(buildId);
            break;
          }
          default:
            console.error(`Unknown docker subcommand: ${sub}`);
            console.log(HELP.docker || '');
        }
        break;
      }
      case 'latency': {
        const sub = args[1];
        if (sub === 'help' || sub === '--help' || !sub) {
          console.log(HELP.latency || ''); break;
        }
        switch (sub) {
          case 'hosts': await cmdLatencyHosts({
            gpu: getArg(args, '--gpu'),
            limit: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
            sort: getArg(args, '--sort'),
          }); break;
          case 'probe': await cmdLatencyProbe(); break;
          case 'best': await cmdGpuBest({
            gpu: getArg(args, '--gpu'),
            count: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
          }); break;
          default:
            console.error('Usage: ai-gateway latency <hosts|probe|best>');
            process.exit(1);
        }
        break;
      }
      case 'gpu': {
        const sub = args[1];
        if (sub === 'help' || sub === '--help') { console.log(HELP.gpu); break; }
        switch (sub) {
          case 'status': await cmdGpuStatus(); break;
          case 'list': await cmdGpuList({
            // --probe (default true unless --no-probe). We pass undefined
            // to keep the default; only set false if user opts out.
            probe: args.includes('--no-probe') ? false : true,
            json: args.includes('--json'),
            mine: args.includes('--mine'),
            label: getArg(args, '--label'),
          }); break;
          case 'doctor': await cmdGpuDoctor({
            instance: getArg(args, '--instance'),
            json: args.includes('--json'),
          }); break;
          case 'wait': {
            const inst = getArg(args, '--instance');
            const timeout = getArg(args, '--timeout') ? parseInt(getArg(args, '--timeout')!) : undefined;
            if (inst) {
              await cmdGpuWait({
                instance: inst,
                timeout,
                intervalSec: getArg(args, '--interval') ? parseInt(getArg(args, '--interval')!) : undefined,
              });
            } else {
              await cmdGpuWaitActive({ timeout });
            }
            break;
          }
          case 'offers': await cmdGpuOffers({
            gpu: getArg(args, '--gpu'),
            limit: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
            provider: getArg(args, '--provider'),
          }); break;
          case 'deploy': await cmdGpuDeploy({
            image: getArg(args, '--image'),
            gpuTypes: getArg(args, '--gpu-types'),
            onstart: getArg(args, '--onstart'),
            storageGb: getArg(args, '--storage') ? parseInt(getArg(args, '--storage')!) : undefined,
            numGpus: getArg(args, '--num-gpus') ? parseInt(getArg(args, '--num-gpus')!) : undefined,
            env: getArg(args, '--env'),
            devMode: hasFlag(args, '--dev-mode'),
            readinessProbe: getArg(args, '--readiness-probe'),
            label: getArg(args, '--label'),
            // --no-strict-fast-boot opts OUT of the strict filter (default ON)
            strictFastBoot: hasFlag(args, '--no-strict-fast-boot') ? false : undefined,
            searchMode: getArg(args, '--search-mode'),
            // --allow-unverified opts INTO Vast deverified/unverified rentable hosts
            // (only path when no verified offer is rentable for the requested GPU)
            allowUnverified: hasFlag(args, '--allow-unverified') ? true : undefined,
            // --provider restricts deploy to a single provider (vast, runpod, modal,
            // hyperstack, tensordock). Bypasses tier cascade race.
            provider: getArg(args, '--provider'),
          }); break;
          case 'stop': await cmdGpuStop({
            deployId: getArg(args, '--deploy-id'),
          }); break;
          case 'resume': await cmdGpuResume(args[2], {
            provider: getArg(args, '--provider'),
            deployId: getArg(args, '--deploy-id'),
          }); break;
          case 'terminate': {
            const id = args[2];
            if (!id || id.startsWith('-')) { console.error('Usage: ai-gateway gpu terminate <instanceId>'); process.exit(1); }
            await cmdGpuTerminate(id, {
              provider: getArg(args, '--provider'),
              deployId: getArg(args, '--deploy-id'),
              force: hasFlag(args, '--force'),
            });
            break;
          }
          case 'logs': await cmdGpuLogs(); break;
          case 'ssh': {
            // Parse --instance and --image flags for multi-GPU targeting,
            // then treat everything else after 'gpu ssh' as the remote command.
            const gpuSshTarget: GpuTargetOpts = {
              instance: getArg(args, '--instance'),
              image: getArg(args, '--image'),
            };
            // Strip our flags from the args to build the remote command
            const sshParts: string[] = [];
            const sshSlice = args.slice(2);
            for (let si = 0; si < sshSlice.length; si++) {
              if ((sshSlice[si] === '--instance' || sshSlice[si] === '--image') && si + 1 < sshSlice.length) {
                si++; // skip flag and its value
              } else {
                sshParts.push(sshSlice[si]);
              }
            }
            const sshCmd = sshParts.join(' ') || undefined;
            await cmdGpuSsh(sshCmd, gpuSshTarget);
            break;
          }
          case 'patch': {
            const gpuPatchTarget: GpuTargetOpts = {
              instance: getArg(args, '--instance'),
              image: getArg(args, '--image'),
            };
            // Find the local file arg: first positional arg after 'gpu patch' that is not a flag or flag value
            const patchSlice = args.slice(2);
            const patchPositional: string[] = [];
            for (let pi = 0; pi < patchSlice.length; pi++) {
              if (patchSlice[pi] === '--instance' || patchSlice[pi] === '--image') {
                pi++; // skip flag and its value
              } else if (patchSlice[pi] === '--no-restart') {
                // skip boolean flag
              } else {
                patchPositional.push(patchSlice[pi]);
              }
            }
            const patchFile = patchPositional[0];
            if (!patchFile) {
              console.error('Usage: ai-gateway gpu patch <local-file> [remote-path] [--no-restart] [--instance <id>] [--image <name>]');
              process.exit(1);
            }
            const patchRemote = patchPositional[1] || undefined;
            await cmdGpuPatch(patchFile, patchRemote, { noRestart: hasFlag(args, '--no-restart') }, gpuPatchTarget);
            break;
          }
          case 'commit': {
            const gpuCommitTarget: GpuTargetOpts = {
              instance: getArg(args, '--instance'),
              image: getArg(args, '--image'),
            };
            const commitMessage = getArg(args, '-m') || getArg(args, '--message');
            await cmdGpuCommit(gpuCommitTarget, { message: commitMessage });
            break;
          }
          case 'pull': {
            const gpuPullTarget: GpuTargetOpts = {
              instance: getArg(args, '--instance'),
              image: getArg(args, '--image'),
            };
            const pullSlice = args.slice(2);
            const pullPos: string[] = [];
            for (let pi = 0; pi < pullSlice.length; pi++) {
              if (pullSlice[pi] === '--instance' || pullSlice[pi] === '--image') { pi++; }
              else { pullPos.push(pullSlice[pi]); }
            }
            const remoteFile = pullPos[0];
            if (!remoteFile) {
              console.error('Usage: ai-gateway gpu pull <remote-file> [local-path] [--instance <id>] [--image <name>]');
              process.exit(1);
            }
            await cmdGpuPull(remoteFile, pullPos[1], gpuPullTarget);
            break;
          }
          case 'dev':
            await cmdGpuDev(args);
            break;
          case 'hyperstack':
            await cmdGpuHyperstack(args.slice(2));
            break;
          case 'finetune': {
            // Fireworks-style declarative finetune. Either --spec <yaml/json> OR flags.
            // Auto-detect ./train.yaml if no --spec/--f flag.
            let specFile = getArg(args, '--spec') || getArg(args, '-f');
            if (!specFile && existsSync('./train.yaml')) {
              specFile = './train.yaml';
              console.log(`[auto] using ./train.yaml`);
            }
            let spec: any = {};
            if (specFile) {
              if (!existsSync(specFile)) { console.error(`spec not found: ${specFile}`); process.exit(1); }
              const raw = readFileSync(specFile, 'utf-8');
              try { spec = JSON.parse(raw); } catch {
                // Minimal YAML parser: lines `key: value`. Strip inline `#` comments.
                spec = {};
                for (const line of raw.split('\n')) {
                  // Skip pure comment lines
                  if (line.trim().startsWith('#')) continue;
                  const m = line.match(/^([\w-]+):\s*(.*?)\s*$/);
                  if (m) {
                    let v = m[2].trim();
                    // Strip inline comment (NOT inside quotes — naive but works here)
                    if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('[') && !v.startsWith('{')) {
                      const hashIdx = v.indexOf('#');
                      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
                    }
                    // JSON array / object inline values: try-parse so spec.providers etc.
                    // come through as the right shape rather than a literal string.
                    if (v.startsWith('[') || v.startsWith('{')) {
                      try { spec[m[1]] = JSON.parse(v); continue; } catch { /* fall through */ }
                    }
                    spec[m[1]] = v.match(/^-?\d+$/) ? parseInt(v) :
                                 v.match(/^-?\d*\.?\d+([eE][-+]?\d+)?$/) ? parseFloat(v) :
                                 v === 'true' ? true : v === 'false' ? false :
                                 v.replace(/^["']|["']$/g, '');
                  }
                }
              }
            }
            const sub = args[2];
            if (!sub || sub === 'help' || sub === '--help') { console.log(HELP.gpuFinetune); break; }
            if (sub === 'submit' || sub === 'run') {
              const script = getArg(args, '--script') || spec.script;
              const specProject = getArg(args, '--project') || spec.project;
              const specType = getArg(args, '--type') || spec.type;

              // Resolve project → inject defaults + derive preset name
              let resolvedType = specType;
              if (specProject) {
                const { loadProject, resolveProjectOpts } = await import('../src/modules/gpu-finetune/index.js');
                const proj = loadProject(specProject);
                if (!proj) {
                  console.error(`Unknown project '${specProject}'. Run 'ai-gateway gpu finetune projects' to list available.`);
                  process.exit(1);
                }
                const { opts: merged } = resolveProjectOpts({ ...spec, project: specProject });
                Object.assign(spec, merged);
                resolvedType = proj.manifest.preset;
                console.log(`[project] ${specProject} → preset: ${resolvedType}`);
              }

              const isPreset = resolvedType && loadPreset(resolvedType);
              if (!script && !isPreset) {
                console.error('Need --script <path>, "script:" in spec, OR a built-in preset/project type');
                process.exit(1);
              }
              if (isPreset) {
                console.log(`[preset] using bundled trainer: ${resolvedType}`);
              }
              // #11 Validate spec before deploy. Merge CLI overrides (--type,
              // --dataset, --hf-base, --gpu) into the validation payload so
              // pure-CLI invocations (no yaml) don't trip "missing required".
              const specForValidation = {
                ...spec,
                script,
                type: resolvedType || getArg(args, '--type') || spec.type,
                dataset: getArg(args, '--dataset') || spec.dataset,
                hfBase: getArg(args, '--hf-base') || spec.hfBase,
                gpu: getArg(args, '--gpu') || spec.gpu,
              };
              const specErrs = validateFinetuneSpec(specForValidation);
              if (specErrs.length > 0) {
                console.error('✗ spec invalid:');
                specErrs.forEach((e) => console.error(`  - ${e}`));
                process.exit(1);
              }
              // Fail-fast preflight: live HF/R2/script checks before GPU spend.
              // Skipped on --dry-run/--skip-preflight; --preflight-only exits after.
              const preflightOnly = hasFlag(args, '--preflight-only');
              if (!hasFlag(args, '--skip-preflight') && (!hasFlag(args, '--dry-run') || preflightOnly)) {
                console.log('[preflight] checking dataset/model/token/storage…');
                const pf = await runFinetunePreflight({
                  ...specForValidation,
                  scriptPath: script,
                  model: getArg(args, '--model') || spec.model,
                  pushToHf: getArg(args, '--push-to-hf') || spec.pushToHf,
                  prepare: spec.prepare,
                  r2Bucket: getArg(args, '--r2-bucket') || spec.r2Bucket,
                  resumeFromR2: hasFlag(args, '--resume-from-r2') || spec.resumeFromR2 === true,
                } as Partial<FinetuneOpts>);
                if (!pf.ok) {
                  console.error('✗ preflight failed — aborting before GPU spend. Fix the above or pass --skip-preflight.');
                  process.exit(1);
                }
                if (preflightOnly) { console.log('✓ preflight passed (--preflight-only, not deploying)'); break; }
              }
              // #4 Show estimate before submit (unless dry-run already does).
              // Merge CLI overrides so the prediction reflects what'll actually run.
              if (!hasFlag(args, '--dry-run') && !hasFlag(args, '--no-estimate')) {
                const est = estimateFinetuneCost({
                  type: getArg(args, '--type') || spec.type || 'audio', scriptPath: script,
                  epochs: getArg(args, '--epochs') ? parseInt(getArg(args, '--epochs')!) : spec.epochs,
                  numGpus: getArg(args, '--num-gpus') ? parseInt(getArg(args, '--num-gpus')!) : spec.numGpus,
                  maxSamples: getArg(args, '--max-samples') ? parseInt(getArg(args, '--max-samples')!) : spec.maxSamples,
                  batchSize: getArg(args, '--batch-size') ? parseInt(getArg(args, '--batch-size')!) : spec.batchSize,
                  gradAccum: getArg(args, '--grad-accum') ? parseInt(getArg(args, '--grad-accum')!) : spec.gradAccum,
                } as any);
                console.log(`${c.dim}[estimate] ~${est.totalMin.toFixed(0)}min, ~$${est.totalUsd.toFixed(2)}${c.reset}`);
              }
              // #5 Record run — capture merged spec + CLI overrides so history
              // entries reflect what was actually requested (not just yaml).
              const mergedSpec = {
                ...spec,
                script,
                type: specType,
                dataset: getArg(args, '--dataset') || spec.dataset,
                hfBase: getArg(args, '--hf-base') || spec.hfBase,
                gpu: getArg(args, '--gpu') || spec.gpu,
                epochs: getArg(args, '--epochs') ? parseInt(getArg(args, '--epochs')!) : spec.epochs,
                lr: getArg(args, '--lr') ? parseFloat(getArg(args, '--lr')!) : spec.lr,
                quality: getArg(args, '--quality') || spec.quality,
              };
              recordFinetuneRun(mergedSpec, { ts: new Date().toISOString() });
              await cmdGpuFinetune({
                type: (resolvedType || specType || 'audio') as any,
                project: specProject,
                localPath: getArg(args, '--local-path') || spec.localPath,
                scriptPath: script || '',  // empty triggers preset fill
                dataset: getArg(args, '--dataset') || spec.dataset,
                datasetInclude: getArg(args, '--dataset-include') || spec['dataset-include'] || spec.datasetInclude,
                noHfTransfer: hasFlag(args, '--no-hf-transfer') || spec.noHfTransfer === true,
                model: getArg(args, '--model') || spec.model,
                prepCmd: getArg(args, '--prep-cmd') || spec.prepCmd,
                encodeCmd: getArg(args, '--encode-cmd') || spec.encodeCmd,
                trainCmd: getArg(args, '--train-cmd') || spec.trainCmd,
                epochs: getArg(args, '--epochs') ? parseInt(getArg(args, '--epochs')!) : spec.epochs,
                lr: getArg(args, '--lr') ? parseFloat(getArg(args, '--lr')!) : spec.lr,
                numGpus: getArg(args, '--num-gpus') ? parseInt(getArg(args, '--num-gpus')!) : spec.numGpus,
                maxSamples: getArg(args, '--max-samples') ? parseInt(getArg(args, '--max-samples')!) : spec.maxSamples,
                gpu: getArg(args, '--gpu') || spec.gpu,
                maxCost: getArg(args, '--max-cost') ? parseFloat(getArg(args, '--max-cost')!) : spec.maxCost,
                maxSpend: getArg(args, '--max-spend') ? parseFloat(getArg(args, '--max-spend')!) : spec.maxSpend,
                output: getArg(args, '--output') || spec.output,
                pushToHf: getArg(args, '--push-to-hf') || spec.pushToHf,
                // Crash-survivable by default: resume from last checkpoint unless
                // explicitly disabled (--no-resume / spec autoResume:false). Losing
                // progress is worse than a redundant resume check on a fresh run.
                autoResume: hasFlag(args, '--no-resume') ? false : (spec.autoResume !== false),
                preferSpot: hasFlag(args, '--no-spot') ? false : (hasFlag(args, '--prefer-spot') || (spec.preferSpot !== false && spec.preferSpot !== 'false')),
                selectMode: (getArg(args, '--select-mode') as 'cheapest' | 'balanced' | 'fast') || (spec.selectMode as 'cheapest' | 'balanced' | 'fast') || 'balanced',
                reuse: hasFlag(args, '--reuse') || spec.reuse === true,
                extraTrainArgs: getArg(args, '--extra-args') || spec.extraTrainArgs,
                extraDeps: getArg(args, '--extra-deps') || spec.extraDeps,
                aptPkgs: getArg(args, '--apt-pkgs') || spec.aptPkgs,
                dryRun: hasFlag(args, '--dry-run') || spec.dryRun === true,
                smoke: hasFlag(args, '--smoke') || spec.smoke === true,
                skipSmoke: hasFlag(args, '--no-smoke') || spec.skipSmoke === true,
                persistCache: hasFlag(args, '--persist-cache') || spec.persistCache === true,
                // Default to 3 spot-preemption retries (each re-deploys + resumes
                // from latest checkpoint). The count IS the crash-loop guard — set
                // 0 to disable. Capped at 10 by validateSpec.
                retryOnPreempt: getArg(args, '--retry-on-preempt') ? parseInt(getArg(args, '--retry-on-preempt')!) : (spec.retryOnPreempt ?? 3),
                // R2/S3 durable storage — flags OR spec (yaml). Without these the
                // runner can't restore/backup checkpoints across spot preemption.
                r2Bucket: getArg(args, '--r2-bucket') || spec.r2Bucket,
                r2Prefix: getArg(args, '--r2-prefix') || spec.r2Prefix,
                resumeFromR2: hasFlag(args, '--resume-from-r2') || spec.resumeFromR2 === true,
                incremental: hasFlag(args, '--incremental') || spec.incremental === true,
                autoFix: hasFlag(args, '--auto-fix') || spec.autoFix === true,
                plugin: getArg(args, '--plugin') || spec.plugin,
                watchWer: getArg(args, '--watch-wer') || spec.watchWer,
                webDashboard: hasFlag(args, '--web') || spec.webDashboard === true,
                wandb: getArg(args, '--wandb-project') ? { project: getArg(args, '--wandb-project')! } : spec.wandb,
                notifyOnComplete: getArg(args, '--notify-url') || spec.notifyOnComplete,
                secrets: spec.secrets,
                providers: getArg(args, '--providers') ? getArg(args, '--providers')!.split(',') : spec.providers,
                failoverOnPreempt: hasFlag(args, '--failover-on-preempt') || spec.failoverOnPreempt === true,
                ckptAverage: getArg(args, '--ckpt-avg') ? parseInt(getArg(args, '--ckpt-avg')!) : spec.ckptAverage,
                exportGguf: hasFlag(args, '--export-gguf') || spec.exportGguf === true,
                hfBase: getArg(args, '--hf-base') || spec.hfBase,
                hfStructure: (getArg(args, '--hf-structure') as any) || spec.hfStructure,
                fromHf: getArg(args, '--from-hf') || spec.fromHf,
                // Round 8 — quality automation + Tier 2
                quality: (getArg(args, '--quality') as any) || spec.quality,
                autoStopPlateau: getArg(args, '--auto-stop-plateau') ? parseInt(getArg(args, '--auto-stop-plateau')!) : spec.autoStopPlateau,
                torchCompile: hasFlag(args, '--torch-compile') ? true : (hasFlag(args, '--no-torch-compile') ? false : spec.torchCompile),
                // Leave undefined when neither flag nor spec set it, so quality:fast
                // can default it to true. `false || false` → false would stop the fallback.
                augmentPitch: hasFlag(args, '--augment-pitch') ? true : spec.augmentPitch,
                augmentSpeed: hasFlag(args, '--augment-speed') ? true : spec.augmentSpeed,
                saveEverySteps: getArg(args, '--save-every-steps') ? parseInt(getArg(args, '--save-every-steps')!) : spec.saveEverySteps,
                image: getArg(args, '--image') || spec.image,
                batchSize: getArg(args, '--batch-size') ? parseInt(getArg(args, '--batch-size')!) : spec.batchSize,
                gradAccum: getArg(args, '--grad-accum') ? parseInt(getArg(args, '--grad-accum')!) : spec.gradAccum,
                weightDecay: getArg(args, '--weight-decay') ? parseFloat(getArg(args, '--weight-decay')!) : spec.weightDecay,
                warmupSteps: getArg(args, '--warmup-steps') ? parseInt(getArg(args, '--warmup-steps')!) : spec.warmupSteps,
                freezeBackboneLayers: getArg(args, '--freeze-backbone-layers') ? parseInt(getArg(args, '--freeze-backbone-layers')!) : spec.freezeBackboneLayers,
                onlyFlowNet: hasFlag(args, '--only-flow-net') || spec.onlyFlowNet === true,
                curriculum: (getArg(args, '--curriculum') as any) || spec.curriculum,
                gpuFallback: hasFlag(args, '--no-gpu-fallback') ? false : (hasFlag(args, '--gpu-fallback') || spec.gpuFallback !== false),
                prepare: spec.prepare,  // auto (default) | skip | <custom command>
                aigwVersion: spec.aigwVersion,  // pin check vs. bundled preset.manifest.version
                multiDataset: spec.multiDataset,  // weighted multi-dataset → trainer --multi-dataset
                autoLrRewind: hasFlag(args, '--auto-lr-rewind') || spec.autoLrRewind === true,
                rewindThreshold: getArg(args, '--rewind-threshold') ? parseFloat(getArg(args, '--rewind-threshold')!) : spec.rewindThreshold,
                seed: getArg(args, '--seed') ? parseInt(getArg(args, '--seed')!) : spec.seed,
                gradClip: getArg(args, '--grad-clip') ? parseFloat(getArg(args, '--grad-clip')!) : spec.gradClip,
                logEverySteps: getArg(args, '--log-every-steps') ? parseInt(getArg(args, '--log-every-steps')!) : spec.logEverySteps,
              } as any);
            } else if (sub === 'status') {
              if (hasFlag(args, '--raw')) await cmdGpuJobsStatus();
              else await cmdGpuFinetuneStatus();
            } else if (sub === 'logs') {
              await cmdGpuJobsLogs({ follow: hasFlag(args, '-f'), lines: 200 });
            } else if (sub === 'metrics') {
              await cmdGpuJobsMetrics({ json: hasFlag(args, '--json') });
            } else if (sub === 'cancel' || sub === 'cleanup') {
              await cmdGpuJobsCleanup(hasFlag(args, '--force'));
            } else if (sub === 'history') {
              await cmdGpuJobsHistory({ n: 20, totals: true });
            } else if (sub === 'estimate') {
              // Merge CLI overrides — pure-CLI users (no yaml) expect
              // --epochs / --max-samples / --batch-size / --grad-accum to
              // shape the estimate.
              const estType = getArg(args, '--type') || spec.type || 'audio';
              const estEpochs = getArg(args, '--epochs') ? parseInt(getArg(args, '--epochs')!) : spec.epochs;
              const estNumGpus = getArg(args, '--num-gpus') ? parseInt(getArg(args, '--num-gpus')!) : spec.numGpus;
              const estMaxSamples = getArg(args, '--max-samples') ? parseInt(getArg(args, '--max-samples')!) : spec.maxSamples;
              const estBatch = getArg(args, '--batch-size') ? parseInt(getArg(args, '--batch-size')!) : spec.batchSize;
              const estAccum = getArg(args, '--grad-accum') ? parseInt(getArg(args, '--grad-accum')!) : spec.gradAccum;
              const noUserInput = Object.keys(spec).length === 0
                && !estEpochs && !estMaxSamples && !estBatch && !estAccum;
              if (noUserInput) {
                console.log('[estimate] no spec provided — assuming defaults (4 epochs, 7449 samples, batch=2, accum=16, $0.30/h GPU)');
              }
              const est = estimateFinetuneCost({
                type: estType, scriptPath: spec.script,
                epochs: estEpochs, numGpus: estNumGpus,
                maxSamples: estMaxSamples,
                batchSize: estBatch, gradAccum: estAccum,
              } as any);
              console.log(`[estimate] encode: ${est.encodeMin.toFixed(1)}min, train: ${est.trainMin.toFixed(1)}min, setup: ${est.setupMin}min`);
              console.log(`[estimate] total: ${est.totalMin.toFixed(0)}min  ≈  $${est.totalUsd.toFixed(2)}`);
            } else if (sub === 'validate') {
              // Merge CLI overrides into validation payload so pure-CLI users
              // (no yaml) get the same coverage as yaml users.
              const validateSpec = {
                ...spec,
                type: getArg(args, '--type') || spec.type,
                dataset: getArg(args, '--dataset') || spec.dataset,
                hfBase: getArg(args, '--hf-base') || spec.hfBase,
                gpu: getArg(args, '--gpu') || spec.gpu,
                script: getArg(args, '--script') || spec.script,
              };
              const errs = validateFinetuneSpec(validateSpec);
              // Local dataset validation only if dataset path is local file (not hf://)
              const dsPath = validateSpec.dataset && !String(validateSpec.dataset).startsWith('hf://') ? String(validateSpec.dataset) : '';
              const dsErrs = dsPath ? validateDatasetLocal(dsPath, validateSpec.type || 'audio') : [];
              const all = [...errs, ...dsErrs];
              if (all.length > 0) { console.error('✗ spec errors:'); all.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }
              console.log('✓ schema valid');
              // Live preflight (HF/R2/script) unless --no-preflight — same checks as submit.
              if (!hasFlag(args, '--no-preflight')) {
                console.log('[preflight] checking dataset/model/token/storage…');
                const pf = await runFinetunePreflight({
                  ...validateSpec,
                  scriptPath: validateSpec.script,
                  model: getArg(args, '--model') || spec.model,
                  pushToHf: getArg(args, '--push-to-hf') || spec.pushToHf,
                  prepare: spec.prepare,
                  r2Bucket: getArg(args, '--r2-bucket') || spec.r2Bucket,
                  resumeFromR2: hasFlag(args, '--resume-from-r2') || spec.resumeFromR2 === true,
                } as Partial<FinetuneOpts>);
                if (!pf.ok) process.exit(1);
              }
            } else if (sub === 'lr-find') {
              await cmdGpuFinetuneLrFind({
                ...spec,
                type: getArg(args, '--type') || spec.type,
                dataset: getArg(args, '--dataset') || spec.dataset,
                hfBase: getArg(args, '--hf-base') || spec.hfBase,
                gpu: getArg(args, '--gpu') || spec.gpu,
              } as GpuFinetuneOpts);
            } else if (sub === 'sweep') {
              await cmdGpuFinetuneSweep({
                ...spec,
                type: getArg(args, '--type') || spec.type,
                dataset: getArg(args, '--dataset') || spec.dataset,
                hfBase: getArg(args, '--hf-base') || spec.hfBase,
                gpu: getArg(args, '--gpu') || spec.gpu,
                trials: getArg(args, '--trials') ? parseInt(getArg(args, '--trials')!) : 4,
              } as any);
            } else if (sub === 'deploy') {
              // args[2] is 'deploy' itself; positional ckpt path is args[3].
              const ckpt = args[3] && !args[3].startsWith('-') ? args[3] : undefined;
              const hfRepo = getArg(args, '--hf-repo');
              if (!ckpt && !hfRepo) {
                console.error('Usage: deploy [<ckpt-path>] [--hf-repo <owner/name>] [--hf-file <name>] [--push-to-hf <repo>] [--restart-server]');
                process.exit(1);
              }
              await cmdGpuFinetuneDeploy({
                ckpt,
                hfRepo,
                hfFile: getArg(args, '--hf-file'),
                pushTo: getArg(args, '--push-to-hf'),
                restartServer: hasFlag(args, '--restart-server'),
              });
            } else if (sub === 'list-runs') {
              const all = finetuneStateStore().loadAll();
              if (all.length === 0) { console.log('No runs recorded yet.'); }
              else {
                for (const r of all) {
                  console.log(`${r.id}  ${r.ts}  type=${r.spec?.type}  lr=${r.spec?.lr}`);
                }
              }
            } else if (sub === 'compare') {
              const ckpts = args.flatMap((a, i) => a === '--ckpt' && args[i + 1] ? [args[i + 1]] : []);
              const prompts = getArg(args, '--prompts');
              if (!prompts) { console.error('Need --prompts <path>'); process.exit(1); }
              await cmdGpuFinetuneCompare({
                ckpts, prompts,
                max: getArg(args, '--max') ? parseInt(getArg(args, '--max')!) : undefined,
                whisperModel: getArg(args, '--whisper-model'),
              });
            } else if (sub === 'plugins') {
              for (const [name, p] of Object.entries(BUNDLED_PLUGINS)) {
                console.log(`  ${name.padEnd(12)} ${p.description}`);
              }
            } else if (sub === 'presets') {
              const presets = listPresets();
              if (presets.length === 0) { console.log('No presets installed.'); break; }
              console.log('Available finetune presets (bundled, no user script needed):');
              for (const p of presets) {
                const m = p.manifest;
                console.log(`  ${m.name} v${m.version}`);
                console.log(`    ${m.description}`);
                console.log(`    type: ${m.type}, lr: ${m.defaultLR}, epochs: ${m.defaultEpochs}, gpu: ${m.defaultGpu || '(any)'}, maxSpend: $${m.defaultMaxSpend ?? '(unset)'}`);
                if (m.defaultModel) console.log(`    base: ${m.defaultModel}`);
                if (Array.isArray(m.knownTags) && m.knownTags.length) {
                  console.log(`    tags: ${m.knownTags.slice(0, 6).join(' ')}${m.knownTags.length > 6 ? ' …' : ''}`);
                }
                if (m.notes) console.log(`    notes: ${m.notes}`);
              }
            } else if (sub === 'watch-web') {
              await cmdGpuFinetuneWatchWeb();
            } else {
              console.error('Usage: ai-gateway gpu finetune <submit|status|logs|metrics|cancel|history|estimate|validate|lr-find|sweep|deploy|list-runs|plugins|watch-web>');
              process.exit(1);
            }
            break;
          }
          case 'train': {
            const script = getArg(args, '--script') || args[2];
            if (!script || script.startsWith('-')) {
              console.log(HELP.gpuTrain || 'Usage: ai-gateway gpu train --script <path> [--dataset hf://r] [--model hf://r] [--epochs N] [--lr X] ...');
              break;
            }
            await cmdGpuTrain({
              scriptPath: script,
              dataset: getArg(args, '--dataset'),
              datasetInclude: getArg(args, '--dataset-include'),
              noHfTransfer: hasFlag(args, '--no-hf-transfer'),
              model: getArg(args, '--model'),
              epochs: getArg(args, '--epochs') ? parseInt(getArg(args, '--epochs')!) : undefined,
              lr: getArg(args, '--lr') ? parseFloat(getArg(args, '--lr')!) : undefined,
              gpu: getArg(args, '--gpu'),
              maxCost: getArg(args, '--max-cost') ? parseFloat(getArg(args, '--max-cost')!) : undefined,
              maxSpend: getArg(args, '--max-spend') ? parseFloat(getArg(args, '--max-spend')!) : undefined,
              output: getArg(args, '--output') || getArg(args, '-o'),
              pushToHf: getArg(args, '--push-to-hf'),
              autoResume: hasFlag(args, '--auto-resume'),
              preferSpot: hasFlag(args, '--no-spot') ? false : (hasFlag(args, '--prefer-spot') || true),
              selectMode: (getArg(args, '--select-mode') as 'cheapest' | 'balanced' | 'fast') || 'balanced',
              reuse: hasFlag(args, '--reuse'),
              extraArgs: getArg(args, '--extra-args'),
              dryRun: hasFlag(args, '--dry-run'),
              image: getArg(args, '--image'),
            });
            break;
          }
          case 'jobs': {
            const jobSub = args[2];
            if (!jobSub || jobSub === 'help' || jobSub === '--help') {
              console.log(HELP.gpuJobs);
              break;
            }
            switch (jobSub) {
              case 'run': {
                const main = getArg(args, '--main');
                if (!main) {
                  console.error('Missing --main "<command>"');
                  process.exit(1);
                }
                await cmdGpuJobsRun({
                  repo: getArg(args, '--repo'),
                  path: getArg(args, '--path'),
                  main,
                  gpu: getArg(args, '--gpu'),
                  maxCost: getArg(args, '--max-cost') ? parseFloat(getArg(args, '--max-cost')!) : undefined,
                  output: getArg(args, '--output') || getArg(args, '-o'),
                  timeoutMin: getArg(args, '--timeout') ? parseInt(getArg(args, '--timeout')!) : undefined,
                  image: getArg(args, '--image'),
                  keepAlive: hasFlag(args, '--keep-alive'),
                  terminateOnError: hasFlag(args, '--terminate-on-error'),
                  env: getArg(args, '--env'),
                  pullEveryMin: getArg(args, '--pull-every') ? parseInt(getArg(args, '--pull-every')!) : undefined,
                  dryRun: hasFlag(args, '--dry-run'),
                  stallMin: getArg(args, '--stall-min') ? parseInt(getArg(args, '--stall-min')!) : undefined,
                  maxSpend: getArg(args, '--max-spend') ? parseFloat(getArg(args, '--max-spend')!) : undefined,
                  pullExclude: args.flatMap((a, i) => a === '--pull-exclude' && args[i + 1] ? [args[i + 1]] : []),
                  preferSpot: hasFlag(args, '--no-spot') ? false : hasFlag(args, '--prefer-spot'),
                  selectMode: (getArg(args, '--select-mode') as 'cheapest' | 'balanced' | 'fast') || 'balanced',
                  reuseInstance: hasFlag(args, '--reuse-instance'),
                  abortOnDivergence: hasFlag(args, '--abort-on-divergence'),
                  gpuFallback: hasFlag(args, '--no-gpu-fallback') ? false : hasFlag(args, '--gpu-fallback'),
                });
                break;
              }
              case 'status': await cmdGpuJobsStatus(); break;
              case 'ssh': {
                // Anything after 'gpu jobs ssh' is the remote command
                const sshCmd = args.slice(3).join(' ') || undefined;
                await cmdGpuJobsSsh(sshCmd);
                break;
              }
              case 'sync': {
                const localPos = args[3] && !args[3].startsWith('-') ? args[3] : undefined;
                await cmdGpuJobsSync(localPos);
                break;
              }
              case 'pull': {
                const localPos = args[3] && !args[3].startsWith('-') ? args[3] : undefined;
                await cmdGpuJobsPull(localPos);
                break;
              }
              case 'exec': {
                const cmd = getArg(args, '--main') || args.slice(3).filter(a => !a.startsWith('-')).join(' ');
                if (!cmd) { console.error('Usage: ai-gateway gpu jobs exec --main "<cmd>" OR ai-gateway gpu jobs exec "<cmd>"'); process.exit(1); }
                await cmdGpuJobsExec(cmd);
                break;
              }
              case 'cleanup':
                await cmdGpuJobsCleanup(hasFlag(args, '--force'));
                break;
              case 'retry':
                await cmdGpuJobsRetry({
                  skipSync: hasFlag(args, '--no-sync'),
                  mainOverride: getArg(args, '--main'),
                });
                break;
              case 'clean':
                await cmdGpuJobsClean({
                  orphans: hasFlag(args, '--orphans'),
                  cache: hasFlag(args, '--cache'),
                  keepWorkspace: hasFlag(args, '--keep-workspace'),
                });
                break;
              case 'relaunch':
                await cmdGpuJobsRelaunch(getArg(args, '--main'));
                break;
              case 'logs':
                await cmdGpuJobsLogs({
                  follow: hasFlag(args, '-f') || hasFlag(args, '--follow'),
                  lines: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
                });
                break;
              case 'cost':
                await cmdGpuJobsCost();
                break;
              case 'history':
                await cmdGpuJobsHistory({
                  n: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
                  json: hasFlag(args, '--json'),
                  totals: hasFlag(args, '--totals'),
                });
                break;
              case 'watch':
                await cmdGpuJobsWatch({
                  interval: getArg(args, '--interval') ? parseInt(getArg(args, '--interval')!) : undefined,
                  lines: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : undefined,
                });
                break;
              case 'metrics':
                await cmdGpuJobsMetrics({
                  json: hasFlag(args, '--json'),
                  windowSec: getArg(args, '--window') ? parseInt(getArg(args, '--window')!) : undefined,
                });
                break;
              default:
                console.error('Usage: ai-gateway gpu jobs <run|status|ssh|sync|pull|exec|retry|clean|relaunch|logs|cost|history|watch|metrics|cleanup>');
                process.exit(1);
            }
            break;
          }
          default:
            console.error('Usage: ai-gateway gpu <status|list|offers|deploy|stop|resume|terminate|logs|ssh|patch|pull|commit|dev|hyperstack|jobs>');
            process.exit(1);
        }
        break;
      }
      case 'metrics':
        await cmdMetrics(hasFlag(args, '--json') ? 'json' : 'prometheus');
        break;
      case 'translate': {
        let text = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        if (!text) text = (await readStdin()) || '';
        if (!text) { console.error('Usage: ai-gateway translate "text" or echo "text" | ai-gateway translate'); process.exit(1); }
        await cmdTranslate(text, {
          from: getArg(args, '--from'),
          to: getArg(args, '--to'),
          model: getArg(args, '-m') || getArg(args, '--model'),
        });
        break;
      }
      case 'voices':
        await cmdVoices();
        break;
      case 'config':
        await cmdConfig();
        break;
      case 'whoami':
        await cmdWhoami();
        break;
      case 'ping':
        await cmdPing(getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : getArg(args, '--count') ? parseInt(getArg(args, '--count')!) : 5);
        break;
      case 'benchmark':
        await cmdBenchmark({
          count: getArg(args, '-n') ? parseInt(getArg(args, '-n')!) : getArg(args, '--count') ? parseInt(getArg(args, '--count')!) : undefined,
        });
        break;
      case 'lightning':
        await cmdLightning(args.slice(1));
        break;
      default:
        console.error(`Unknown command: ${cmd}. Run 'ai-gateway help' for usage.`);
        process.exit(1);
    }
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`Connection refused — is the gateway running at ${getConfig().url}?`);
    } else {
      console.error(`Error: ${err.message || err}`);
    }
    process.exit(1);
  }
}

// ── Lightning AI studio commands ────────────────────────────────────────────

const LIGHTNING_API_BASE = 'https://lightning.ai/v1';
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

interface LightningEnvConfig {
  apiKey: string;
  projectId: string;
  cloudspaceId: string;
  sshUser: string;
  sshHost: string;
  sshKeyPath: string;
}

function loadLightningConfigFromEnv(): LightningEnvConfig | null {
  const apiKey = process.env.LIGHTNING_API_KEY;
  const projectId = process.env.LIGHTNING_PROJECT_ID;
  const cloudspaceId = process.env.LIGHTNING_CLOUDSPACE_ID;
  const sshUser = process.env.LIGHTNING_SSH_USER;
  if (!apiKey || !projectId || !cloudspaceId || !sshUser) return null;
  return {
    apiKey,
    projectId,
    cloudspaceId,
    sshUser,
    sshHost: process.env.LIGHTNING_SSH_HOST ?? 'ssh.lightning.ai',
    sshKeyPath: process.env.LIGHTNING_SSH_KEY ?? `${process.env.HOME}/.ssh/id_ed25519`,
  };
}

async function lightningApiGet(cfg: LightningEnvConfig): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${LIGHTNING_API_BASE}/projects/${cfg.projectId}/cloudspaces/${cfg.cloudspaceId}`,
    { headers: { 'Authorization': `Bearer ${cfg.apiKey}` } }
  );
  if (!res.ok) throw new Error(`Lightning API ${res.status}: ${await res.text()}`);
  const data = await res.json() as Record<string, unknown>;
  const inUse = (data.codeStatus as Record<string, unknown>)?.inUse as Record<string, unknown> | null;
  return {
    phase: inUse?.phase ?? 'STOPPED',
    sshUser: inUse?.sshUsername,
    sshHost: inUse?.sshHost,
    instanceId: inUse?.cloudSpaceInstanceId,
  };
}

async function lightningApiStart(cfg: LightningEnvConfig): Promise<void> {
  const res = await fetch(
    `${LIGHTNING_API_BASE}/projects/${cfg.projectId}/cloudspaces/${cfg.cloudspaceId}/start`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' }, body: '{}' }
  );
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok && body.code !== 2) throw new Error(`Start failed: ${body.message ?? res.status}`);
}

async function lightningApiStop(cfg: LightningEnvConfig): Promise<void> {
  const res = await fetch(
    `${LIGHTNING_API_BASE}/projects/${cfg.projectId}/cloudspaces/${cfg.cloudspaceId}/stop`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' }, body: '{}' }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Stop failed: ${body.message ?? res.status}`);
  }
}

async function lightningWaitRunning(cfg: LightningEnvConfig, timeoutMs = 5 * 60 * 1000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await lightningApiGet(cfg);
    if (s.phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING') return s;
    if (s.phase === 'STOPPED') throw new Error('Studio stopped unexpectedly during boot');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Studio did not reach RUNNING within ${timeoutMs / 1000}s`);
}

// Notify gateway server (optional — only when server is running)
async function lightningNotifyServer(gwUrl: string, path: string, gwKey?: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (gwKey) headers['Authorization'] = `Bearer ${gwKey}`;
  await fetch(`${gwUrl}${path}`, { method: 'POST', headers, signal: AbortSignal.timeout(2000) }).catch(() => {});
}

async function cmdLightning(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === 'help' || sub === '--help') {
    console.log(`
Lightning AI studio commands:

  ai-gateway lightning status     Show studio status
  ai-gateway lightning start      Start studio and wait until running
  ai-gateway lightning stop       Stop studio immediately
  ai-gateway lightning ssh        Lazy-start + SSH in (auto-stop after 15 min idle)

Config (add to .env):
  LIGHTNING_API_KEY       API key (LIGHTNING_API_KEY inside studio env)
  LIGHTNING_PROJECT_ID    Project ID (LIGHTNING_CLOUD_PROJECT_ID inside studio)
  LIGHTNING_CLOUDSPACE_ID Cloudspace ID (LIGHTNING_CLOUD_SPACE_ID inside studio)
  LIGHTNING_SSH_USER      SSH username (s_<cloudspaceId>)
  LIGHTNING_SSH_KEY       SSH private key path (default: ~/.ssh/id_ed25519)
`);
    return;
  }

  const cfg = loadLightningConfigFromEnv();
  if (!cfg) {
    console.error('Lightning AI not configured. Set LIGHTNING_API_KEY, LIGHTNING_PROJECT_ID, LIGHTNING_CLOUDSPACE_ID, LIGHTNING_SSH_USER in .env');
    process.exit(1);
  }

  switch (sub) {
    case 'status': {
      const s = await lightningApiGet(cfg);
      const running = s.phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING';
      console.log(`Studio: ${running ? c.green + 'RUNNING' : c.yellow + s.phase}${c.reset}`);
      if (s.sshUser) console.log(`SSH:    ${s.sshUser}@${s.sshHost}`);
      break;
    }

    case 'start': {
      process.stdout.write('Starting Lightning AI studio...');
      await lightningApiStart(cfg);
      const s = await lightningWaitRunning(cfg);
      console.log(` ${c.green}RUNNING${c.reset}`);
      if (s.sshUser) console.log(`SSH: ${s.sshUser}@${s.sshHost}`);
      break;
    }

    case 'stop': {
      const s = await lightningApiGet(cfg);
      if (s.phase === 'STOPPED' || !s.instanceId) { console.log('Studio already stopped.'); break; }
      await lightningApiStop(cfg);
      console.log('Studio stopped.');
      break;
    }

    case 'ssh': {
      // 1. Check + lazy-start
      process.stdout.write('Checking studio...');
      let status = await lightningApiGet(cfg);

      if (status.phase !== 'CLOUD_SPACE_INSTANCE_STATE_RUNNING') {
        process.stdout.write(` ${c.yellow}sleeping${c.reset} — waking up`);
        await lightningApiStart(cfg);
        let dots = 0;
        const ticker = setInterval(() => { process.stdout.write('.'); dots++; }, 3000);
        try {
          status = await lightningWaitRunning(cfg);
        } finally {
          clearInterval(ticker);
        }
      }
      console.log(` ${c.green}RUNNING${c.reset}`);

      const sshUser = (status.sshUser as string) || cfg.sshUser;
      const sshHost = (status.sshHost as string) || cfg.sshHost;

      // 2. Notify gateway server (best-effort — idle tracker)
      const gwUrl = getConfig().url;
      const gwKey = getConfig().key;
      await lightningNotifyServer(gwUrl, '/v1/lightning/session/start', gwKey);

      // 3. On exit: notify server + optionally schedule idle stop
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleIdleStop = () => {
        idleTimer = setTimeout(async () => {
          const cur = await lightningApiGet(cfg).catch(() => ({ phase: 'STOPPED', instanceId: null }));
          if (cur.phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING') {
            await lightningApiStop(cfg).catch(() => {});
            console.log('\n[lightning] idle timeout — studio stopped');
          }
        }, IDLE_TIMEOUT_MS);
      };

      const notifyEnd = () => {
        lightningNotifyServer(gwUrl, '/v1/lightning/session/end', gwKey).catch(() => {});
        // If gateway server not running, handle idle stop locally
        scheduleIdleStop();
      };

      process.on('SIGINT', () => { notifyEnd(); process.exit(0); });
      process.on('SIGTERM', () => { notifyEnd(); process.exit(0); });

      // 4. Connect SSH
      console.log(`Connecting to ${sshUser}@${sshHost}...\n`);
      const extraArgs = args.slice(1);
      const sshArgs = [
        '-i', cfg.sshKeyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=30',
        ...extraArgs,
        `${sshUser}@${sshHost}`,
      ];
      const ssh = require('child_process').spawn('ssh', sshArgs, { stdio: 'inherit' });
      ssh.on('close', (code: number) => {
        notifyEnd();
        // Keep process alive for idle timer if running standalone
        if (idleTimer) {
          console.log(`\nSSH session ended. Studio auto-stops in ${IDLE_TIMEOUT_MS / 60000} min if unused.`);
          // Let the idle timer fire then exit
          idleTimer.unref(); // don't block node exit if something else exits first
        }
        process.exit(code ?? 0);
      });
      break;
    }

    default:
      console.error(`Unknown lightning subcommand: ${sub}`);
      console.log('Usage: ai-gateway lightning <status|start|stop|ssh>');
      process.exit(1);
  }
}

main();
