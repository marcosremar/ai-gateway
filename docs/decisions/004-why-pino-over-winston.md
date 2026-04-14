# ADR-004: Why Pino Over Winston

**Status:** Accepted
**Date:** 2026-02-10
**Deciders:** Marcos

## Context

We needed a structured JSON logger for production observability. The two main contenders were Pino and Winston.

## Decision

**Use Pino** as the structured logger.

### Reasons

1. **Performance** — Pino is the fastest Node.js logger (~2x faster than Winston in benchmarks). For a gateway handling many requests per second, logging overhead matters.
2. **Structured by default** — Pino outputs JSON natively, no formatter needed.
3. **Child loggers** — `logger.child({ module: 'autoscaler' })` is built-in and efficient.
4. **Pino-pretty** — Human-readable in development, JSON in production.
5. **Small footprint** — Fewer dependencies than Winston.

```typescript
import { createLogger } from './logger';
const log = createLogger('proxy');
log.info({ userId, providerId }, 'Request received');
```

## Consequences

### Positive
- Low overhead logging at high throughput
- Easy to pipe to log aggregators (Datadog, Loki)
- Child loggers provide structured context

### Negative
- Pino's API is slightly less flexible than Winston's (no built-in transports)
- No built-in log rotation (handled externally)

## Alternatives Considered

1. **Winston** — More flexible transports but slower and heavier
2. **Bunyan** — Predecessor to Pino but slower
3. **Console.log** — Zero overhead but unstructured and hard to parse

## References

- `src/logger.ts`
- `CLAUDE.md` (logging conventions)
