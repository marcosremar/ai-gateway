# AI Gateway Test Coverage — Priority Action Plan

## Executive Summary

**Current Status:** 54% module coverage (58 test files for 107 source files)

**Breakdown:**
- **Excellent Coverage:** GPU Providers (111%), Autoscaler (50% but with key files), Client (50%)
- **Good Coverage:** Handlers (50%), Auth (50%), Root-level (40%)
- **Weak Coverage:** Browser (36%), Adapters (33%), Providers (39%), Tracking (40%)
- **Critical Gaps:** Benchmarking (0%), Infra (0%)

---

## CRITICAL PRIORITY: Files Without Tests (49 files)

### PHASE 1: Core Autoscaler Logic (4-6 weeks, HIGH ROI)

**Impact:** These are the heart of the system. Missing tests on these can cause production issues.

```
src/autoscaler/engine.ts ★★★
  - Class: AutoscalerEngine
  - Methods: boot(), start(), stop(), handleAction(), reconcile()
  - Tests needed: Unit tests + integration tests with mocked storage/health probes
  - Estimated LOC: 500+
  - Priority: CRITICAL (core orchestration logic)

src/autoscaler/config-loader.ts ★★★
  - Function: loadAndValidateConfig()
  - Tests needed: Valid configs, invalid configs, schema validation, Zod error handling
  - Estimated LOC: 200+
  - Priority: CRITICAL (config validation)

src/autoscaler/state-persistence.ts ★★★
  - Class: StatePersistence
  - Methods: saveState(), restoreState(), patchState()
  - Tests needed: Unit tests with mocked Redis/Memory adapters
  - Estimated LOC: 300+
  - Priority: CRITICAL (data integrity)

src/autoscaler/health-checker.ts ★★
  - Function: processHealthResults(), parallel health checks
  - Tests needed: Multi-tier health orchestration, timeout handling
  - Estimated LOC: 250+
  - Priority: HIGH (health probing)
```

**Action Items:**
1. Create `autoscaler-engine.test.ts` (unit tests for AutoscalerEngine)
2. Create `autoscaler-config-loader.test.ts` (schema validation)
3. Create `autoscaler-state-persistence.test.ts` (Redis/memory adapters)
4. Create `autoscaler-health-checker.test.ts` (multi-tier health probes)

**Estimated Time:** 2-3 weeks
**Expected Coverage Gain:** +22% for autoscaler module (from 50% to 72%)

---

### PHASE 2: Autoscaler Remaining Logic (2-3 weeks, MEDIUM ROI)

```
src/autoscaler/session-tracker.ts
  - Class: SessionTracker
  - Methods: incrementSessions(), decrementSessions(), count()
  - Tests: Normal flow, concurrent access edge cases

src/autoscaler/predictive-warmup.ts
  - Function: startPredictiveWarmupTicker()
  - Tests: ML-based warmup prediction, timing, edge cases

src/autoscaler/reconcile.ts
  - Function: scheduleReconcile()
  - Tests: Periodic reconciliation, state sync

src/autoscaler/lifecycle-logger.ts
  - Interface: GpuLifecycleLogger
  - Tests: Event logging, noop logger
```

**Action Items:**
1. Create `autoscaler-session-tracker.test.ts`
2. Create `autoscaler-predictive-warmup.test.ts`
3. Create `autoscaler-reconcile.test.ts`
4. Create `autoscaler-lifecycle-logger.test.ts`

**Estimated Time:** 1-2 weeks
**Expected Coverage Gain:** +50% for remaining autoscaler files (from 50% to 100%)

---

### PHASE 3: Provider Module Coverage (3-4 weeks, MEDIUM ROI)

**High Priority:**
```
src/providers/openai/openai-realtime.ts ★★★
  - New Realtime Audio API
  - Tests: Connection, message flow, disconnection handling
  - Estimated LOC: 400+

src/providers/openai/openai-omni.ts ★★★
  - Text + Audio output
  - Tests: Streaming audio, format handling

src/providers/openai/openai-image.ts ★★
  - DALL-E generation
  - Tests: Image generation, format validation

src/providers/chain-builder.ts ★★
  - Chain resolution logic
  - Tests: Chain building, fallback logic
```

**Medium Priority:**
```
src/providers/openai-compat/audio-utils.ts
  - Audio processing utilities

src/providers/openai-compat/openai-compat-stt.ts
  - STT base class

src/providers/openai-compat/openai-compat-tts.ts
  - TTS base class

src/providers/self-hosted/self-hosted-provider.ts
  - Generic HTTP backend

src/providers/classification.ts
  - Classification provider
```

