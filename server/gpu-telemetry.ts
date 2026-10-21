// ── GPU Telemetry — deploy metrics, spend accrual, operational alerts ────────
// Closes the observability gaps found in the 2026-06 cheap-GPU bughunt
// (docs/gpu-cheap-bughunt-checklist.md):
//  - Slot deploys never accrued into dailyGpuSpendUsd: the only accrual lived
//    in the global gpu-monitor-loop, so the budget gate ran blind while every
//    deploy now lands in a per-caller slot.
//  - /metrics carried zero deploy-lifecycle data (no attempts, no failure
//    categories, no boot-time distribution).
//  - Deploy failures, stuck deploys, orphans and cost anomalies alerted
//    nowhere — operators discovered them by grepping logs.
//
// Alert channels are configured via env: SLACK_WEBHOOK_URL,
// DISCORD_WEBHOOK_URL, ALERT_WEBHOOK_URL. With none set, alerts are
// log-only (no-op router).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AlertRouter } from '../src/alerting/alert-router';
import { SlackAlertChannel } from '../src/alerting/channels/slack';
import { DiscordAlertChannel } from '../src/alerting/channels/discord';
import { GenericWebhookAlertChannel } from '../src/alerting/channels/webhook';
import type { AlertChannel, AlertSeverity } from '../src/alerting/types';
import { listDeploySlots } from '../src/gateway/state/deploy-state';
import { deployState, dailyGpuSpendUsd, setDailyGpuSpendUsd, rolloverDailySpendIfNewDay } from './state';
import { createLogger } from '../src/logger';

const log = createLogger('gpu-telemetry');

// ── Operational alerts ───────────────────────────────────────────────────────

let _router: AlertRouter | null | undefined; // undefined = not built yet; null = no channels

function alertRouter(): AlertRouter | null {
  if (_router !== undefined) return _router;
  const channels: AlertChannel[] = [];
  try {
    if (process.env.SLACK_WEBHOOK_URL) channels.push(new SlackAlertChannel(process.env.SLACK_WEBHOOK_URL));
    if (process.env.DISCORD_WEBHOOK_URL) channels.push(new DiscordAlertChannel(process.env.DISCORD_WEBHOOK_URL));
    if (process.env.ALERT_WEBHOOK_URL) channels.push(new GenericWebhookAlertChannel(process.env.ALERT_WEBHOOK_URL));
  } catch (err) {
    log.warn(`alert channel setup failed: ${err instanceof Error ? err.message : err}`);
  }
  _router = channels.length > 0 ? new AlertRouter(channels, { dedupeWindowMs: 5 * 60_000 }) : null;
  if (!_router) log.log('no alert channels configured (SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL / ALERT_WEBHOOK_URL) — GPU alerts are log-only');
  return _router;
}

/** Fire an operational GPU alert. Always logged; routed to Slack/Discord/webhook when configured. */
export function gpuAlert(severity: AlertSeverity, title: string, message: string, metadata?: Record<string, unknown>): void {
  const line = `[gpu-alert:${severity}] ${title} — ${message}`;
  if (severity === 'critical') log.error(line);
  else if (severity === 'warning') log.warn(line);
  else log.log(line);
  const router = alertRouter();
  if (!router) return;
  void router.route({ severity, title, message, metadata, timestamp: new Date() })
    .catch(err => log.warn(`alert route failed: ${err instanceof Error ? err.message : err}`));
}

// ── Deploy lifecycle metrics (Prometheus) ────────────────────────────────────

const BOOT_BUCKETS_S = [30, 60, 120, 300, 600, 1200, 1800];

/** `${provider}|${gpuType}|${result}` → count */
const _deployAttempts = new Map<string, number>();
/** per-provider histogram: bucket counts (one per BOOT_BUCKETS_S + +Inf), sum, count */
const _bootHist = new Map<string, { buckets: number[]; sumS: number; count: number }>();

function bumpAttempt(provider: string, gpuType: string, result: string): void {
  const key = `${provider}|${gpuType || 'unknown'}|${result}`;
  _deployAttempts.set(key, (_deployAttempts.get(key) ?? 0) + 1);
}

function observeBootTime(provider: string, durationMs: number): void {
  const s = durationMs / 1000;
  let h = _bootHist.get(provider);
  if (!h) { h = { buckets: new Array(BOOT_BUCKETS_S.length + 1).fill(0), sumS: 0, count: 0 }; _bootHist.set(provider, h); }
  for (let i = 0; i < BOOT_BUCKETS_S.length; i++) {
    if (s <= BOOT_BUCKETS_S[i]) h.buckets[i]++;
  }
  h.buckets[BOOT_BUCKETS_S.length]++; // +Inf
  h.sumS += s;
  h.count++;
}

