import { activeWindow } from './autoscale';
import type { DeploymentView } from './types';

export const IDLE_ALERT_DEFAULT_MIN = 15;

export type IdleView = Pick<DeploymentView, 'replicas' | 'spec' | 'lastRequestAt'> & { warm?: DeploymentView['warm']; hold?: DeploymentView['hold'] };

export interface IdleGpu { minutes: number; limitMinutes: number; eurPerHour: number; wastedEur: number }

export function idleGpu(d: IdleView, now: number): IdleGpu | null {
  const up = d.replicas.filter(r => r.phase !== 'halted');
  if (!up.length || d.warm || d.hold || activeWindow(d.spec.warmSchedule, now)) return null;
  const startedAt = now - Math.max(...up.map(r => r.ageSeconds || 0)) * 1000;
  const last = Math.max(startedAt, d.lastRequestAt ? Date.parse(d.lastRequestAt) : -Infinity);
  const minutes = (now - last) / 60_000;
  const limitMinutes = d.spec.idleMinutes || IDLE_ALERT_DEFAULT_MIN;
  if (minutes < limitMinutes) return null;
  const eurPerHour = up.reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
  return { minutes, limitMinutes, eurPerHour, wastedEur: (eurPerHour * minutes) / 60 };
}
