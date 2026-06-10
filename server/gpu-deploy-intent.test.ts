import { afterEach, describe, expect, it } from 'bun:test';
import {
  isAutonomousRedeployAllowed,
  recordDeployIntent,
  getLastDeployIntent,
  clearDeployIntent,
  checkAutonomousRedeploy,
  autonomousRedeployMaxAgeMs,
} from './gpu-deploy-intent';

const MIN = 60_000;

afterEach(() => clearDeployIntent());

describe('isAutonomousRedeployAllowed', () => {
  it('blocks when no intent was recorded this session (the 2026-06-10 gpu-dev resurrect)', () => {
    const r = isAutonomousRedeployAllowed({
      image: 'marcosremar/gpu-dev:latest',
      intent: null,
      now: 1_000_000,
      maxAgeMs: 30 * MIN,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no deploy/resume intent');
  });

  it('allows a recent same-image intent', () => {
    const r = isAutonomousRedeployAllowed({
      image: 'ollama/ollama:latest',
      intent: { image: 'ollama/ollama:latest', at: 1_000_000 - 5 * MIN },
      now: 1_000_000,
      maxAgeMs: 30 * MIN,
    });
    expect(r.ok).toBe(true);
  });

  it('blocks stale intent past max age', () => {
    const r = isAutonomousRedeployAllowed({
      image: 'ollama/ollama:latest',
      intent: { image: 'ollama/ollama:latest', at: 1_000_000 - 31 * MIN },
      now: 1_000_000,
      maxAgeMs: 30 * MIN,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('31min old');
  });

  it('blocks cross-image redeploys', () => {
    const r = isAutonomousRedeployAllowed({
      image: 'marcosremar/gpu-dev:latest',
      intent: { image: 'ollama/ollama:latest', at: 1_000_000 - MIN },
      now: 1_000_000,
      maxAgeMs: 30 * MIN,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cross-image');
  });

  it('blocks when there is no image at all', () => {
    const r = isAutonomousRedeployAllowed({ image: '', intent: null, now: 0, maxAgeMs: 30 * MIN });
    expect(r.ok).toBe(false);
  });
});

describe('recordDeployIntent / checkAutonomousRedeploy', () => {
  it('records and permits the same image immediately', () => {
    recordDeployIntent('ollama/ollama:latest');
    expect(getLastDeployIntent()?.image).toBe('ollama/ollama:latest');
    expect(checkAutonomousRedeploy('ollama/ollama:latest').ok).toBe(true);
    expect(checkAutonomousRedeploy('marcosremar/gpu-dev:latest').ok).toBe(false);
  });

  it('ignores empty image records', () => {
    recordDeployIntent('');
    expect(getLastDeployIntent()).toBeNull();
  });
});

describe('autonomousRedeployMaxAgeMs', () => {
  it('defaults to 30 minutes', () => {
    const prev = process.env.AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN;
    delete process.env.AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN;
    expect(autonomousRedeployMaxAgeMs()).toBe(30 * MIN);
    if (prev !== undefined) process.env.AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN = prev;
  });

  it('honors the env override', () => {
    process.env.AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN = '5';
    expect(autonomousRedeployMaxAgeMs()).toBe(5 * MIN);
    delete process.env.AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN;
  });
});