/**
 * Hook called from logGpuEvent for every GPU event: feeds the Prometheus
 * registry and routes operational alerts. Must never throw.
 */
export function recordDeployEvent(
  event: string,
  provider: string,
  success: boolean,
  opts?: { durationMs?: number; error?: string; metadata?: Record<string, unknown> },
): void {
  try {
    const gpuType = String(opts?.metadata?.gpuType ?? '');
    if (event === 'deploy_ready') {
      bumpAttempt(provider, gpuType, 'success');
      if (typeof opts?.durationMs === 'number' && opts.durationMs > 0) observeBootTime(provider, opts.durationMs);
      return;
    }
    if (event === 'deploy_failed') {
      const category = String(opts?.metadata?.failureCategory ?? 'unknown');
      bumpAttempt(provider, gpuType, category);
      gpuAlert('warning', `GPU deploy failed (${provider})`,
        `${gpuType || 'gpu'}: ${(opts?.error ?? 'unknown error').slice(0, 300)}`,
        { deployId: opts?.metadata?.deployId, owner: opts?.metadata?.owner, category, durationMs: opts?.durationMs });
      return;
    }
    if (event.includes('orphan')) {
      gpuAlert('warning', `GPU orphan event (${provider})`, `${event}: ${(opts?.error ?? JSON.stringify(opts?.metadata ?? {})).slice(0, 300)}`, opts?.metadata);
      return;
    }
    if (event === 'crash_detected' || opts?.metadata?.reason === 'crash_recovery') {
      gpuAlert('warning', `GPU crash (${provider})`, `${event} — pod ${opts?.metadata?.podId ?? opts?.metadata?.instanceId ?? '?'}`, opts?.metadata);
    }
  } catch (err) {
    log.warn(`recordDeployEvent failed: ${err instanceof Error ? err.message : err}`);
  }
}

function promEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Render deploy-lifecycle metrics in Prometheus text format. */
export function renderGpuTelemetryProm(): string {
  const lines: string[] = [];
  lines.push('# HELP gateway_deploy_attempts_total GPU deploy attempts by provider, gpu type and result (success or failure category)\n# TYPE gateway_deploy_attempts_total counter\n');
  for (const [key, count] of _deployAttempts) {
    const [provider, gpuType, result] = key.split('|');
    lines.push(`gateway_deploy_attempts_total{provider="${promEscape(provider)}",gpu_type="${promEscape(gpuType)}",result="${promEscape(result)}"} ${count}\n`);
  }
  lines.push('# HELP gateway_deploy_boot_time_seconds Time from deploy start to ready\n# TYPE gateway_deploy_boot_time_seconds histogram\n');
  for (const [provider, h] of _bootHist) {
    const p = promEscape(provider);
    for (let i = 0; i < BOOT_BUCKETS_S.length; i++) {
      lines.push(`gateway_deploy_boot_time_seconds_bucket{provider="${p}",le="${BOOT_BUCKETS_S[i]}"} ${h.buckets[i]}\n`);
    }
    lines.push(`gateway_deploy_boot_time_seconds_bucket{provider="${p}",le="+Inf"} ${h.buckets[BOOT_BUCKETS_S.length]}\n`);
    lines.push(`gateway_deploy_boot_time_seconds_sum{provider="${p}"} ${h.sumS.toFixed(1)}\n`);
    lines.push(`gateway_deploy_boot_time_seconds_count{provider="${p}"} ${h.count}\n`);
  }
  return lines.join('');
}

// ── Spend accrual (global + slots) + anomaly detection + stuck watchdog ──────

const ACCRUAL_INTERVAL_MS = 60_000;
const SPEND_HISTORY_FILE = join(homedir(), '.babelcast', 'spend_history.json');
/** States in which the provider bills the instance (storage-only billing for 'stopped' is ignored). */
const BILLING_STATES = new Set(['creating', 'booting', 'installing', 'warming', 'ready']);
const STUCK_ALERT_MS = Math.max(1, Number.parseInt(process.env.GPU_DEPLOY_STUCK_ALERT_MIN ?? '12', 10)) * 60_000;

let _accrualTimer: ReturnType<typeof setInterval> | null = null;
let _lastAccrualAt = 0;
const _stuckAlerted = new Set<string>();
let _anomalyAlertedFor = '';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadSpendHistory(): Record<string, number> {
  try {
    if (existsSync(SPEND_HISTORY_FILE)) return JSON.parse(readFileSync(SPEND_HISTORY_FILE, 'utf-8'));
  } catch { /* corrupt file — start fresh */ }
  return {};
}

function saveSpendHistory(history: Record<string, number>): void {
  try {
    const days = Object.keys(history).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 30))) delete history[d]; // keep last 30 days
    mkdirSync(join(homedir(), '.babelcast'), { recursive: true });
    writeFileSync(SPEND_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    log.warn(`spend history persist failed: ${err instanceof Error ? err.message : err}`);
  }
}

