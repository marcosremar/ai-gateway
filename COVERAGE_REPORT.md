# AI Gateway Test Coverage Analysis

## Summary Statistics
- Total source files: 107
- Total test files: 58
- Overall coverage estimate: ~54%

## Module Breakdown

### 1. AUTOSCALER MODULE (18 files)
Files: boot-timeout.ts, cleanup.ts, config-loader.ts, cost-monitor.ts, decision-builder.ts, engine.ts, 
        health-checker.ts, health.ts, latency-tracker.ts, lifecycle-logger.ts, load-balancer.ts, 
        predictive-warmup.ts, reconcile.ts, session-tracker.ts, state-persistence.ts, tier-lifecycle.ts, 
        watchdog.ts, index.ts

Test Files (9): 
- autoscaler-boot-timeout.test.ts ✓ (boot-timeout.ts)
- autoscaler-cleanup.test.ts ✓ (cleanup.ts)
- autoscaler-cost-monitor.test.ts ✓ (cost-monitor.ts)
- autoscaler-decision-builder.test.ts ✓ (decision-builder.ts)
- autoscaler-latency-tracker.test.ts ✓ (latency-tracker.ts)
- autoscaler-tier-lifecycle.test.ts ✓ (tier-lifecycle.ts)
- autoscaler-watchdog.test.ts ✓ (watchdog.ts)
- health.test.ts ✓ (health.ts)
- load-balancer.test.ts ✓ (load-balancer.ts)

**Coverage: 9/18 = 50%**

### 2. PROVIDERS MODULE (31 files)
Subdirs: openai/ (5), openai-compat/ (4), groq/ (2), fireworks/ (3), openrouter/ (3), modal/ (1), 
         self-hosted/ (1), plus: fallback.ts, declarative-chain.ts, chain-builder.ts, errors.ts, 
         credit-block.ts, registry.ts, types.ts, classification.ts, voice-catalog.ts, index.ts

