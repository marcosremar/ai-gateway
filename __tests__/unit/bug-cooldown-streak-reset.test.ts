/**
 * Regression: CooldownTracker.isCoolingDown deleted the state map entry the
 * first time a request observed an expired cooldown, which wiped
 * `cooldownStreak`/`lastCooldownMs`. The next recordFailure then started
 * fresh at base cooldown — so the documented adaptive escalation
 * ("if this provider just came off cooldown and failed again immediately,
 * double the cooldown duration") never fired in production usage where
 * isCoolingDown is consulted before each provider attempt.
 */
import { describe, it, expect } from 'vitest';
import { CooldownTracker, type FallbackEntry } from '../../src/providers/fallback';

describe('CooldownTracker — adaptive cooldown escalation across expiry', () => {
  it('preserves cooldownStreak across an isCoolingDown probe of an expired window', async () => {
    const tracker = new CooldownTracker();
    const entry: FallbackEntry = { provider: 'groq', model: 'test-streak' };

    // First cooldown: allowedFails=1, base=20ms → streak should become 1.
    tracker.recordFailure(entry, 1, 20);
    let state = tracker.getState().get('groq:test-streak');
    expect(state).toBeDefined();
    expect(state!.cooldownStreak).toBe(1);
    expect(state!.lastCooldownMs).toBe(20);

    // Let the 20ms cooldown expire.
    await new Promise(r => setTimeout(r, 35));

    // Mimic withProviderFallback's normal flow: probe before retrying.
    expect(tracker.isCoolingDown(entry)).toBe(false);

    // Provider fails again — escalation must kick in: streak=2, cooldown=40ms.
    tracker.recordFailure(entry, 1, 20);
    state = tracker.getState().get('groq:test-streak');
    expect(state).toBeDefined();
    expect(state!.cooldownStreak).toBe(2);
    expect(state!.lastCooldownMs).toBe(40);
  });
});
