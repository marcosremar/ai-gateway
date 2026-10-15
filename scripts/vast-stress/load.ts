import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    deployment: { type: 'string', default: 'llm-a' },
    levels: { type: 'string', default: '1,4,16,64,128' },
    seconds: { type: 'string', default: '120' },
    'max-tokens': { type: 'string', default: '64' },
    timeout: { type: 'string', default: '90' },
    interval: { type: 'string', default: '0' },
    out: { type: 'string' },
    url: { type: 'string' },
  },
});

const gateway = process.env.GW ?? 'http://localhost:4200';
const key = process.env.KEY;
if (!key) throw new Error('KEY (gateway admin key) is required');
const target = opt.url ?? `${gateway}/v1/deployments/${opt.deployment}/invoke/v1/chat/completions`;
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (!opt.url) headers.authorization = `Bearer ${key}`;
if (process.env.REPLICA_TOKEN) headers['x-aigw-token'] = process.env.REPLICA_TOKEN;
const gatewayPid = process.env.GATEWAY_PID ? Number(process.env.GATEWAY_PID) : 0;
const topics = ['the sea', 'a bakery', 'trains', 'rain', 'a market', 'coffee', 'a bicycle', 'the moon'];

type Result = { ok: boolean; status: number; ttftMs: number | null; totalMs: number; tokens: number; error?: string; replica?: string };

async function one(): Promise<Result> {
  const started = performance.now();
  let ttft: number | null = null;
  let tokens = 0;
  const topic = topics[Math.floor(Math.random() * topics.length)];
  try {
    const res = await fetch(target, {
      method: 'POST', headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: `Write two short sentences about ${topic}.` }],
        max_tokens: Number(opt['max-tokens']), stream: true, temperature: 0.7,
      }),
      signal: AbortSignal.timeout(Number(opt.timeout) * 1000),
    });
    const replica = res.headers.get('x-aigw-replica') ?? undefined;
    if (!res.ok || !res.body) {
      const text = (await res.text()).slice(0, 200);
      return { ok: false, status: res.status, ttftMs: null, totalMs: performance.now() - started, tokens, error: `HTTP ${res.status} ${res.headers.get('retry-after') ? `retry-after=${res.headers.get('retry-after')} ` : ''}${text}`, replica };
    }
    const decoder = new TextDecoder();
    let done = false;
    for await (const chunk of res.body) {
      for (const line of decoder.decode(chunk, { stream: true }).split('\n')) {
        if (!line.startsWith('data:')) continue;
        if (line.includes('[DONE]')) { done = true; continue; }
        if (line.includes('"content"')) {
          tokens++;
          ttft ??= performance.now() - started;
        }
      }
    }
    return { ok: done, status: res.status, ttftMs: ttft, totalMs: performance.now() - started, tokens, replica, ...(done ? {} : { error: 'stream ended without [DONE]' }) };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { ok: false, status: 0, ttftMs: ttft, totalMs: performance.now() - started, tokens, error: name === 'TimeoutError' ? 'client timeout' : `${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

function rssMb(): number | null {
  if (!gatewayPid) return null;
  const out = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(gatewayPid)]).stdout.toString().trim();
  return out ? Math.round(Number(out) / 1024) : null;
}

async function level(concurrency: number, seconds: number) {
  const results: Result[] = [];
  const rss: number[] = [];
  const deadline = Date.now() + seconds * 1000;
  const sampler = setInterval(() => { const r = rssMb(); if (r) rss.push(r); }, 5000);
  const interval = Number(opt.interval) * 1000;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      const r = await one();
      results.push(r);
      if (opt.out) appendFileSync(opt.out, JSON.stringify({ at: new Date().toISOString(), concurrency, ...r }) + '\n');
      if (interval) await Bun.sleep(interval * (0.5 + Math.random()));
    }
  }));
  clearInterval(sampler);
  const ok = results.filter(r => r.ok);
  const errors: Record<string, number> = {};
  for (const r of results.filter(r => !r.ok)) errors[r.error ?? 'unknown'] = (errors[r.error ?? 'unknown'] ?? 0) + 1;
  const replicas: Record<string, number> = {};
  for (const r of ok) if (r.replica) replicas[r.replica] = (replicas[r.replica] ?? 0) + 1;
  const ttft = ok.map(r => r.ttftMs!).filter(x => x !== null);
  const total = ok.map(r => r.totalMs);
  return {
    at: new Date().toISOString(), concurrency, seconds, requests: results.length, ok: ok.length,
    successRate: results.length ? Math.round((ok.length / results.length) * 1000) / 10 : null,
    ttftMs: { p50: pct(ttft, 50), p95: pct(ttft, 95), max: pct(ttft, 100) },
    totalMs: { p50: pct(total, 50), p95: pct(total, 95), max: pct(total, 100) },
    tokensPerSecond: Math.round(ok.reduce((n, r) => n + r.tokens, 0) / seconds),
    clientTimeouts: errors['client timeout'] ?? 0, errors, replicas,
    gatewayRssMb: rss.length ? { min: Math.min(...rss), max: Math.max(...rss) } : null,
  };
}

for (const c of opt.levels!.split(',').map(Number)) console.log(JSON.stringify(await level(c, Number(opt.seconds))));
