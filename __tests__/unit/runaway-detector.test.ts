/**
 * P0-2: Runaway detector tests
 *
 * Scenario reference: 2026-03-25 — a create/destroy loop on RunPod burned
 * $130 and triggered an abuse flag. The detector must catch the loop
 * within the first few seconds and pause the provider before damage spreads.
 */

import { describe, it, expect, vi } from 'vitest';
import { RunawayDetector } from '../../src/autoscaler/runaway-detector';

describe('RunawayDetector', () => {
  describe('with default config (6 starts / 2 min / 15 min pause)', () => {
    it('allows the first 6 starts in rapid succession', () => {
      const det = new RunawayDetector();
      for (let i = 0; i < 6; i++) {
        expect(det.recordDeployStart('runpod')).toBe(true);
      }
    });

    it('refuses the 7th start and pauses the provider', () => {
      const det = new RunawayDetector();
      for (let i = 0; i < 6; i++) det.recordDeployStart('runpod');
      expect(det.recordDeployStart('runpod')).toBe(false);
      expect(det.isPaused('runpod')).toBe(true);
    });

    it('fires onPause listener on the 7th start with the right metadata', () => {
      const events: Array<{ provider: string; startCount: number }> = [];
      const det = new RunawayDetector();
      det.onPause(e => events.push({ provider: e.provider, startCount: e.startCount }));
      for (let i = 0; i < 6; i++) det.recordDeployStart('runpod');
      expect(events).toHaveLength(0);
      det.recordDeployStart('runpod'); // triggers the pause
      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('runpod');
      expect(events[0].startCount).toBe(7);
    });
  });

  describe('window expiry', () => {
    it('allows new starts after the window has rolled off', () => {
      let now = 1000;
      const det = new RunawayDetector({
        maxStarts: 3,
        windowMs: 60_000,
        pauseMs: 60_000,
        now: () => now,
      });

      // Fill the window
      expect(det.recordDeployStart('vast')).toBe(true); // t=1000
      expect(det.recordDeployStart('vast')).toBe(true); // t=1000
      expect(det.recordDeployStart('vast')).toBe(true); // t=1000
      // 4th within the window — runaway trip
      expect(det.recordDeployStart('vast')).toBe(false);
      expect(det.isPaused('vast')).toBe(true);

      // Advance well past both the pause AND the window
      now += 60_000 + 60_000 + 1;
      // Pause expired — new starts should be allowed
      expect(det.isPaused('vast')).toBe(false);
      expect(det.recordDeployStart('vast')).toBe(true);
    });

    it('allows a slow-paced stream that stays under the threshold', () => {
      let now = 1000;
      const det = new RunawayDetector({
        maxStarts: 3,
        windowMs: 10_000,
        pauseMs: 60_000,
        now: () => now,
      });

      // 1 start per 5 seconds → only 2 in any 10s window
      for (let i = 0; i < 20; i++) {
        expect(det.recordDeployStart('runpod')).toBe(true);
        now += 5_000;
      }
      expect(det.isPaused('runpod')).toBe(false);
    });
  });

  describe('provider isolation', () => {
    it('pauses one provider without affecting another', () => {
      const det = new RunawayDetector({ maxStarts: 2, windowMs: 60_000 });
      det.recordDeployStart('runpod');
      det.recordDeployStart('runpod');
      det.recordDeployStart('runpod'); // 3rd trips the pause
      expect(det.isPaused('runpod')).toBe(true);
      expect(det.isPaused('vast')).toBe(false);
      // Vast is unaffected
      expect(det.recordDeployStart('vast')).toBe(true);
    });
  });

  describe('pause lifecycle', () => {
    it('isPaused clears automatically after the pause TTL', () => {
      let now = 1000;
      const det = new RunawayDetector({
        maxStarts: 1,
        windowMs: 60_000,
        pauseMs: 5_000,
        now: () => now,
      });
      det.recordDeployStart('runpod');
      det.recordDeployStart('runpod'); // trips
      expect(det.isPaused('runpod')).toBe(true);
      now += 5_001;
      expect(det.isPaused('runpod')).toBe(false);
    });

    it('manual pause() blocks without firing on a burst', () => {
      const det = new RunawayDetector();
      det.pause('modal', 'manual test', 60_000);
      expect(det.isPaused('modal')).toBe(true);
      expect(det.recordDeployStart('modal')).toBe(false);
    });

    it('manual clear() lifts both auto and manual pauses', () => {
      const det = new RunawayDetector({ maxStarts: 1, windowMs: 60_000 });
      det.recordDeployStart('runpod');
      det.recordDeployStart('runpod'); // trips
      expect(det.isPaused('runpod')).toBe(true);
      det.clear('runpod');
      expect(det.isPaused('runpod')).toBe(false);
      expect(det.recordDeployStart('runpod')).toBe(true);
    });
  });

  describe('observability', () => {
    it('stats reports recent starts and pause state', () => {
      let now = 1000;
      const det = new RunawayDetector({
        maxStarts: 5,
        windowMs: 60_000,
        now: () => now,
      });
      det.recordDeployStart('runpod');
      det.recordDeployStart('runpod');

      const s = det.stats('runpod');
      expect(s.recentStarts).toBe(2);
      expect(s.paused).toBe(false);
    });

    it('stats reports zero for unknown providers', () => {
      const det = new RunawayDetector();
      const s = det.stats('nonexistent');
      expect(s.recentStarts).toBe(0);
      expect(s.paused).toBe(false);
    });
  });

  describe('the 2026-03-25 scenario', () => {
    it('catches a rapid create/destroy loop within 6 attempts', () => {
      // Simulate the actual loop: deploy_started fires every ~10 seconds as
      // a pod creates, fails, terminates, retries.
      let now = 1_000_000;
      const det = new RunawayDetector({
        now: () => now,
        // Use defaults: 6 starts in 2 min
      });
      const listener = vi.fn();
      det.onPause(listener);

      // First 6 attempts — detector allows, records window
      for (let i = 0; i < 6; i++) {
        expect(det.recordDeployStart('runpod')).toBe(true);
        now += 10_000; // 10s between loop iterations
      }
      // The 7th attempt lands 60s into the window (6 × 10s) — still
      // within the 2min window, so the detector should pause.
      expect(det.recordDeployStart('runpod')).toBe(false);
      expect(listener).toHaveBeenCalledOnce();

      // Within 60 seconds of the loop starting, we've caught it. Had it
      // run at $0.40/hr spot price for 60 seconds across 7 pods, that's
      // roughly $0.05 — we stopped it before $130 accumulated.
    });
  });
});
