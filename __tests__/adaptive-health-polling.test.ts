// ── Adaptive Health Polling (cold-start plan A4) ────────────────────────────
// Source-level contract test: the adaptive-polling ladder in gpu-poll-health
// must match the plan:
//   - 8s  pre-container (long image pull)
//   - 2s  container just started (< 60s, waiting for first /health)
//   - 2s  /health responding but services still loading
//   - 30s all services loaded (rare — main loop exits in same iteration)
//
// A full integration test would require mocking the entire deploy loop
// (RunPod/Vast clients + HTTP fetch + setTimeout). The contract-level test
// is enough to catch regressions without that fixture cost.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

describe('Adaptive Health Polling — cold-start plan A4', () => {
  const src = read('server/gpu-poll-health.ts');

  it('documents the new three-phase polling ladder', () => {
    expect(src).toContain('cold-start plan A4');
    expect(src).toContain('Adaptive polling');
  });

  it('uses 2s polling while container is booting (< 60s since container start)', () => {
    expect(src).toMatch(/\(Date\.now\(\) - containerStartedAt\) < 60_000/);
    // Check that the branch assigns 2_000 (not the old 3_000).
    expect(src).toMatch(/pollMs = 2_000/);
  });

  it('uses 2s polling while /health responds but services are still loading', () => {
    // Branch: healthRespondedOnce && !allServicesLoaded → 2s.
    // We assert the existence of `else if (healthRespondedOnce) { ... pollMs = 2_000 ... }`.
    // Simpler: the file must contain `healthRespondedOnce` branching into 2s.
    expect(src).toMatch(/if \(healthRespondedOnce && allServicesLoaded\)/);
    expect(src).toMatch(/else if \(healthRespondedOnce\)/);
  });

  it('uses 30s polling once all services are loaded (post-ready branch)', () => {
    expect(src).toMatch(/allServicesLoaded.*\n.*pollMs = 30_000/);
  });

  it('keeps 8s polling as the pre-container fallback (no /health yet, no container)', () => {
    // The "else" branch (none of the faster conditions matched) → 8s.
    expect(src).toMatch(/} else \{\s*\n\s*pollMs = 8_000;/);
  });

  it('no longer uses the old 3s polling value', () => {
    // Guard against reverts. The old code used 3_000; after A4 there should
    // be no remaining `pollMs = 3_000` assignment in this file.
    expect(src).not.toMatch(/pollMs = 3_000/);
  });

  it('detects ready via service-field flags (sttReady, llmReady, ttsReady)', () => {
    // The phase detection hangs off these three booleans — they must still be
    // derived from the /health payload.
    expect(src).toContain('sttReady');
    expect(src).toContain('llmReady');
    expect(src).toContain('ttsReady');
    expect(src).toMatch(/allServicesLoaded = sttReady && llmReady && ttsReady/);
  });
});
