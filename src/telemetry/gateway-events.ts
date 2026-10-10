/**
 * Deployment controller log lines → gateway telemetry events. The controller already narrates every autoscale
 * decision and replica lifecycle step through its injected `log(msg, data)`; serve.ts wraps that callback with
 * `deploymentLogToTelemetry`, so those decisions land in the same sink as browser and edge events without the
 * controller knowing about telemetry. Unknown messages are ignored.
 *
 * `data.deployment` → `deployment`, `data.id` → `replicaId`, `bootMs` → `durMs`; other scalar fields → `attrs`
 * (then the scrubber applies like for any event).
 */

import type { TelemetryLevel } from './contract';
import { emitGatewayEvent } from './emit';

const MAP: Record<string, { event: string; level?: TelemetryLevel }> = {
  'deployments: autoscale': { event: 'autoscale.decision' },
  'deployments: warm window': { event: 'autoscale.warm' },
  'deployments: reclaiming idle replica for a deployment under pressure': { event: 'autoscale.reclaim' },
  'deployments: creating replica': { event: 'replica.creating' },
  'deployments: create failed': { event: 'replica.create_failed', level: 'error' },
  'deployments: replica ready': { event: 'replica.ready' },
  'deployments: replica unhealthy': { event: 'replica.unhealthy', level: 'warn' },
  'deployments: replica too far': { event: 'replica.too_far', level: 'warn' },
  'deployments: stage out of rotation': { event: 'replica.stage_out', level: 'warn' },
  'deployments: stage back in rotation': { event: 'replica.stage_back' },
  'deployments: draining replica': { event: 'replica.draining' },
  'deployments: releasing replica': { event: 'replica.released' },
  'deployments: replica gone': { event: 'replica.gone', level: 'warn' },
  'deployments: parking replica (power off)': { event: 'replica.parked' },
  'deployments: powering parked replica on': { event: 'replica.power_on' },
  'deployments: list failed': { event: 'provider.list_failed', level: 'warn' },
  'deployments: provider credit exhausted': { event: 'provider.credit_exhausted', level: 'error' },
  'deployments: provider credit back': { event: 'provider.credit_back' },
  'deployments: vast offer too far before renting': { event: 'replica.too_far_before_rent', level: 'warn' },
};

export function deploymentLogToTelemetry(msg: string, data?: Record<string, unknown>): void {
  const m = MAP[msg];
  if (!m) return;
  const attrs: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'deployment' || k === 'id' || k === 'bootMs') continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') attrs[k] = v;
    else if (typeof v === 'string') attrs[k] = v.slice(0, 200);
  }
  const deployment = typeof data?.deployment === 'string' ? data.deployment : typeof data?.to === 'string' ? data.to : undefined;
  emitGatewayEvent(m.event, {
    level: m.level ?? 'info',
    ...(deployment ? { deployment } : {}),
    ...(typeof data?.id === 'string' ? { replicaId: data.id } : {}),
    ...(typeof data?.bootMs === 'number' ? { durMs: data.bootMs } : {}),
    attrs,
  });
}