Test Files (12):
- openai-integration.test.ts ✓ (openai/*, openai-compat/*)
- openai-compat/openai-compat-llm.ts, openai-stt.ts, openai-tts.ts
- groq-integration.test.ts ✓ (groq/*)
- fireworks-integration.test.ts ✓ (fireworks/*)
- openrouter-integration.test.ts ✓ (openrouter/*)
- modal-tts-integration.test.ts ✓ (modal/*)
- fallback-integration.test.ts ✓ (fallback.ts)
- cross-provider-integration.test.ts ✓ (multi-provider)
- ai-provider-registry.test.ts ✓ (registry.ts)
- voice-catalog.test.ts ✓ (voice-catalog.ts)
- autoscaler-credit-block.test.ts ✓ (credit-block.ts)

**Coverage: 12/31 = 39%**

### 3. BROWSER MODULE (11 files)
Files: audio.ts, emitter.ts, errors.ts, index.ts, logger.ts, speech-client.ts, streaming-audio.ts, 
        transport-sse.ts, transport-webrtc.ts, transport-ws.ts, types.ts

Test Files (4):
- browser-transports.test.ts ✓ (transport-ws.ts, transport-sse.ts)
- browser-transport-sse-full.test.ts ✓ (transport-sse.ts)
- ai-gateway-integration.test.ts ✓ (speech-client.ts, emitter.ts)
- backend-transports.test.ts ✓ (transports)

**Coverage: 4/11 = 36%**

### 4. CLIENT MODULE (6 files)
Files: ai-client.ts, gpu-transport.ts, index.ts, pipeline-events.ts, presets.ts, types.ts

Test Files (3):
- ai-client.test.ts ✓ (ai-client.ts)
- client-presets.test.ts ✓ (presets.ts)
- ai-gateway-integration.test.ts ✓ (ai-client.ts)

**Coverage: 3/6 = 50%**

### 5. GPU-PROVIDERS MODULE (9 files)
Files: abstract-provider.ts, index.ts, modal-client.ts, registry.ts, runpod-client.ts, 
        tensordock-client.ts, tensordock-cloud-init.ts, types.ts, vast-client.ts

Test Files (10):
- gpu-provider-runpod.test.ts ✓ (runpod-client.ts)
- gpu-provider-tensordock.test.ts ✓ (tensordock-client.ts)
- gpu-provider-vast.test.ts ✓ (vast-client.ts)
- gpu-provider-modal.test.ts ✓ (modal-client.ts)
- gpu-provider-registry.test.ts ✓ (registry.ts)
- gpu-providers.test.ts ✓ (health.ts, load-balancer.ts, types.ts)
- abstract-provider.test.ts ✓ (abstract-provider.ts)
- runpod-real-api.test.ts ✓ (runpod-client.ts)
- vast-real-api.test.ts ✓ (vast-client.ts)
- runpod-lifecycle.test.ts ✓ (runpod-client.ts)

**Coverage: 10/9 = 111%** (some files have multiple test files)

### 6. HANDLERS MODULE (6 files)
Files: autoscaler-handler.ts, autoscaler-schemas.ts, credential-resolver.ts, index.ts, 
        modal-handler.ts, types.ts

Test Files (3):
- autoscaler-handler.test.ts ✓ (autoscaler-handler.ts, autoscaler-schemas.ts)
- handler-types.test.ts ✓ (types.ts)
- modal-handler.test.ts ✓ (modal-handler.ts)

**Coverage: 3/6 = 50%**

### 7. ADAPTERS MODULE (3 files)
Files: in-memory-state.ts, index.ts, redis-state.ts

Test Files (1):
- adapters-integration.test.ts ✓ (all adapters)

**Coverage: 1/3 = 33%**

### 8. AUTH MODULE (2 files)
Files: gpu-token.ts, index.ts

Test Files (1):
- auth-integration.test.ts ✓ (gpu-token.ts)

**Coverage: 1/2 = 50%**

### 9. TRACKING MODULE (5 files)
Files: benchmark-tracker.ts, cost-anomaly-detector.ts, index.ts, pricing.ts, spend-tracker.ts

Test Files (2):
- benchmark-tracker.test.ts ✓ (benchmark-tracker.ts)
- cost-anomaly-detector.test.ts ✓ (cost-anomaly-detector.ts)

**Coverage: 2/5 = 40%**

### 10. BENCHMARKING MODULE (4 files)
Files: bench.ts, cli-bench.ts, index.ts, ws-bench-client.ts

Test Files (0):

**Coverage: 0/4 = 0%**

### 11. INFRA MODULE (2 files)
Files: gpu-backend.ts, index.ts

Test Files (0):

**Coverage: 0/2 = 0%**

### 12. ROOT-LEVEL FILES (6 files)
Files: create-gateway.ts, factory.ts, gateway.ts, gateway-api.ts, deps.ts, storage.ts, 
        hooks.ts, types.ts, index.ts, logger.ts

Test Files (4):
- create-gateway.test.ts ✓ (create-gateway.ts)
- create-gateway-e2e.test.ts ✓ (create-gateway.ts, gateway.ts)
- ai-gateway-integration.test.ts ✓ (gateway.ts, create-gateway.ts)
- gpu-providers.test.ts ✓ (hooks.ts)

**Coverage: 4/10 = 40%**

---

## Files WITHOUT Tests (Priority Order)

### HIGH PRIORITY (Core Logic)
1. src/autoscaler/engine.ts - Main autoscaler orchestration (AutoscalerEngine class)
2. src/autoscaler/config-loader.ts - Configuration validation & loading
3. src/autoscaler/state-persistence.ts - State save/restore logic
4. src/autoscaler/reconcile.ts - Periodic state reconciliation
5. src/autoscaler/session-tracker.ts - Active session tracking
6. src/autoscaler/predictive-warmup.ts - ML-based usage prediction
7. src/autoscaler/health-checker.ts - Multi-tier health probe orchestration
8. src/autoscaler/lifecycle-logger.ts - GPU lifecycle event logging

### MEDIUM PRIORITY (Provider Logic)
9. src/providers/chain-builder.ts - Chain resolution from user settings
10. src/providers/classification.ts - Classification provider wrapper
11. src/providers/openai/openai-realtime.ts - Realtime audio API
12. src/providers/openai/openai-omni.ts - Omni model (text+audio)
13. src/providers/openai/openai-image.ts - DALL-E image generation
14. src/providers/self-hosted/self-hosted-provider.ts - Generic HTTP backend
15. src/providers/openai-compat/audio-utils.ts - Audio processing utilities
16. src/providers/openai-compat/openai-compat-llm.ts (may need more coverage)
17. src/providers/openai-compat/index.ts - Exports
18. src/providers/fireworks/fireworks-image.ts - Flux image generation
19. src/providers/groq/models.ts - Model definitions
20. src/providers/openrouter/models.ts - Model definitions
21. src/providers/modal/index.ts - Modal integration (edge case: TTS only)

### MEDIUM PRIORITY (Browser/Client)
22. src/browser/audio.ts - Audio utility functions
23. src/browser/streaming-audio.ts - Streaming audio processing
24. src/browser/transport-webrtc.ts - WebRTC transport
25. src/browser/logger.ts - Browser-side logging

### MEDIUM PRIORITY (Other)
26. src/client/gpu-transport.ts - GPU backend transport
27. src/client/pipeline-events.ts - Pipeline event orchestration
28. src/handlers/credential-resolver.ts - Credential resolution logic
29. src/handlers/autoscaler-schemas.ts (may need more coverage)
30. src/handlers/index.ts - Handler exports
31. src/tracking/pricing.ts - Pricing calculation
32. src/tracking/spend-tracker.ts - Spend tracking logic
33. src/tracking/index.ts - Exports

### CRITICAL GAPS (Zero Coverage)
34. src/benchmarking/bench.ts - Health checks, SSE/WS bench
35. src/benchmarking/cli-bench.ts - CLI benchmarking
36. src/benchmarking/ws-bench-client.ts - WebSocket bench client
37. src/benchmarking/index.ts - Exports
38. src/infra/gpu-backend.ts - SkyPilot/SSH/SCP utilities
39. src/infra/index.ts - Exports

### ROOT LEVEL
40. src/factory.ts - Advanced autoscaler factory
41. src/gateway.ts - Singleton gateway pattern (may have some coverage)
42. src/gateway-api.ts - Gateway API types
43. src/storage.ts - GatewayStorage interface
44. src/deps.ts - Dependency injection interfaces
45. src/logger.ts - Logging utilities

---

## Partial Coverage Analysis

### Files with Tests But Limited Coverage

1. **src/autoscaler/load-balancer.ts**
   - Tests: load-balancer.test.ts, load-balancer-integration.test.ts, load-balancer-real.test.ts
   - Status: GOOD (3 comprehensive test files)

2. **src/autoscaler/latency-tracker.ts**
   - Tests: autoscaler-latency-tracker.test.ts
   - Missing: edge cases, P95 calculation edge cases, breach counting logic

3. **src/providers/fallback.ts**
   - Tests: fallback-integration.test.ts
   - Status: GOOD (fallback with cooldown covered)

4. **src/providers/registry.ts**
   - Tests: ai-provider-registry.test.ts
   - Status: GOOD (provider registration covered)

5. **src/handlers/autoscaler-handler.ts**
   - Tests: autoscaler-handler.test.ts
   - Missing: credential resolution flow, error cases

6. **src/tracking/cost-anomaly-detector.ts**
   - Tests: cost-anomaly-detector.test.ts
   - Status: GOOD (anomaly detection logic covered)

7. **src/handlers/types.ts**
   - Tests: handler-types.test.ts
   - Status: GOOD (type validation covered)

---

## Recommendations

### Phase 1: Critical Path Testing (Highest ROI)
1. Test AutoscalerEngine (src/autoscaler/engine.ts) - Core logic
2. Test config-loader (src/autoscaler/config-loader.ts) - Configuration validation
3. Test state-persistence (src/autoscaler/state-persistence.ts) - Data integrity
4. Test health-checker (src/autoscaler/health-checker.ts) - Health probing

### Phase 2: Provider Coverage
1. Test openai-realtime.ts (new Realtime API)
2. Test openai-omni.ts (text+audio)
3. Test openai-image.ts (DALL-E)
4. Test chain-builder.ts (fallback logic)

### Phase 3: Browser/Client SDK
1. Test browser transports (WebRTC especially)
2. Test client GPU transport
3. Test pipeline event orchestration

### Phase 4: Infrastructure
1. Complete benchmarking module tests (4 files)
2. Complete infra module tests (2 files)
3. Test root-level gateway.ts, factory.ts, storage.ts

### Phase 5: Edge Cases & Integration
1. Add E2E tests for critical autoscaler flows
2. Add stress tests for load-balancer
3. Add real API integration tests for new providers

