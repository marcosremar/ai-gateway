import { SpecError } from './spec-error';
import type { ScalingHold, ScalingMode, ScalingSpec } from './types';

const MODES: readonly ScalingMode[] = ['economy', 'balanced', 'fast'];
export const DEFAULT_SCALING_MODE: ScalingMode = 'balanced';
const TARGET_FIELDS: Record<string, [number, number]> = { p50Ms: [50, 120_000], p95Ms: [50, 120_000] };
const BUDGET_FIELDS: Record<string, [number, number]> = { eurPerHour: [0.001, 1000], eurPerMonth: [0.01, 1_000_000], maxReplicas: [1, 10] };
const HOLD_MAX_MINUTES = 12 * 60;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function numbers(raw: unknown, field: string, ranges: Record<string, [number, number]>): Record<string, number> {
  if (!isObject(raw)) throw new SpecError(`${field} must be an object`);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const range = ranges[key];
    if (!range) throw new SpecError(`${field}: unknown field '${key}'`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      throw new SpecError(`${field}.${key} must be a number in ${range[0]}–${range[1]}`);
    }
    out[key] = value;
  }
  return out;
}

export function scalingOf(raw: unknown): ScalingSpec {
  if (!isObject(raw)) throw new SpecError('scaling must be an object');
  for (const key of Object.keys(raw)) {
    if (!['target', 'budget', 'mode'].includes(key)) throw new SpecError(`scaling: unknown field '${key}'`);
  }
  const mode = raw.mode ?? DEFAULT_SCALING_MODE;
  if (!MODES.includes(mode as ScalingMode)) throw new SpecError(`scaling.mode must be one of ${MODES.join(', ')}`);
  const out: ScalingSpec = { mode: mode as ScalingMode };
  if (raw.target !== undefined) {
    out.target = numbers(raw.target, 'scaling.target', TARGET_FIELDS);
    if (out.target.p50Ms !== undefined && out.target.p95Ms !== undefined && out.target.p50Ms > out.target.p95Ms) {
      throw new SpecError('scaling.target.p50Ms cannot exceed p95Ms');
    }
  }
  if (raw.budget !== undefined) {
    out.budget = numbers(raw.budget, 'scaling.budget', BUDGET_FIELDS);
    if (out.budget.maxReplicas !== undefined && !Number.isInteger(out.budget.maxReplicas)) {
      throw new SpecError('scaling.budget.maxReplicas must be an integer');
    }
  }
  return out;
}

export function splitHold(body: Record<string, unknown>): { body: Record<string, unknown>; hold?: unknown } {
  if (!isObject(body.scaling) || !('hold' in body.scaling)) return { body };
  const { hold, ...scaling } = body.scaling;
  const { scaling: _scaling, ...rest } = body;
  return { body: Object.keys(scaling).length ? { ...rest, scaling } : rest, hold };
}

export function holdOf(raw: unknown, maxReplicas: number, now: number): ScalingHold | undefined {
  if (raw === null) return undefined;
  if (!isObject(raw)) throw new SpecError('scaling.hold must be { replicas, untilMinutes } or null');
  const { replicas, untilMinutes } = raw;
  if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 0 || replicas > maxReplicas) {
    throw new SpecError(`scaling.hold.replicas must be an integer 0–${maxReplicas} (the deployment's maxReplicas)`);
  }
  if (typeof untilMinutes !== 'number' || !Number.isFinite(untilMinutes) || untilMinutes <= 0 || untilMinutes > HOLD_MAX_MINUTES) {
    throw new SpecError(`scaling.hold.untilMinutes must be a number in (0, ${HOLD_MAX_MINUTES}]`);
  }
  return { replicas, until: now + untilMinutes * 60_000 };
}
