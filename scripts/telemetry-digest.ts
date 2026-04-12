#!/usr/bin/env bun
/**
 * Telemetry digest — analyzes local ~/.babelcast/ telemetry and writes a
 * markdown report to docs/insights/YYYY-MM-DD-digest.md.
 *
 * Run: `bun run insights:digest`
 *
 * This is the scripted version of the manual analysis in
 * docs/insights/2026-04-12-first-pass.md. It should be re-run every 2
 * weeks so trends become visible over time. Each run writes a new dated
 * file; diffing two reports tells you what got better and what regressed.
 *
 * Data sources:
 *   ~/.babelcast/logs/gpu.jsonl        lifecycle events (always-on)
 *   ~/.babelcast/gpu-readiness-history.json  per-image latency history
 *   ~/.babelcast/cost_ledger.json      daily GPU spend
 *   ~/.babelcast/runpod-quota.json     RunPod account state
 *   ~/.babelcast/cooldowns.json        provider cooldown state
 *
 * All sources are optional. A missing file contributes zero findings to
 * the report rather than failing the whole run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Types ────────────────────────────────────────────────────────────────

interface LifecycleEvent {
  ts: string;
  event: string;
  provider: string;
  success?: boolean;
  error?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

interface ReadinessRun {
  ts: number;
  stage: 'stt' | 'llm' | 'tts';
  samples: number[];
  bestLatencyMs?: number;
  targetMs?: number;
  passed?: boolean;
}

interface CostLedger {
  entries?: Array<{ date: string; cost_usd: number }>;
}

// ── Source loaders ───────────────────────────────────────────────────────

const BABELCAST = join(homedir(), '.babelcast');

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const events: T[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return events;
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch { return fallback; }
}

// ── Analysis functions ───────────────────────────────────────────────────

/** Provider success rate by event type across lifecycle events. */
function analyzeProviderFailures(events: LifecycleEvent[]) {
  const byProvider: Record<string, { ok: number; fail: number; errors: Record<string, number> }> = {};

  for (const e of events) {
    if (e.event !== 'deploy_failed' && e.event !== 'deploy_ready') continue;
    const p = e.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { ok: 0, fail: 0, errors: {} };
    if (e.event === 'deploy_ready') byProvider[p].ok++;
    if (e.event === 'deploy_failed') {
      byProvider[p].fail++;
      const err = (e.error || '').split('\n')[0].slice(0, 120) || 'unknown';
      byProvider[p].errors[err] = (byProvider[p].errors[err] || 0) + 1;
    }
  }
  return byProvider;
}

/** Per-image STT/LLM/TTS latency distribution. */
function analyzeReadinessHistory(history: Record<string, { runs?: ReadinessRun[] }>) {
  const rows: Array<{
    imageGpu: string;
    stage: string;
    p50: number;
    p95: number;
    samples: number;
  }> = [];

  for (const [key, obj] of Object.entries(history)) {
    if (!obj?.runs) continue;
    const stageSamples: Record<string, number[]> = { stt: [], llm: [], tts: [] };
    for (const run of obj.runs) {
      if (run.samples && run.stage in stageSamples) {
        stageSamples[run.stage].push(...run.samples);
      }
    }
    for (const [stage, samples] of Object.entries(stageSamples)) {
      if (samples.length === 0) continue;
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length / 2)];
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];
      rows.push({ imageGpu: key, stage, p50, p95, samples: samples.length });
    }
  }
  return rows;
}

/** Spend analysis — total, average, top days, recent trend. */
function analyzeSpend(ledger: CostLedger) {
  const entries = ledger.entries ?? [];
  if (entries.length === 0) return null;
  const total = entries.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const sorted = [...entries].sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
  const topDays = sorted.slice(0, 5);
  const avg = total / entries.length;

  // Recent 14 days
  const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent = entries.filter(e => new Date(e.date).getTime() >= cutoffMs);
  const recentAvg = recent.length > 0
    ? recent.reduce((s, e) => s + (e.cost_usd || 0), 0) / recent.length
    : 0;

  return { total, avg, recentAvg, topDays, count: entries.length };
}

// ── Report builder ───────────────────────────────────────────────────────

