# Contributing to AI Gateway

Thank you for contributing! This guide covers everything you need to know to work effectively on this codebase.

## Quick Links

- [CLAUDE.md](./CLAUDE.md) — Full project overview and feature list
- [docs/domain-model.md](./docs/domain-model.md) — Ubiquitous language and domain model
- [docs/sdd.md](./docs/sdd.md) — Architecture decisions and module responsibilities
- [docs/adr/](./docs/adr/) — Architecture Decision Records

## Getting Started

```bash
# Install dependencies
bun install

# Run all tests
bun test

# Build library
bun run build

# Start dev server
bun run server
```

## Code Conventions

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Functions | `camelCase` | `startTranslationCacheSweep` |
| Variables | `camelCase` | `cooldownTracker` |
| Types/Interfaces/Classes | `PascalCase` | `DeploymentState`, `AIProviderRegistry` |
| Constants | `SCREAMING_SNAKE_CASE` | `IDLE_TIMEOUT_MS`, `MAX_DEPLOY_RETRIES` |
| Enums and values | `PascalCase` | `PipelineStage.Complete` |
| Files | `kebab-case.ts` | `translation-cache.ts`, `gpu-deploy.ts` |

### File Header

Every file should have a header comment with section dividers:

```typescript
// ── BabelCast Gateway — Translation LRU Cache ───────────────────────────────
// Meetings have many repeated phrases ("thank you", "can you hear me?").
// Cache avoids redundant LLM calls for identical text+lang pairs.

import { createLogger } from '../src/logger';
const log = createLogger('translation-cache');

// ── LRU Cache ───────────────────────────────────────────────────────────────
```

### Imports

Group imports with section comments:

```typescript
// External
import { createLogger } from '../src/logger';
import { homedir } from 'os';
import { join } from 'path';

// ── State ───────────────────────────────────────────────────────────────────
import { deployState, setDeployState } from './state';

// ── Providers ────────────────────────────────────────────────────────────────
import { groqSTT, groqTTS, groqLLM } from './groq';
```

Type-only imports use `import type`:

```typescript
import type { GpuProviderClient } from '../src/gpu-providers/types';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
```

### Types and Interfaces

```typescript
// Interface for object shapes
export interface CacheEntry {
  text: string;
  ts: number;
}

// Type alias for unions
export type ProviderId = 'openai' | 'groq' | 'openrouter' | 'fireworks';

// Readonly const objects for configuration groups
export const GPU = {
  MAX_DEPLOY_RETRIES: 2,
  HEALTH_POLL_INTERVAL_MS: 10_000,
  DEPLOY_TIMEOUT_MS: 30 * 60_000,
  IDLE_TIMEOUT_MS: 15 * 60_000,
} as const;
```

### Error Handling

Custom error classes with status codes:

```typescript
export class CreditExhaustedError extends Error {
  readonly status = 402;
  readonly providers: string[];

  constructor(providers: string[]) {
    super(`Credit exhausted: ${providers.join(', ')}`);
    this.name = 'CreditExhaustedError';
  }
}
```

Error helper functions:

```typescript
export function buildProviderError(
  providerId: string,
  status: number | undefined,
  rawMessage: string,
): { message: string; status: number }

export function isTimeoutError(err: unknown): boolean
export function isRetryableError(err: unknown): boolean
```

Try/catch with logging:

```typescript
try {
  const { broadcastWs: bws } = require('./ws-state');
  bws?.({ type: 'gpu:transition', ... });
} catch (e) { 
  log.warn('broadcastWs failed:', e instanceof Error ? e.message : e); 
}
```

### Logging

Use `createLogger` with the module name:

```typescript
import { createLogger } from '../src/logger';
const log = createLogger('translation-cache');

log.log('Cache hit', { key, value });
log.warn('Cache miss', { key });
log.error(err, 'Failed to persist');
```

Log levels: `log.log()` (info), `log.warn()`, `log.error()`, `log.debug()` (test mode).

### Functions

Factory functions for object creation:

```typescript
export function createGateway({ storage, stateStore?, hooks? }: GatewayOptions): Gateway {
  return new GatewayImpl(storage, stateStore, hooks);
}

export function buildGpuTiers(config: GpuTierConfig): GpuTier[] { ... }
```

### Exports

Named exports, grouped by feature:

```typescript
// ── Cache operations ───────────────────────────────────────────────────────
export const translationCache = new LRUCache<TranslationEntry>(MAX_ENTRIES);
export function getTranslationCacheStats(): CacheStats { ... }

// ── Re-exports ─────────────────────────────────────────────────────────────
export { AIProviderRegistry } from './registry';
export type { FallbackEntry, FallbackOptions } from './fallback';
```