**Low Priority (Model Definitions):**
```
src/providers/groq/models.ts
src/providers/openrouter/models.ts
src/providers/fireworks/models.ts
src/providers/openrouter/openrouter-image.ts
src/providers/fireworks/fireworks-image.ts
```

**Action Items:**
1. Create `openai-realtime-integration.test.ts` (new)
2. Create `openai-omni-integration.test.ts` (new)
3. Create `openai-image-integration.test.ts` (new)
4. Create `chain-builder.test.ts` (new)
5. Create `self-hosted-provider.test.ts` (new)
6. Extend `openai-compat-integration.test.ts` for audio-utils
7. Add model definition validation tests

**Estimated Time:** 2-3 weeks
**Expected Coverage Gain:** +30% for providers (from 39% to 69%)

---

### PHASE 4: Browser/Client Module (2-3 weeks, MEDIUM ROI)

```
src/browser/transport-webrtc.ts ★★★
  - WebRTC transport layer
  - Tests: Connection setup, media streaming, error handling
  - HIGH PRIORITY — new SDK feature

src/browser/audio.ts ★
  - Audio utility functions
  - Tests: Audio format conversion, normalization

src/browser/streaming-audio.ts ★
  - Streaming audio processing
  - Tests: Chunking, buffering

src/browser/logger.ts
  - Browser-side logging
  - Tests: Log levels, formatting

src/client/gpu-transport.ts ★★
  - GPU backend transport
  - Tests: Communication with GPU backend

src/client/pipeline-events.ts ★★
  - Pipeline event orchestration
  - Tests: Event flow, error handling
```

**Action Items:**
1. Create `browser-transport-webrtc.test.ts` (CRITICAL)
2. Create `browser-audio.test.ts` (new)
3. Create `browser-streaming-audio.test.ts` (new)
4. Create `client-gpu-transport.test.ts` (new)
5. Create `client-pipeline-events.test.ts` (new)

**Estimated Time:** 2 weeks
**Expected Coverage Gain:** +40% for browser (from 36% to 76%), +33% for client (from 50% to 83%)

---

### PHASE 5: Critical Gaps (1-2 weeks, ESSENTIAL)

```
src/benchmarking/bench.ts ★★
  - Health checks, SSE/WS benchmarking
  - Tests: Benchmark execution, result aggregation
  - CURRENTLY: 0% COVERAGE

src/benchmarking/cli-bench.ts
  - CLI benchmarking interface
  - Tests: CLI parsing, output formatting

src/benchmarking/ws-bench-client.ts
  - WebSocket bench client
  - Tests: WS connection, benchmark protocol

src/infra/gpu-backend.ts ★★
  - SkyPilot/SSH/SCP utilities
  - Tests: Command execution, error handling
  - CURRENTLY: 0% COVERAGE
```

**Action Items:**
1. Create `benchmarking-bench.test.ts` (CRITICAL)
2. Create `benchmarking-cli.test.ts` (new)
3. Create `benchmarking-ws-client.test.ts` (new)
4. Create `infra-gpu-backend.test.ts` (CRITICAL)

**Estimated Time:** 1-2 weeks
**Expected Coverage Gain:** +100% for benchmarking (0% to 100%), +100% for infra (0% to 100%)

---

### PHASE 6: Handler & Root-Level (1-2 weeks, MEDIUM ROI)

```
src/handlers/credential-resolver.ts
  - Credential resolution logic
  - Tests: Credential lookup, validation

src/handlers/autoscaler-schemas.ts
  - Schema validation
  - Tests: Schema validation edge cases

src/factory.ts
  - Advanced autoscaler factory
  - Tests: Factory creation, dependency injection

src/gateway.ts (may already have coverage)
  - Singleton gateway pattern
  - Tests: Gateway lifecycle

src/storage.ts
  - GatewayStorage interface
  - Tests: Interface compliance

src/deps.ts
  - DI interfaces
  - Tests: Interface validation

src/types.ts
  - Core type definitions
  - Tests: Type guard functions

src/gateway-api.ts
  - Gateway API types
  - Tests: Type validation

src/logger.ts
  - Logging utilities
  - Tests: Logger formatting, levels
```

**Action Items:**
1. Create `handlers-credential-resolver.test.ts`
2. Enhance `handlers-schemas.test.ts` with more edge cases
3. Create `factory.test.ts`
4. Create `gateway-storage.test.ts`
5. Create `core-types.test.ts` for types.ts

