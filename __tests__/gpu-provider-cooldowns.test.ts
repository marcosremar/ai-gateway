import { describe, expect, it } from 'vitest';
import {
  defaultProviderCooldownsPath,
  formatCooldownSeconds,
  legacyProviderCooldownsPath,
  parseActiveProviderCooldowns,
  parseProviderList,
} from '../src/modules/gpu-finetune';

describe('gpu finetune provider cooldown helpers', () => {
  it('parses only active provider cooldowns', () => {
    const now = 1_000_000;
    const active = parseActiveProviderCooldowns({
      Vast: { cooldownUntilMs: now + 90_000, failCount: 8 },
      runpod: { cooldownUntilMs: now - 1, failCount: 1 },
      modal: { until: now + 10_000, failures: 2 },
      malformed: { cooldownUntilMs: 'nope' },
    }, now);

    expect(Object.keys(active).sort()).toEqual(['modal', 'vast']);
    expect(active.vast.remainSec).toBe(90);
    expect(active.vast.failCount).toBe(8);
    expect(active.modal.failCount).toBe(2);
  });

  it('normalizes provider allowlists from flags and specs', () => {
    expect(parseProviderList(undefined, ['RunPod,Vast', 'vast', ' modal '])).toEqual(['runpod', 'vast', 'modal']);
    expect(parseProviderList('Vast')).toEqual(['vast']);
  });

  it('formats cooldown durations for operator logs', () => {
    expect(formatCooldownSeconds(45)).toBe('45s');
    expect(formatCooldownSeconds(61)).toBe('2m');
    expect(formatCooldownSeconds(3601)).toBe('2h');
  });

  it('uses ~/.ai-gateway as the canonical cooldown path', () => {
    expect(defaultProviderCooldownsPath('/tmp/home')).toBe('/tmp/home/.ai-gateway/cooldowns.json');
    expect(legacyProviderCooldownsPath('/tmp/home')).toBe('/tmp/home/.babelcast/cooldowns.json');
  });
});
