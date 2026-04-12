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
import { resolve } from 'path';

// ── Config ────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'http://localhost:4000';

function getConfig(): { url: string; key: string } {
  const url = process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || DEFAULT_URL;
  const key = process.env.AI_GATEWAY_KEY || process.env.GATEWAY_API_KEY || '';
  return { url, key };
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

async function cmdHealth() {
  const { url, key } = getConfig();
  const data = await fetchJSON(`${url}/health`);
  console.log('Status:', data.status);
  if (data.connections) {
    console.log(`Connections: active=${data.connections.active}, peak=${data.connections.peak}`);
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
  const res = await fetch(`${url}/v1/audio/speech`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Error ${res.status}: ${err.slice(0, 200)}`);
    process.exit(1);
  }
  const audioBuffer = Buffer.from(await res.arrayBuffer());
  const outPath = opts.output || 'output.wav';
  writeFileSync(outPath, audioBuffer);
  console.log(`Audio saved to ${outPath} (${audioBuffer.length} bytes)`);
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
  if (data.podId) console.log(`  podId:     ${data.podId}`);
  if (data.endpoint) console.log(`  endpoint:  ${data.endpoint}`);
  if (data.gpuType) console.log(`  gpuType:   ${data.gpuType}`);
  if (data.provider) console.log(`  provider:  ${data.provider}`);
  if (data.costPerHr) console.log(`  cost/hr:   $${data.costPerHr.toFixed(2)}`);
  if (data.gpuHealthy !== undefined) console.log(`  healthy:   ${data.gpuHealthy}`);
}

async function cmdGpuDeploy(opts: { image?: string; gpuTypes?: string }) {
  const { url, key } = getConfig();
  const body: Record<string, unknown> = {};
  if (opts.image) body.dockerImage = opts.image;
  if (opts.gpuTypes) body.gpuTypes = opts.gpuTypes.split(',');
  const data = await fetchJSON(`${url}/v1/gpu/deploy`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  console.log('Deploy started:');
  console.log(JSON.stringify(data, null, 2));
}

async function cmdGpuStop() {
  const { url, key } = getConfig();
  await fetchJSON(`${url}/v1/gpu/stop`, { method: 'POST', headers: headers(key) });
  console.log('GPU stopped.');
}

async function cmdGpuLogs() {
  const { url, key } = getConfig();
  const data = await fetchJSON(`${url}/v1/gpu/logs`, { headers: headers(key) });
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
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
  const res = await fetch(`${url}/v1/images/generate`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Error ${res.status}: ${err.slice(0, 200)}`);
    process.exit(1);
  }
  const imgBuffer = Buffer.from(await res.arrayBuffer());
  const outPath = opts.output || 'output.jpg';
  writeFileSync(outPath, imgBuffer);
  console.log(`Image saved to ${outPath} (${imgBuffer.length} bytes)`);
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

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
ai-gateway CLI — Parle AI Gateway

Usage:
  ai-gateway <command> [options]

Commands:
  health                     Check gateway health
  models                     List available models
  chat <message>             Chat completion (streaming by default)
    -m, --model <model>        Model name (default: llama-3.1-8b-instant)
    --no-stream                Disable streaming
    --max-tokens <n>           Max tokens (default: 1024)
  transcribe <file>          Transcribe audio file (STT)
    -m, --model <model>        Model (default: whisper-large-v3-turbo)
    -l, --language <lang>      Language hint (e.g. fr, en, es)
  tts <text>                 Text-to-speech
    -v, --voice <voice>        Voice name (default: autumn)
    -o, --output <file>        Output file (default: output.wav)
  image <prompt>             Generate image
    -o, --output <file>        Output file (default: output.jpg)
  gpu status                 Show GPU deployment status
  gpu deploy                 Deploy GPU instance
    --image <docker-image>     Docker image to deploy
    --gpu-types <types>        Comma-separated GPU types
  gpu stop                   Stop GPU instance
  gpu logs                   Fetch GPU container logs
  metrics                    Show Prometheus metrics
  metrics --json             Show JSON metrics

Environment:
  AI_GATEWAY_URL             Gateway URL (default: http://localhost:4000)
  AI_GATEWAY_KEY             API key for authentication
`);
    return;
  }

  try {
    switch (cmd) {
      case 'health':
        await cmdHealth();
        break;
      case 'models':
        await cmdModels();
        break;
      case 'chat': {
        const msg = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        if (!msg) { console.error('Usage: ai-gateway chat "your message"'); process.exit(1); }
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
        const text = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        if (!text) { console.error('Usage: ai-gateway tts "your text"'); process.exit(1); }
        await cmdTTS(text, {
          voice: getArg(args, '-v') || getArg(args, '--voice'),
          output: getArg(args, '-o') || getArg(args, '--output'),
        });
        break;
      }
      case 'image': {
        const prompt = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
        if (!prompt) { console.error('Usage: ai-gateway image "your prompt"'); process.exit(1); }
        await cmdImage(prompt, {
          output: getArg(args, '-o') || getArg(args, '--output'),
        });
        break;
      }
      case 'gpu':
        switch (args[1]) {
          case 'status': await cmdGpuStatus(); break;
          case 'deploy': await cmdGpuDeploy({
            image: getArg(args, '--image'),
            gpuTypes: getArg(args, '--gpu-types'),
          }); break;
          case 'stop': await cmdGpuStop(); break;
          case 'logs': await cmdGpuLogs(); break;
          default:
            console.error('Usage: ai-gateway gpu <status|deploy|stop|logs>');
            process.exit(1);
        }
        break;
      case 'metrics':
        await cmdMetrics(hasFlag(args, '--json') ? 'json' : 'prometheus');
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
