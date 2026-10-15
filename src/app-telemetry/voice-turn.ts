import type { StoredAppEvent } from './validate';
import { percentile } from './summary';

export const VOICE_TURN_STAGES = ['stt', 'llm', 'tts', 'probe'] as const;
export const VOICE_TURN_TARGET_MS = 1_500;
export const VOICE_TURN_CEILING_MS = 2_000;
export const VOICE_TURN_ALERT = { windowMs: 10 * 60_000, minTurns: 20, failShare: 0.1, p95Ms: 4_000 } as const;
export const VOICE_TURN_KEEP_MS = 7 * 86_400_000;
export const VOICE_TURNS_KEPT = 50_000;
export const CLASS_GAP_MS = 45 * 60_000;

const FIELDS = ['ok', 'failedStage', 'reason', 'requestId', 'ms', 'degraded', 'stage', 'classWindow'];
const MS_KEYS = ['stt', 'probe', 'llm', 'tts', 'total'];
const MAX_MS = 10 * 60_000;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,47}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validMs = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS);

export function voiceTurnProblem(f: Record<string, unknown>): string | null {
  const extra = Object.keys(f).find(k => !FIELDS.includes(k));
  if (extra !== undefined) return `${extra.slice(0, 64)} is not accepted: a voice.turn carries only ${FIELDS.join(', ')} (no transcript, text or student fields)`;
  if (typeof f.ok !== 'boolean') return 'ok must be a boolean';
  if (f.failedStage !== undefined && !(VOICE_TURN_STAGES as readonly unknown[]).includes(f.failedStage)) return `failedStage must be one of ${VOICE_TURN_STAGES.join(', ')}`;
  if (f.reason !== undefined && (typeof f.reason !== 'string' || !CODE.test(f.reason))) return 'reason must be a short code: letters, digits and _ . : -, at most 48';
  if (typeof f.requestId !== 'string' || !REQUEST_ID.test(f.requestId)) return 'requestId is missing or invalid';
  if (!isObject(f.ms) || Object.entries(f.ms).some(([k, v]) => !MS_KEYS.includes(k) || !validMs(v))) return `ms must hold only ${MS_KEYS.join(', ')} in milliseconds`;
  if (!Array.isArray(f.degraded) || f.degraded.length > 8 || f.degraded.some(d => typeof d !== 'string' || !CODE.test(d))) return 'degraded must be a list of at most 8 stage codes';
  if (f.stage !== '360' && f.stage !== 'fast') return "stage must be '360' or 'fast'";
  if (typeof f.classWindow !== 'boolean') return 'classWindow must be a boolean';
  return null;
}

export interface VoiceTurn {
  at: number; app: string; ok: boolean; failedStage: string | null; reason: string | null; requestId: string;
  totalMs: number | null; degraded: string[]; stage: string; classWindow: boolean;
}

export function voiceTurnOf(r: StoredAppEvent): VoiceTurn {
  const f = r.fields;
  const ms = isObject(f.ms) ? f.ms : {};
  return {
    at: r.ts, app: r.app, ok: f.ok === true, failedStage: typeof f.failedStage === 'string' ? f.failedStage : null,
    reason: typeof f.reason === 'string' ? f.reason : null, requestId: String(f.requestId ?? ''),
    totalMs: typeof ms.total === 'number' ? ms.total : null, degraded: Array.isArray(f.degraded) ? f.degraded.map(String) : [],
    stage: String(f.stage ?? ''), classWindow: f.classWindow === true,
  };
}

export interface TurnStats {
  turns: number; failed: number; okShare: number | null; p50Ms: number | null; p95Ms: number | null;
  failures: Array<{ stage: string; reason: string; count: number }>; degraded: Array<{ stage: string; count: number }>;
}

const ranked = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]);

export function turnStats(turns: readonly VoiceTurn[]): TurnStats {
  const totals = turns.flatMap(t => (t.totalMs === null ? [] : [t.totalMs])).sort((a, b) => a - b);
  const failures = new Map<string, number>();
  const degraded = new Map<string, number>();
  for (const t of turns) {
    if (!t.ok) {
      const key = `${t.failedStage ?? 'unknown'}\n${t.reason ?? 'unknown'}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
    for (const d of new Set(t.degraded)) degraded.set(d, (degraded.get(d) ?? 0) + 1);
  }
  const failed = turns.filter(t => !t.ok).length;
  return {
    turns: turns.length, failed, okShare: turns.length ? (turns.length - failed) / turns.length : null,
    p50Ms: percentile(totals, 50), p95Ms: percentile(totals, 95),
    failures: ranked(failures).map(([key, count]) => ({ stage: key.split('\n')[0]!, reason: key.split('\n')[1]!, count })),
    degraded: ranked(degraded).map(([stage, count]) => ({ stage, count })),
  };
}

export interface ClassSession { startedAt: number; endedAt: number; turns: VoiceTurn[] }

export function classSessions(turns: readonly VoiceTurn[]): ClassSession[] {
  const sessions: ClassSession[] = [];
  for (const t of turns.filter(x => x.classWindow).sort((a, b) => a.at - b.at)) {
    const last = sessions.at(-1);
    if (last && t.at - last.endedAt < CLASS_GAP_MS) {
      last.turns.push(t);
      last.endedAt = t.at;
    } else sessions.push({ startedAt: t.at, endedAt: t.at, turns: [t] });
  }
  return sessions;
}

export function alarming(s: TurnStats): { failing: boolean; slow: boolean } {
  const enough = s.turns >= VOICE_TURN_ALERT.minTurns;
  return { failing: enough && s.failed / s.turns >= VOICE_TURN_ALERT.failShare, slow: enough && (s.p95Ms ?? 0) > VOICE_TURN_ALERT.p95Ms };
}