## Architecture Rules

### Hard Rules (enforced by CI)

1. **`src/` never imports from `server/`** — The library is publishable and must not depend on the server. CI enforces this.
2. **All GPU ops go through the gateway API** — Never call RunPod/Vast.ai/TensorDock directly. Bypasses watchdog, cost tracking, ghost detection.
3. **No Prisma/Redis/Next.js in `src/`** — Use DI interfaces (`AutoscalerDeps`, `StateStore`, `SettingsStore`).
4. **All new UI uses `web/src/components/ui/`** — Never re-implement shared components (`IconBox`, `Button`, `Card`, etc.).

### Adding a New Provider

1. Create `src/providers/<provider-name>.ts` with provider implementation
2. Register in `src/providers/index.ts`
3. Add tests in `__tests__/providers/`
4. Update `docs/domain-model.md` with provider details
5. Consider creating an ADR in `docs/adr/`

### Adding a New Pipeline Stage

1. Add stage to `PipelineStage` type in `src/autoscaler/types.ts`
2. Implement stage handlers in appropriate module
3. Add warmth tracking in `gpu-warmth-monitor.ts`
4. Add circuit breaker support in `circuit-breaker.ts`
5. Update routing logic in `hybrid-stages.ts`

### Adding a New GPU Provider

1. Implement `GpuProviderClient` interface in `src/gpu-providers/`
2. Add to `PREFERRED_GPU_TYPES` in `server/config.ts`
3. Add to cascade order documentation in `docs/adr/ADR-001-gpu-cascade-order.md`
4. Consider creating a new ADR if cascade order changes

## Testing

### Test Structure

```typescript
import { describe, it, expect } from 'vitest';

describe('feature name', () => {
  it('should do thing', () => {
    expect(result).toBe(expected);
  });
});
```

### Test Patterns

**Unit tests for pure functions:**

```typescript
it('correctly computes latency trend', () => {
  const samples = [100, 110, 105, 120, 130];
  const trend = computeLatencyTrend(samples);
  expect(trend).toBeGreaterThan(0.2);
});
```

**Contract tests for interfaces:**

```typescript
it('satisfies GpuProviderClient contract', () => {
  const client = createTestClient();
  expect(typeof client.deploy).toBe('function');
  expect(typeof client.stop).toBe('function');
  expect(typeof client.health).toBe('function');
});
```

**Property-based tests for transformations:**

```typescript
it('cache key is deterministic', () => {
  const key1 = buildCacheKey('en', 'es', 'formal', 'hello');
  const key2 = buildCacheKey('en', 'es', 'formal', 'hello');
  expect(key1).toBe(key2);
});

it('different languages produce different keys', () => {
  const key1 = buildCacheKey('en', 'es', 'formal', 'hello');
  const key2 = buildCacheKey('en', 'fr', 'formal', 'hello');
  expect(key1).not.toBe(key2);
});
```

### Running Tests

```bash
# All tests
bun test

# Unit tests only
bun test __tests__/unit/

# Integration tests
bun test __tests__/integration/

# Specific file
bun test __tests__/gpu-deploy-unit.test.ts

# Watch mode
bun run test:watch
```

## Architecture Decisions

When making significant architectural changes, document the decision:

1. **Create an ADR** in `docs/adr/` using the template
2. **Get review** from at least one maintainer
3. **Plan migration** if changing existing behavior
4. **Plan rollback** in case something goes wrong

### When to Create an ADR

- Adding a new provider or GPU backend
- Changing routing or fallback logic
- Modifying the pipeline stages
- Changing how state is persisted
- Any decision that affects multiple modules

### ADR Format

See `docs/adr/TEMPLATE.md` for the template.

## Pull Request Process

### Before Submitting

1. Run `bun test` — all tests must pass
2. Run `bun run build` — no type errors
3. Update documentation if needed

### PR Checklist

- [ ] `bun run build` succeeds
- [ ] `bun test` passes
- [ ] No `src/` → `server/` imports
- [ ] No `any` types without justification
- [ ] No hardcoded secrets
- [ ] Logging is meaningful (not noisy)
- [ ] Tests cover happy path and error cases
- [ ] Documentation updated if API changes
- [ ] ADR created if architecture change

### Commit Messages

Format: `type: description`

```
feat: add SnapGPU checkpoint support
fix: race condition in GPU monitoring
docs: add ADR-010 for request coalescing
refactor: extract cooldown tracker to separate module
test: add property-based tests for translation cache
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Ask in the PR if you're unsure about anything

Thank you for contributing!
