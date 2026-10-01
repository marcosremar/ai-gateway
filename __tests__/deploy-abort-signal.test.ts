/**
 * The deploy abort signal: cancelling a deploy (terminate / redeploy) must
 * abort the signal handed to provider createInstance(), and a new deploy must
 * get a fresh, un-aborted signal.
 */
import { describe, it, expect } from 'vitest';
import { getDeployAbortSignal, setDeployCancelled } from '../src/gateway/state/deploy-state';

describe('deploy abort signal', () => {
  it('aborts on cancel and is renewed for the next deploy', () => {
    setDeployCancelled(false);
    const first = getDeployAbortSignal();
    expect(first.aborted).toBe(false);

    setDeployCancelled(true);
    expect(first.aborted).toBe(true);
    expect((first.reason as DOMException).name).toBe('AbortError');
    setDeployCancelled(true); // idempotent

    setDeployCancelled(false);
    const second = getDeployAbortSignal();
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
  });
});
