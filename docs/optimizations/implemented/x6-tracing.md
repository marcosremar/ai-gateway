# x6 — Cross-Ownership Harvest: Distributed Tracing / OTLP / OTel / Langfuse

**Cluster:** `src/platform/observability/**`, `src/platform/` (tracing / otel /
langfuse / console-hooks / webhook-hooks / merge-hooks).

**Context:** the domain-6 (observability) audit
(`docs/optimizations/06-observability-cost.md`, IDs 501-600) explicitly deferred
every `src/platform/observability/**` item as *out of ownership* — see the audit
header and `implemented/06-observability-w5.md`. This wave harvests the SAFE,
LOCALIZED ones from that deferred set, each with a unit test.

**Test:** `__tests__/opt/x6-tracing.test.ts` — 27 tests, unit-only (mocked
`fetch`, in-memory spans, injected options). Run:

```
bunx vitest run --config vitest.opt.config.ts __tests__/opt/x6-tracing.test.ts
```

Result: **27 passed**. Back-compat verified against the existing module tests
(`__tests__/unit/{distributed-tracer,otlp-exporter,otel,observability-langfuse,
bug-tracer-p95-offbyone}.test.ts` + `__tests__/{distributed-tracer,
observability-langfuse,observability}.test.ts`): **121 + 14 passed**, and all
`__tests__/opt/06-observability*` (**117 passed**) — no regressions.

## Implemented

| ID | File | Change |
|----|------|--------|
| #512 | `distributed-tracer.ts` | `analyzeBottlenecks` now derives `slowestStage`/`slowestProvider` by averaging `stage.latency_ms` per `stage.name`/`stage.provider` across recent stage spans, instead of returning the hardcoded `'pipeline'`/`'gpu'` literals. Also fixed the span filter from truthy `duration_ms` to `!== undefined` so 0ms (fast/synchronous) ended spans are no longer silently dropped (the function previously returned all-zero / 'none' on a fast pipeline). |
| #521 | `distributed-tracer.ts` | `runRealtimeBenchmark` no longer persists synthetic `simulateRequestLatency()` values as `benchmark_request` spans by default — they polluted `analyzeBottlenecks`/`getRealtimeMetrics` which read the same ring. New opt-in `{ persistSpans: true }` 3rd arg for explicit benchmark sessions. |
| #565 | `distributed-tracer.ts`, `types.ts` | Added optional `inputTokens`/`outputTokens`/`costUsd` to `StageMetrics`; `tracePipeline` stamps `stage.input_tokens`/`stage.output_tokens`/`stage.cost_usd` on each stage span and rolls the per-stage cost sum up to the parent as `cost.stages_usd`. Enables per-trace cost attribution in Tempo/Jaeger. Tags omitted when not supplied (back-compat). |
| #566 | `distributed-tracer.ts` | Span eviction at the 5000 cap now prefers the oldest *ended* span (one with `duration_ms` set) over a still-open span, so a long-running parent inserted first is no longer dropped while its children are still arriving (orphaning). Falls back to plain FIFO only if every retained span is open, keeping the bound hard. |
| #567 | `otlp-exporter.ts` | `flush` re-queues transient failures (HTTP 5xx/429 and network throws) — the batch stays in `pending` for the next flush instead of being discarded. Permanent failures (4xx, serialize errors) are dropped (DLQ). New `requeued` counter in `stats()`; `failed` still increments on every failure (back-compat). |
| #568 | `otlp-exporter.ts` | `flush` is now copy-then-confirm: spans are removed from `pending` only after a 2xx ACK (or a permanent-failure drop), not spliced out before the POST. Serialization (`buildPayload`/`JSON.stringify`) is wrapped so a throw can't make the batch unrecoverable. |
| #569 | `otlp-exporter.ts` | `pending` buffer is bounded by `maxPending` (default `maxBatchSize * 50`). On overflow, oldest spans are dropped and counted in the new `dropped` stat — prevents unbounded memory growth when the collector is down. |
| #570 | `otel.ts` | `withSpan` no longer logs a per-span completion line on every span (one line per stage per request = high log volume/cost). Gated behind `OtelConfig.logSpans` / `OTEL_LOG_SPANS=1` (off by default). |
| #571 | `otel.ts` | `completedSpans` array is now bounded (`MAX_COMPLETED_SPANS = 5000`, mirroring `DistributedTracer`) instead of growing one span per request forever. Added `getCompletedSpanCount()` + `_resetOtelSpansForTests()`. |
| #575 | `otlp-exporter.ts` | `initOtlpFromEnv` validates the endpoint is a well-formed `http(s)` URL (new exported `isValidHttpUrl`); a typo'd endpoint is refused at init with a loud warning instead of starting an exporter that fails every flush forever. |
| #600 | `langfuse-hooks.ts` | New exported `langfuseTraceId(event)` derives a STABLE trace id from the `(userId, stage, provider)` tuple shared by `RequestStartEvent`/`RequestEndEvent`. Both `onRequestStart` (trace `body.id`) and `onRequestEnd` (`span.traceId`) now use it, so spans attach to their trace — the old `trace-${timestamp}-redacted` id never matched the start id. |
| (+) | `otlp-exporter.ts` | Hardening tied to the OTLP wiring (#567/#572 family): `attachExporterToTracer` is now idempotent — repeated calls no longer stack `endSpan` wrappers (which double-enqueued every span). Tagged via a marker flag. |

## Deferred (with reasons)

| ID | File | Reason |
|----|------|--------|
| #564 | `distributed-tracer.ts` | "Spans end synchronously, durations ~0ms." A real fix means restructuring `tracePipeline` to stamp `startTime`/duration from the supplied metrics' real wall-clock timestamps — but `PipelineMetrics` carries only `latencyMs` per stage, no absolute start timestamps, so the fix needs a richer input contract (cross-cutting). Partially mitigated here: #512's filter fix stops 0ms spans from being silently excluded. |
| #572 | `otel.ts` / `otlp-exporter.ts` | "In-memory OTel (`withSpan`) never exports despite OTLP config; the two tracing systems are disconnected." Unifying `otel.ts` spans with the `DistributedTracer`/OTLP pipeline is an architectural change (span-model bridge, dedup, ADR-worthy) — not safe/localized. |
| #573 | `otel.ts` | "`getCurrentSpan` returns the most-recently-created span — wrong under concurrency." The correct fix is `AsyncLocalStorage`-based context propagation threaded through `withSpan`/`createSpan` and every call site — invasive and behavior-changing. Deferred rather than ship a fake fix. |
| #574 | `distributed-tracer.ts` | Documentation-only ("document that `analyzeBottlenecks(sinceMs)` filters by age"). No code/test value; the behavior is already correct. |
| #582/#583 | `src/events/hooks.ts`, `merge-hooks.ts` | Hook-failure counters (#582) were already implemented in a prior wave (`getHookErrorCount` in `src/events/hooks.ts`, outside cluster). Per-hook timeout/isolation (#583) for `mergeHooks` changes fire-and-forget semantics (adds timers/races to the hot path) — needs a design decision; deferred. |

## Cluster note

The cluster had a healthy amount of safe work: the `src/platform/observability/**`
tracing/OTLP/OTel/Langfuse files were entirely untouched by domain-6 (deferred as
out-of-ownership), so 11 numbered audit items + 1 hardening were landed. The
remaining deferred items (#564, #572, #573, #583) are genuinely
architectural/cross-cutting, not "safe localized" work.
