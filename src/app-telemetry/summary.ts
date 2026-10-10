// ── AI Gateway — Desktop-app field telemetry: aggregation for GET /v1/telemetry/app/summary ───────────────────────

import type { FieldValue, Fields, StoredAppEvent } from './validate';

export interface Quantiles { count: number; p50: number | null; p95: number | null }

export interface AppTelemetrySummary {
  since: number;
  until: number;
  events: number;
  installs: number;
  sessions: { started: number; ended: number; totalDurationS: number; avgDurationS: number | null };
  crashes: { total: number; byLocation: Record<string, number> };
  /** Utterance delay per stage (ms): `total` = end of speech → subtitle shown. */
  utteranceDelay: Record<string, Quantiles>;
  utterances: number;
  errors: { total: number; perHundredUtterances: number | null; byCode: Array<{ code: string; count: number; perHundredUtterances: number | null }> };
  /** Distinct installs per app version / OS. */
  versions: Record<string, number>;
  os: Record<string, number>;
  dubbing: { sessions: number; rate: number | null };
  swap: { events: number; installs: number; sessions: number };
  gpuWait: Quantiles & { failures: number };
  appStarts: number;
  appExits: number;
}

/** Nearest-rank percentile of ascending numbers. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

const quantiles = (values: number[]): Quantiles => {
  const s = [...values].sort((a, b) => a - b);
  return { count: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
};

const num = (v: FieldValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: FieldValue | undefined): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, 120) : null);

/** Slowest LLM call of an utterance: `llm_ms`, else the max of `llm[].ms` (languages run in parallel). */
function llmMs(f: Fields): number | null {
  const direct = num(f.llm_ms);
  if (direct !== null) return direct;
  if (!Array.isArray(f.llm)) return null;
  const all = f.llm.map(l => (l && typeof l === 'object' && !Array.isArray(l) ? num(l.ms) : null)).filter((v): v is number => v !== null);
  return all.length ? Math.max(...all) : null;
}

const UTTERANCE_STAGES: Record<string, (f: Fields) => number | null> = {
  total: f => num(f.total_ms),
  stt: f => num(f.stt_ms),
  stt_gateway: f => num(f.stt_gateway_ms),
  llm: llmMs,
  tts: f => num(f.tts_ms),
  audio: f => num(f.audio_ms),
};

const bump = (m: Record<string, number>, k: string, by = 1): void => { m[k] = (m[k] ?? 0) + by; };
const sessionKey = (r: StoredAppEvent): string | null => { const s = str(r.fields.session); return s ? `${r.installId}/${s}` : null; };
const per100 = (n: number, d: number): number | null => (d > 0 ? Math.round((n * 10_000) / d) / 100 : null);

export function summarize(rows: readonly StoredAppEvent[], since: number, until: number): AppTelemetrySummary {
  const installs = new Set<string>();
  const versionInstalls = new Map<string, Set<string>>();
  const osInstalls = new Map<string, Set<string>>();
  const stageValues: Record<string, number[]> = Object.fromEntries(Object.keys(UTTERANCE_STAGES).map(k => [k, []]));
  const crashes: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const swapInstalls = new Set<string>();
  const swapSessions = new Set<string>();
  const gpuWaits: number[] = [];
  let started = 0, ended = 0, durationS = 0, durations = 0, dubbing = 0, utterances = 0, errors = 0, swaps = 0;
  let gpuFailures = 0, appStarts = 0, appExits = 0, crashTotal = 0;

  for (const r of rows) {
    installs.add(r.installId);
    (versionInstalls.get(r.appVersion) ?? versionInstalls.set(r.appVersion, new Set()).get(r.appVersion)!).add(r.installId);
    (osInstalls.get(r.os) ?? osInstalls.set(r.os, new Set()).get(r.os)!).add(r.installId);
    const f = r.fields;
    switch (r.kind) {
      case 'session_start':
        started++;
        if (f.dubbing === true) dubbing++;
        break;
      case 'session_end': {
        ended++;
        const d = num(f.duration_s);
        if (d !== null) { durationS += d; durations++; }
        break;
      }
      case 'utterance':
        utterances++;
        for (const [stage, pick] of Object.entries(UTTERANCE_STAGES)) {
          const v = pick(f);
          if (v !== null) stageValues[stage]!.push(v);
        }
        break;
      case 'crash':
        crashTotal++;
        bump(crashes, str(f.location) ?? str(f.thread) ?? 'unknown');
        break;
      case 'error': {
        errors++;
        const code = str(f.code) ?? 'unknown';
        const stage = str(f.stage);
        bump(errorCodes, stage ? `${stage}:${code}` : code);
        break;
      }
      case 'direction_changed': {
        swaps++;
        swapInstalls.add(r.installId);
        const s = sessionKey(r);
        if (s) swapSessions.add(s);
        break;
      }
      case 'gpu_wait': {
        const ms = num(f.ms) ?? num(f.wait_ms);
        if (ms !== null) gpuWaits.push(ms);
        if (f.ok === false || str(f.error) !== null) gpuFailures++;
        break;
      }
      case 'app_start': appStarts++; break;
      case 'app_exit': appExits++; break;
      default: break;
    }
  }

  const count = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, s]) => [k, s.size]).sort((a, b) => (b[1] as number) - (a[1] as number)));
  return {
    since, until,
    events: rows.length,
    installs: installs.size,
    sessions: { started, ended, totalDurationS: durationS, avgDurationS: durations ? Math.round(durationS / durations) : null },
    crashes: { total: crashTotal, byLocation: crashes },
    utteranceDelay: Object.fromEntries(Object.entries(stageValues).map(([k, v]) => [k, quantiles(v)])),
    utterances,
    errors: {
      total: errors,
      perHundredUtterances: per100(errors, utterances),
      byCode: Object.entries(errorCodes).sort((a, b) => b[1] - a[1])
        .map(([code, n]) => ({ code, count: n, perHundredUtterances: per100(n, utterances) })),
    },
    versions: count(versionInstalls),
    os: count(osInstalls),
    dubbing: { sessions: dubbing, rate: started ? Math.round((dubbing / started) * 1000) / 1000 : null },
    swap: { events: swaps, installs: swapInstalls.size, sessions: swapSessions.size },
    gpuWait: { ...quantiles(gpuWaits), failures: gpuFailures },
    appStarts, appExits,
  };
}
