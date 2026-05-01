/**
 * Wire GatewayHooks → AlertRouter.
 */

import type { GatewayHooks } from '../hooks';
import type { AlertRouter } from './alert-router';

export function createAlertingHooks(router: AlertRouter): Partial<GatewayHooks> {
  return {
    onCostAlert: (data) => {
      router.route({
        severity: 'warning',
        title: 'Cost Alert',
        message: data.message,
        metadata: { provider: data.provider, instanceId: data.instanceId, alertType: data.alertType },
        timestamp: new Date(data.timestamp),
      });
    },

    onHealthChange: (data) => {
      // Treat normal lifecycle transitions ('booting', 'installing', 'warming',
      // 'pending') as informational. Only escalate to 'critical' when a
      // healthy pod degraded (was 'ready') or the new state is an explicit
      // failure mode. Otherwise operators get paged for every boot step.
      const FAILURE_STATES = new Set(['error', 'down', 'unhealthy', 'failed']);
      const wasHealthy = data.previousState === 'ready';
      const becameFailure = FAILURE_STATES.has((data.newState ?? '').toLowerCase());
      const becameReady = data.newState === 'ready';
      let severity: 'info' | 'warning' | 'critical' = 'info';
      if (becameReady) severity = 'info';
      else if (wasHealthy || becameFailure) severity = 'critical';
      router.route({
        severity,
        title: 'Health Change',
        message: `Tier ${data.tierIndex}: ${data.previousState} → ${data.newState}`,
        metadata: { provider: data.provider, endpoint: data.endpoint },
        timestamp: new Date(data.timestamp),
      });
    },

    onFallback: (data) => {
      router.route({
        severity: 'warning',
        title: 'Provider Fallback',
        message: `${data.stage}: ${data.fromProvider} → ${data.toProvider} (${data.reason})`,
        metadata: { stage: data.stage, fromModel: data.fromModel, toModel: data.toModel },
        timestamp: new Date(data.timestamp),
      });
    },

    onScaleUp: (data) => {
      router.route({
        severity: 'info',
        title: 'Scale Up',
        message: `Tier ${data.tierIndex} scaling up (${data.trigger})`,
        metadata: { provider: data.provider, activeSessions: data.activeSessions },
        timestamp: new Date(data.timestamp),
      });
    },

    onScaleDown: (data) => {
      router.route({
        severity: 'info',
        title: 'Scale Down',
        message: `Tier ${data.tierIndex} scaling down (${data.reason})`,
        metadata: { provider: data.provider, idleMinutes: data.idleMinutes },
        timestamp: new Date(data.timestamp),
      });
    },
  };
}
