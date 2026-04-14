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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { spawn, type ChildProcess } from 'child_process';

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

function getConfig(): { url: string; key: string } {
  const url = process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || DEFAULT_URL;
  const key = process.env.AI_GATEWAY_KEY || process.env.GATEWAY_API_KEY || '';
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

  // Find serve.ts relative to this CLI script
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const servePath = resolve(repoRoot, 'serve.ts');
  if (!existsSync(servePath)) {
    console.error(`Cannot auto-start: serve.ts not found at ${servePath}`);
    console.error('Start the server manually: bun run serve.ts');
    process.exit(1);
  }

  const port = new URL(url).port || '4000';
  console.log(`Starting local gateway on port ${port}...`);

  const child: ChildProcess = spawn('bun', ['run', servePath], {
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
  process.exit(1);
}

async function cmdServerStop() {
  const pidPath = resolve(process.env.HOME || '/tmp', '.babelcast', 'gateway-cli.pid');
  if (!existsSync(pidPath)) {
    console.log('No auto-started server found (no PID file).');
    return;
  }
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
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

async function cmdChat(message: string, opts: { model?: string; stream?: boolean; maxTokens?: number }) {
  const { url, key } = getConfig();
  const model = opts.model || 'llama-3.1-8b-instant';
  const body = {
    model,
    messages: [{ role: 'user', content: message }],
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

async function cmdTranscribe(filePath: string, opts: { model?: string; language?: string }) {
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
  if (data.deployId) console.log(`  deployId:  ${data.deployId}`);
  if (data.podId) console.log(`  podId:     ${data.podId}`);
  if (data.endpoint) console.log(`  endpoint:  ${data.endpoint}`);
  if (data.gpuType) console.log(`  gpuType:   ${data.gpuType}`);
  if (data.provider) console.log(`  provider:  ${data.provider}`);
  if (data.costPerHr) console.log(`  cost/hr:   $${data.costPerHr.toFixed(2)}`);
  if (data.gpuHealthy !== undefined) console.log(`  healthy:   ${data.gpuHealthy}`);
}

async function cmdGpuDeploy(opts: { image?: string; gpuTypes?: string; onstart?: string; storageGb?: number; env?: string; numGpus?: number }) {
  const { url, key } = getConfig();
  const body: Record<string, unknown> = {};
  if (opts.image) body.dockerImage = opts.image;
  if (opts.gpuTypes) body.gpuTypes = opts.gpuTypes.split(',');
  if (opts.onstart) body.onstart = opts.onstart;
  if (opts.storageGb) body.storageGb = opts.storageGb;
  if (opts.numGpus) body.gpuCount = opts.numGpus;
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

async function cmdGpuList() {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/v1/gpu/list`, { headers: headers(key) });
  if (res.status === 404) {
    console.log('GPU endpoints not available (proxy-only mode).');
    return;
  }
  const data = await res.json();
  const instances = Array.isArray(data) ? data : (data.instances || []);
  if (instances.length === 0) {
    console.log('No active GPU instances.');
    return;
  }
  console.log(`${instances.length} active instance(s):\n`);
  for (const inst of instances) {
    console.log(`  ${inst.instanceId || inst.podId || '?'}`);
    if (inst.deployId) console.log(`    deployId:  ${inst.deployId}`);
    if (inst.provider) console.log(`    provider:  ${inst.provider}`);
    if (inst.gpuType || inst.gpuName) console.log(`    gpu:       ${inst.gpuType || inst.gpuName}`);
    if (inst.status) console.log(`    status:    ${inst.status}`);
    if (inst.endpoint) console.log(`    endpoint:  ${inst.endpoint}`);
    if (inst.costPerHr) console.log(`    cost/hr:   $${Number(inst.costPerHr).toFixed(2)}`);
    if (inst.dockerImage) console.log(`    image:     ${inst.dockerImage}`);
    console.log('');
  }
}

async function cmdGpuTerminate(instanceId: string, opts: { provider?: string; deployId?: string }) {
  const { url, key } = getConfig();
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
  platforms?: string; wait?: boolean;
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

  if (!opts.wait) {
    console.log(`\nTrack progress:`);
    console.log(`  ai-gateway docker status ${buildId}`);
    return;
  }

  console.log(`\nWaiting for build to complete...`);
  const deadline = Date.now() + 50 * 60_000;
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
      console.log(`  Run:   ai-gateway gpu deploy --image ${build.image}`);
      return;
    }
    if (build.status === 'failed') {
      console.error(`\n${c.red}✗${c.reset} Build failed: ${build.error}`);
      if (build.workflowRunUrl) console.error(`  Logs: ${build.workflowRunUrl}`);
      process.exit(1);
    }
  }
  console.error(`\n${c.yellow}!${c.reset} Timed out — check: ai-gateway docker status ${buildId}`);
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

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
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
  tts             Generate speech from text (text-to-speech)
  voices          List available TTS voices
  image           Generate an image from a text prompt
  docker          Build Docker images via GitHub Actions and GHCR (auth, build, list)
  gpu             Manage GPU deployments (status, deploy, stop, logs)
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

Examples:
  ai-gateway health
  ai-gateway chat "What is 2+2?"
  ai-gateway chat "Translate to French: hello" -m llama-3.3-70b-versatile
  ai-gateway transcribe meeting.wav -l en
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
                               Default: llama-3.1-8b-instant
                               Available: llama-3.1-8b-instant, llama-3.3-70b-versatile,
                               meta-llama/llama-4-scout-17b-16e-instruct
  --no-stream                  Return the full response at once instead of streaming
  --max-tokens <n>             Maximum tokens to generate (default: 1024, max: 128000)

Notes:
  - Streaming is enabled by default — tokens appear as they're generated
  - Token usage is shown at the end when streaming completes
  - Only models configured on the gateway are available (no proprietary models)
  - Temperature defaults to the model's default (typically ~0.7)

Examples:
  ai-gateway chat "What is 2+2?"
  ai-gateway chat "Explain quantum computing" -m llama-3.3-70b-versatile
  ai-gateway chat "Say OK" --no-stream --max-tokens 5
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

Notes:
  - Identical audio files are cached for 5 minutes (X-Cache: HIT on repeat)
  - The gateway routes to Groq's hosted Whisper by default

Examples:
  ai-gateway transcribe recording.wav
  ai-gateway transcribe meeting.mp3 -l en
  ai-gateway transcribe audio.flac -m whisper-large-v3 -l fr
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
  stop                         Stop (pause) the current GPU instance
  resume [instanceId]          Resume a stopped instance
    --provider <name>            Provider hint (runpod, vast, tensordock)
  terminate <instanceId>       Permanently destroy a specific instance
    --provider <name>            Provider hint (runpod, vast, tensordock)
  logs                         Fetch container stdout/stderr logs

Notes:
  - GPU commands require the full server (server/ws-server.ts), not the
    lightweight proxy (serve.ts). If you see "proxy-only mode", the
    gateway was started with serve.ts which doesn't include GPU management.
  - Deploy is non-blocking — use 'gpu status' to poll until ready
  - Terminate is permanent and cannot be undone

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
        let msg = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        // Support piped input: echo "hello" | ai-gateway chat
        if (!msg) msg = (await readStdin()) || '';
        if (!msg) { console.error('Usage: ai-gateway chat "your message" or echo "msg" | ai-gateway chat'); process.exit(1); }
        await cmdChat(msg, {
          model: getArg(args, '-m') || getArg(args, '--model'),
          stream: !hasFlag(args, '--no-stream'),
          maxTokens: getArg(args, '--max-tokens') ? parseInt(getArg(args, '--max-tokens')!) : undefined,
        });
        break;
      }
      case 'transcribe': {
        const file = args[1];
        if (!file || file.startsWith('-')) { console.error('Usage: ai-gateway transcribe <file>'); process.exit(1); }
        await cmdTranscribe(file, {
          model: getArg(args, '-m') || getArg(args, '--model'),
          language: getArg(args, '-l') || getArg(args, '--language'),
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
            await cmdDockerBuild(dir, {
              name: getArg(args, '--name'),
              tag: getArg(args, '--tag'),
              repo: getArg(args, '--repo'),
              platforms: getArg(args, '--platforms'),
              public: hasFlag(args, '--public'),
              wait: hasFlag(args, '--wait'),
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
          case 'list': await cmdGpuList(); break;
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
            await cmdGpuTerminate(id, { provider: getArg(args, '--provider'), deployId: getArg(args, '--deploy-id') });
            break;
          }
          case 'logs': await cmdGpuLogs(); break;
          default:
            console.error('Usage: ai-gateway gpu <status|list|offers|deploy|stop|resume|terminate|logs>');
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

main();
