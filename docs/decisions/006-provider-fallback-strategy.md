# ADR-006: Provider Fallback Strategy

**Status:** Accepted
**Date:** 2026-02-15
**Deciders:** Marcos

## Context

AI providers (OpenAI, Groq, Fireworks, etc.) have different reliability, latency, and cost profiles. A single provider can fail due to rate limits, credit exhaustion, or outages. We need automatic failover without client-side changes.

## Decision

**Two-tier fallback strategy:**

1. **Declarative chains** (config-driven, preferred) — Weighted provider lists with cooldown
2. **Programmatic fallback** — `withProviderFallback()` for custom orchestration

```typescript
// Declarative (config)
const chains = [
  { stage: 'stt', entries: [
    { providerId: 'groq-whisper', weight: 1.0 },
    { providerId: 'openai-whisper', weight: 0.5, cooldownMs: 30_000 },
  ]},
];

// Programmatic
await withProviderFallback(
  [groqLLM, openaiLLM, openrouterLLM],
  (p) => p.chat(messages),
  { maxRetries: 2, cooldownMs: 30_000 },
);
```

### Cooldown mechanics

- Failed providers enter cooldown (default 30s)
- Cooldown is tracked per-provider, per-user
- Credit exhaustion is tracked permanently (until manual reset)
- Cooldown state persists in `~/.babelcast/cooldowns.json`

## Consequences

### Positive
- Zero client-side changes on provider failure
- Config-driven — no code changes to reorder providers
- Cost-effective — cheapest providers tried first

### Negative
- Failover adds latency (second provider call)
- Cooldown state is file-based (not distributed)

## Alternatives Considered

1. **Load balancing (round-robin)** — Better for utilization but doesn't handle failures
2. **Health-check based routing** — More accurate but adds polling overhead
3. **Manual provider selection** — Simple but requires client changes on failure

## References

- `src/providers/fallback-chain.ts`
- `CLAUDE.md` (Provider Fallback Pattern section)
