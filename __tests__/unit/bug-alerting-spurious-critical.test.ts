/**
 * Bug: createAlertingHooks().onHealthChange treats every non-'ready' state
 * as severity: 'critical'. That includes legitimate transitional states like
 * 'booting', 'installing', and 'warming' — which are part of a normal deploy
 * lifecycle, not failures. Operators get critical alerts for every booting
 * pod, training them to ignore the channel.
 *
 * Critical should fire when transitioning AWAY from 'ready' (a healthy pod
 * went unhealthy) or hitting an explicit error state ('error', 'down',
 * 'unhealthy', 'failed'). Boot-progression transitions are info.
 */
import { describe, it, expect } from 'vitest';
import { createAlertingHooks } from '../../src/alerting/hooks-adapter';

describe('createAlertingHooks().onHealthChange — severity classification', () => {
  it('uses info for normal boot-progression transitions (not critical)', () => {
    const seen: any[] = [];
    const router = { route: (a: any) => seen.push(a) } as any;
    const hooks = createAlertingHooks(router);

    hooks.onHealthChange!({
      userId: 'u', tierIndex: 0, provider: 'runpod',
      previousState: 'booting',
      newState: 'installing', // still mid-deploy, not failure
      timestamp: Date.now(),
    });

    expect(seen).toHaveLength(1);
    // 'installing' is a normal lifecycle state, NOT a failure.
    expect(seen[0].severity).not.toBe('critical');
  });

  it('uses critical when transitioning AWAY from ready', () => {
    const seen: any[] = [];
    const router = { route: (a: any) => seen.push(a) } as any;
    const hooks = createAlertingHooks(router);
    hooks.onHealthChange!({
      userId: 'u', tierIndex: 0, provider: 'runpod',
      previousState: 'ready',
      newState: 'error',
      timestamp: Date.now(),
    });
    expect(seen[0].severity).toBe('critical');
  });

  it('uses info when transitioning INTO ready', () => {
    const seen: any[] = [];
    const router = { route: (a: any) => seen.push(a) } as any;
    const hooks = createAlertingHooks(router);
    hooks.onHealthChange!({
      userId: 'u', tierIndex: 0, provider: 'runpod',
      previousState: 'booting',
      newState: 'ready',
      timestamp: Date.now(),
    });
    expect(seen[0].severity).toBe('info');
  });
});