**Estimated Time:** 1-2 weeks
**Expected Coverage Gain:** +25% for handlers/root-level

---

### PHASE 7: Tracking & Other Modules (1 week, LOW ROI)

```
src/tracking/pricing.ts
  - Pricing calculations
  - Tests: Calculation correctness

src/tracking/spend-tracker.ts
  - Spend tracking
  - Tests: Accumulation logic

src/adapters/redis-state.ts (partial coverage)
  - Redis adapter specific tests
  - Tests: Redis operations, error handling
```

**Action Items:**
1. Create `tracking-pricing.test.ts`
2. Create `tracking-spend-tracker.test.ts`
3. Enhance `adapters-integration.test.ts` with Redis-specific tests

**Estimated Time:** 1 week
**Expected Coverage Gain:** +40% for tracking (40% to 80%), +33% for adapters (33% to 66%)

---

## Test Coverage Timeline & Roadmap

### Quick Wins (1-2 weeks)
```
Priority: CRITICAL
Files: 4
Effort: Low
ROI: High

1. autoscaler-engine.test.ts
2. autoscaler-config-loader.test.ts
3. benchmarking-bench.test.ts
4. infra-gpu-backend.test.ts

Expected Result: 54% → 65% overall coverage
```

### Phase 1 Complete (4-6 weeks from start)
```
Priority: HIGH
Files: 12
Effort: Medium-High
ROI: Very High

Adds comprehensive autoscaler & core logic testing
Expected Result: 54% → 72% overall coverage
```

### Phase 2 Complete (6-9 weeks from start)
```
Priority: MEDIUM-HIGH
Files: 24
Effort: High
ROI: High

Adds provider integrations, browser SDK, client logic
Expected Result: 72% → 85% overall coverage
```

### Full Coverage (10-12 weeks from start)
```
Target: 95%+ coverage
Adds: Edge cases, performance tests, E2E tests
```

---

## Testing Best Practices (Applied)

### Unit Tests
- Single module responsibility
- Mocked dependencies
- Focus on business logic
- Edge case coverage

### Integration Tests
- Multi-module interactions
- Real storage adapters (Redis/Memory)
- Provider fallback flows
- End-to-end autoscaler scenarios

### Real API Tests
- Separate test suite
- Only run on CI/CD if credentials available
- Provider-specific edge cases
- Contract compliance verification

### Test Organization
```
__tests__/
├── unit/                          # New directory for unit tests
│   ├── autoscaler-engine.test.ts
│   ├── config-loader.test.ts
│   └── ...
├── integration/                   # New directory for integration tests
│   ├── autoscaler-e2e.test.ts
│   └── ...
├── real-api/                      # Real API tests (skip in CI unless env var)
│   ├── openai-integration.test.ts
│   └── ...
└── [existing test files]
```

---

## Quality Metrics to Track

### Coverage Metrics
- Line coverage target: 80%+
- Branch coverage target: 75%+
- Function coverage target: 85%+
- Statement coverage target: 80%+

### Test Quality Metrics
- Avg test execution time: < 5s
- Flakiness: < 1%
- Maintenance burden: Low (clear test names, good organization)

### Test Hygiene
- No skipped tests (use `.skip` temporarily only)
- No pending tests
- Clear AAA pattern (Arrange, Act, Assert)
- Meaningful assertions

---

## Commands to Run Tests

```bash
# Run all tests
bun run test

# Run unit tests only
bun run test -- __tests__/unit/

# Run integration tests only
bun run test -- __tests__/integration/

# Run specific test
bun run test -- __tests__/autoscaler-engine.test.ts

# Watch mode
bun run test:watch

# Coverage report
bun run test -- --coverage

# Run provider-specific tests
bun run test:openai
bun run test:groq
bun run test:fireworks
bun run test:openrouter
bun run test:modal
```

---

## Success Criteria

### Phase 1 Complete (4-6 weeks)
- [ ] All autoscaler core logic tested
- [ ] Config validation tested
- [ ] State persistence tested
- [ ] Health checking tested
- [ ] Benchmark & infra modules tested
- [ ] Coverage: 54% → 72%

### Phase 2 Complete (9-10 weeks)
- [ ] All providers tested (new OpenAI APIs)
- [ ] Browser/Client tested (especially WebRTC)
- [ ] Handler logic tested
- [ ] Coverage: 72% → 85%

### Phase 3 Complete (12 weeks)
- [ ] Edge cases covered
- [ ] Performance tests added
- [ ] E2E scenarios tested
- [ ] Coverage: 85% → 95%+

