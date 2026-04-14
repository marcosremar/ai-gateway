# ADR-002: Lib vs Service Architecture Split

**Status:** Accepted
**Date:** 2026-01-15
**Deciders:** Marcos

## Context

The project has two distinct concerns:
1. **Library code** — Reusable AI provider abstraction, autoscaler engine, client SDKs
2. **Service code** — Reference implementation with Prisma, Redis, Next.js adapters

Mixing these creates a package that's hard to publish as a library because it pulls in heavy framework dependencies.

## Decision

**`src/` is the publishable library. `server/` is the reference service.**

- `server/` may import from `src/`
- `src/` must **never** import from `server/`
- Enforced by CI guard in `.github/workflows/ci.yml`

```bash
# CI check
if grep -rn --include='*.ts' -E "from ['\"]\\.\\./\\.\\./server/|from ['\"]\\.\\./server/" src/; then
  echo "::error::src/ must not import from server/"
  exit 1
fi
```

### Directory responsibilities

| Directory | Purpose | Can Import From |
|-----------|---------|-----------------|
| `src/` | Publishable library | Only `src/` and npm packages |
| `server/` | Reference service | `src/`, `server/`, npm packages |
| `sdk/` | Client SDKs | `src/`, npm packages |
| `__tests__/` | Tests | Anything |

## Consequences

### Positive
- Clean separation enables library publishing
- Service can use full Prisma/Redis without affecting library consumers
- Clear mental model for contributors

### Negative
- Duplication: service has its own adapters that wrap library interfaces
- Contributors must understand which directory to modify

## Alternatives Considered

1. **Single package with optional deps** — Makes publishing harder (peer deps everywhere)
2. **Separate Git repos** — Too much overhead for sync
3. **Monorepo with separate workspaces** — Ideal but adds tooling complexity (planned for Phase 5)

## References

- `.github/workflows/ci.yml`
- `docs/architecture/lib-vs-service.md`