function buildReport(): string {
  const today = new Date().toISOString().slice(0, 10);

  const events = loadJsonl<LifecycleEvent>(join(BABELCAST, 'logs/gpu.jsonl'));
  const history = loadJson<Record<string, { runs?: ReadinessRun[] }>>(
    join(BABELCAST, 'gpu-readiness-history.json'), {});
  const ledger = loadJson<CostLedger>(join(BABELCAST, 'cost_ledger.json'), { entries: [] });
  const quota = loadJson<{ failures?: Array<{ at: number; reason: string }> }>(
    join(BABELCAST, 'runpod-quota.json'), { failures: [] });

  const lines: string[] = [];
  lines.push(`# Telemetry Digest — ${today}`);
  lines.push('');
  lines.push('> Auto-generated by `bun run insights:digest`. See `scripts/telemetry-digest.ts`.');
  lines.push('');
  lines.push('## Data sources');
  lines.push('');
  lines.push(`- Lifecycle events: **${events.length}** records`);
  if (events.length > 0) {
    lines.push(`  - Window: ${events[0].ts?.slice(0, 19)} → ${events[events.length - 1].ts?.slice(0, 19)}`);
  }
  lines.push(`- Readiness history: **${Object.keys(history).length}** image×GPU combinations`);
  lines.push(`- Cost ledger entries: **${ledger.entries?.length ?? 0}**`);
  lines.push(`- RunPod quota blocks: **${quota.failures?.length ?? 0}**`);
  lines.push('');

  // ── Provider failure analysis ──
  lines.push('## Provider success rates');
  lines.push('');
  const providerStats = analyzeProviderFailures(events);
  const providers = Object.keys(providerStats).sort();
  if (providers.length === 0) {
    lines.push('_No deploy_failed / deploy_ready events recorded._');
  } else {
    lines.push('| Provider | Success | Fail | Rate | Top error |');
    lines.push('|---|---|---|---|---|');
    for (const p of providers) {
      const s = providerStats[p];
      const total = s.ok + s.fail;
      const rate = total > 0 ? `${Math.round((s.ok / total) * 100)}%` : '—';
      const topErr = Object.entries(s.errors).sort((a, b) => b[1] - a[1])[0];
      const topErrStr = topErr ? `${topErr[1]}× ${topErr[0].slice(0, 50)}` : '—';
      lines.push(`| ${p} | ${s.ok} | ${s.fail} | ${rate} | ${topErrStr} |`);
    }
  }
  lines.push('');

  // ── Readiness latency analysis ──
  lines.push('## Image × GPU latency distribution');
  lines.push('');
  const readyRows = analyzeReadinessHistory(history);
  if (readyRows.length === 0) {
    lines.push('_No readiness history recorded._');
  } else {
    lines.push('| Image × GPU | Stage | p50 | p95 | Tail ratio | Samples |');
    lines.push('|---|---|---|---|---|---|');
    const filtered = readyRows
      .filter(r => r.samples >= 3) // noise filter
      .sort((a, b) => (b.p95 / (b.p50 || 1)) - (a.p95 / (a.p50 || 1)));
    for (const r of filtered.slice(0, 20)) {
      const ratio = r.p50 > 0 ? (r.p95 / r.p50).toFixed(1) + '×' : '—';
      const flag = r.p95 / (r.p50 || 1) > 5 ? ' ⚠️' : '';
      lines.push(`| ${r.imageGpu.slice(0, 50)} | ${r.stage} | ${r.p50}ms | ${r.p95}ms${flag} | ${ratio} | ${r.samples} |`);
    }
    const highTail = filtered.filter(r => r.p95 / (r.p50 || 1) > 5);
    if (highTail.length > 0) {
      lines.push('');
      lines.push(`⚠️ **${highTail.length} image×GPU combinations with tail ratio > 5×** — investigate warmup / cold-path optimization.`);
    }
  }
  lines.push('');

  // ── Spend analysis ──
  lines.push('## Cost ledger');
  lines.push('');
  const spend = analyzeSpend(ledger);
  if (!spend) {
    lines.push('_No spend entries._');
  } else {
    lines.push(`- **Total spent (all time)**: $${spend.total.toFixed(2)}`);
    lines.push(`- **Average per day**: $${spend.avg.toFixed(2)}`);
    lines.push(`- **Recent 14-day avg**: $${spend.recentAvg.toFixed(2)}`);
    lines.push('');
    lines.push('Top 5 spend days:');
    for (const d of spend.topDays) {
      const flag = d.cost_usd > spend.avg * 5 ? ' 🚨 (spike)' : '';
      lines.push(`- ${d.date}: $${d.cost_usd.toFixed(2)}${flag}`);
    }
  }
  lines.push('');

  // ── Quota state ──
  lines.push('## Provider account state');
  lines.push('');
  if (quota.failures && quota.failures.length > 0) {
    lines.push(`- RunPod: **${quota.failures.length}** quota failure(s) tracked`);
    const recent = quota.failures[quota.failures.length - 1];
    lines.push(`- Most recent: ${new Date(recent.at).toISOString().slice(0, 19)}`);
    lines.push(`  > ${recent.reason.slice(0, 200)}`);
  } else {
    lines.push('_RunPod: no quota blocks tracked._');
  }
  lines.push('');

  // ── Summary / alerts ──
  const alerts: string[] = [];
  for (const p of providers) {
    const s = providerStats[p];
    const total = s.ok + s.fail;
    if (total >= 10 && s.ok / total < 0.5) {
      alerts.push(`❌ **${p}** success rate below 50% (${s.ok}/${total})`);
    }
  }
  if (spend && spend.topDays[0] && spend.topDays[0].cost_usd > spend.avg * 5) {
    alerts.push(`🚨 Spend spike detected: $${spend.topDays[0].cost_usd.toFixed(2)} on ${spend.topDays[0].date} (> 5× avg)`);
  }
  if (alerts.length > 0) {
    lines.push('## Alerts');
    lines.push('');
    for (const a of alerts) lines.push(`- ${a}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`Generated at ${new Date().toISOString()}.`);
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const outDir = join(process.cwd(), 'docs', 'insights');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${today}-digest.md`);

  const report = buildReport();
  writeFileSync(outPath, report);

  // Also print a short executive summary to stdout
  console.log(`[telemetry-digest] wrote ${outPath}`);
  const summary = report.split('\n').slice(0, 30).join('\n');
  console.log('\n' + summary + '\n...\n');
}

if (import.meta.main) {
  main();
}
