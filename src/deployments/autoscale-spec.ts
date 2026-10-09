/**
 * Validation of the autoscaling fields of a deployment spec (`autoscale`, `warmSchedule`), kept apart from spec.ts.
 * Both optional: a spec without them scales as before plus the defaults of `autoscale.ts`.
 */

import { DEFAULT_WARM_TIME_ZONE } from './autoscale';
import { SpecError } from './spec-error';
import type { AutoscaleSpec, QuotaReservation, WarmScheduleEntry } from './types';

const AUTOSCALE_FIELDS: Record<keyof AutoscaleSpec, [number, number]> = {
  scaleOutAt: [0.1, 1], scaleInAt: [0, 0.95], windowSeconds: [0, 600], latencyP95Ms: [50, 120_000], errorRate: [0, 1],
  maxInflightFactor: [1, 10], drainSeconds: [0, 1800],
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_WINDOWS = 20;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function autoscaleOf(raw: unknown): AutoscaleSpec {
  if (!isObject(raw)) throw new SpecError('autoscale must be an object');
  const out: AutoscaleSpec = {};
  for (const [key, value] of Object.entries(raw)) {
    const range = AUTOSCALE_FIELDS[key as keyof AutoscaleSpec];
    if (!range) throw new SpecError(`autoscale: unknown field '${key}'`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      throw new SpecError(`autoscale.${key} must be a number in ${range[0]}–${range[1]}`);
    }
    out[key as keyof AutoscaleSpec] = value;
  }
  if (out.scaleInAt !== undefined && out.scaleOutAt !== undefined && out.scaleInAt >= out.scaleOutAt) {
    throw new SpecError('autoscale.scaleInAt must be below scaleOutAt (hysteresis)');
  }
  return out;
}

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function reserveQuotaOf(raw: unknown, maxReplicasCap: number): QuotaReservation {
  if (!isObject(raw) || Object.keys(raw).some(k => k !== 'quota' && k !== 'windows')) throw new SpecError('reserveQuota must be { quota, windows }');
  const windows = warmScheduleOf(raw.windows, maxReplicasCap, 'reserveQuota.windows');
  const most = Math.max(0, ...windows.map(w => w.minReplicas));
  if (typeof raw.quota !== 'number' || !Number.isInteger(raw.quota) || raw.quota < most || raw.quota > 64) {
    throw new SpecError(`reserveQuota.quota must be an integer from the largest window minReplicas (${most}) to 64`);
  }
  return { quota: raw.quota, windows };
}

export function warmScheduleOf(raw: unknown, maxReplicasCap: number, field = 'warmSchedule'): WarmScheduleEntry[] {
  if (!Array.isArray(raw) || raw.length > MAX_WINDOWS) throw new SpecError(`${field} must list at most ${MAX_WINDOWS} windows`);
  return raw.map((entry, i) => {
    const f = `${field}[${i}]`;
    if (!isObject(entry)) throw new SpecError(`${f} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!['days', 'start', 'end', 'timeZone', 'minReplicas'].includes(key)) throw new SpecError(`${f}: unknown field '${key}'`);
    }
    if (typeof entry.start !== 'string' || !HHMM.test(entry.start)) throw new SpecError(`${f}.start must be HH:MM`);
    if (typeof entry.end !== 'string' || !HHMM.test(entry.end) || entry.end === entry.start) throw new SpecError(`${f}.end must be HH:MM, not start`);
    const n = entry.minReplicas;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > maxReplicasCap) throw new SpecError(`${f}.minReplicas must be 1–${maxReplicasCap}`);
    const out: WarmScheduleEntry = { start: entry.start, end: entry.end, timeZone: DEFAULT_WARM_TIME_ZONE, minReplicas: n };
    if (entry.days !== undefined) {
      if (!Array.isArray(entry.days) || !entry.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new SpecError(`${f}.days must list 0–6 (0 = Sunday)`);
      out.days = [...new Set(entry.days as number[])];
    }
    if (entry.timeZone !== undefined) {
      if (typeof entry.timeZone !== 'string' || !validTimeZone(entry.timeZone)) throw new SpecError(`${f}.timeZone is not a known IANA zone`);
      out.timeZone = entry.timeZone;
    }
    return out;
  });
}