function accrualTick(): void {
  const now = Date.now();
  rolloverDailySpendIfNewDay(todayKey());
  const elapsedHr = _lastAccrualAt > 0 ? (now - _lastAccrualAt) / 3_600_000 : 0;
  _lastAccrualAt = now;

  // The global deployState is accrued by gpu-monitor-loop (which only runs
  // for the global deploy) — accrue SLOT instances here so the budget gate
  // and gateway_daily_spend_usd finally see them.
  let slotCostPerHr = 0;
  const inFlight: Array<{ deployId: string; status: string; startedAt: number; owner: string; gpuType: string }> = [];
  for (const slot of listDeploySlots()) {
    const s = slot.state;
    if (s.podId && BILLING_STATES.has(s.status) && s.costPerHr > 0) slotCostPerHr += s.costPerHr;
    if ((s.status === 'creating' || s.status === 'booting' || s.status === 'installing') && s.startedAt > 0) {
      inFlight.push({ deployId: s.deployId, status: s.status, startedAt: s.startedAt, owner: slot.ownerKey, gpuType: s.gpuType });
    }
  }
  if ((deployState.status === 'creating' || deployState.status === 'booting' || deployState.status === 'installing') && deployState.startedAt > 0) {
    inFlight.push({ deployId: deployState.deployId, status: deployState.status, startedAt: deployState.startedAt, owner: 'global', gpuType: deployState.gpuType });
  }

  if (slotCostPerHr > 0 && elapsedHr > 0) {
    setDailyGpuSpendUsd(dailyGpuSpendUsd + slotCostPerHr * elapsedHr);
  }

  // Spend history + anomaly: alert when today's spend exceeds 1.5× the
  // 7-day average (and is above a $1 noise floor). Once per day.
  const history = loadSpendHistory();
  const today = todayKey();
  history[today] = +dailyGpuSpendUsd.toFixed(4);
  saveSpendHistory(history);
  const prevDays = Object.keys(history).filter(d => d !== today).sort().slice(-7);
  if (prevDays.length >= 3 && _anomalyAlertedFor !== today) {
    const avg = prevDays.reduce((sum, d) => sum + (history[d] ?? 0), 0) / prevDays.length;
    if (dailyGpuSpendUsd > 1 && avg > 0 && dailyGpuSpendUsd > avg * 1.5) {
      _anomalyAlertedFor = today;
      gpuAlert('warning', 'GPU spend anomaly',
        `Today's GPU spend $${dailyGpuSpendUsd.toFixed(2)} is ${(dailyGpuSpendUsd / avg).toFixed(1)}× the ${prevDays.length}-day average ($${avg.toFixed(2)}/day)`,
        { todayUsd: +dailyGpuSpendUsd.toFixed(2), avgUsd: +avg.toFixed(2) });
    }
  }

  // Stuck-deploy watchdog: a deploy sitting in creating/booting beyond the
  // threshold is exactly the "trava" failure mode — surface it instead of
  // waiting for the 30-min timeout to be discovered in logs.
  for (const d of inFlight) {
    const stuckMs = now - d.startedAt;
    const key = d.deployId || `${d.owner}:${d.startedAt}`;
    if (stuckMs >= STUCK_ALERT_MS && !_stuckAlerted.has(key)) {
      _stuckAlerted.add(key);
      gpuAlert('warning', 'GPU deploy taking too long',
        `Deploy ${d.deployId || '?'} (${d.gpuType || 'gpu'}, owner=${d.owner}) stuck in "${d.status}" for ${Math.round(stuckMs / 60_000)} min`,
        { deployId: d.deployId, owner: d.owner, status: d.status, stuckMin: Math.round(stuckMs / 60_000) });
    }
  }
  if (_stuckAlerted.size > 200) _stuckAlerted.clear(); // unbounded-growth guard
}

/** Start the 60s accrual/watchdog loop. Idempotent. */
export function startGpuTelemetry(): void {
  if (_accrualTimer) return;
  _lastAccrualAt = Date.now();
  _accrualTimer = setInterval(() => {
    try { accrualTick(); } catch (err) {
      log.warn(`accrual tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }, ACCRUAL_INTERVAL_MS);
  // Don't keep the process alive just for telemetry.
  if (typeof (_accrualTimer as { unref?: () => void }).unref === 'function') (_accrualTimer as unknown as { unref: () => void }).unref();
  log.log(`started (accrual ${ACCRUAL_INTERVAL_MS / 1000}s, stuck alert ${STUCK_ALERT_MS / 60_000}min)`);
}

export function stopGpuTelemetry(): void {
  if (_accrualTimer) { clearInterval(_accrualTimer); _accrualTimer = null; }
}
