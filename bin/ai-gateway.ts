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

  const HELP: Record<string, string> = {
    main: `
ai-gateway CLI — Parle AI Gateway

Usage:
  ai-gateway <command> [options]
  ai-gateway <command> help        Show help for a specific command
  ai-gateway help                  Show this help

Commands:
  health          Check gateway health and connection count
  models          List all available models
  chat            Chat with an LLM (streaming by default)
  transcribe      Transcribe an audio file (speech-to-text)
  tts             Generate speech from text (text-to-speech)
  image           Generate an image from a text prompt
  gpu             Manage GPU deployments (status, deploy, stop, logs)
  metrics         Show gateway metrics (Prometheus or JSON)

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
    gpu: `
ai-gateway gpu — Manage GPU deployments

Usage:
  ai-gateway gpu <subcommand> [options]

Subcommands:
  status                       Show current GPU deployment status
                               (podId, endpoint, gpuType, provider, cost/hr, health)
  deploy                       Deploy a new GPU instance
    --image <docker-image>       Docker image (e.g. marcosremar/babelcast-subtitle:latest)
    --gpu-types <types>          Comma-separated GPU types
                                 (e.g. "NVIDIA GeForce RTX 4090,NVIDIA RTX A6000")
  stop                         Stop (pause) the current GPU instance
  logs                         Fetch container stdout/stderr logs

Notes:
  - GPU commands require the full server (server/ws-server.ts), not the
    lightweight proxy (serve.ts). If you see "proxy-only mode", the
    gateway was started with serve.ts which doesn't include GPU management.
  - Deploy is non-blocking — use 'gpu status' to poll until ready

Examples:
  ai-gateway gpu status
  ai-gateway gpu deploy --image marcosremar/babelcast-subtitle:latest
  ai-gateway gpu deploy --gpu-types "NVIDIA GeForce RTX 4090"
  ai-gateway gpu stop
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
