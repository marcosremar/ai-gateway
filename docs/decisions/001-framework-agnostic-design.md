# ADR-001: Framework-Agnostic Design

**Status:** Accepted
**Date:** 2026-01-15
**Deciders:** Marcos

## Context

The AI Gateway needs to work across multiple deployment environments (Fly.io, bare metal, Kubernetes) and be usable as a library from different host applications (Next.js, Express, standalone server). Hard-coupling to a specific framework would limit deployment flexibility and make the library harder to reuse.

## Decision

**Zero hard dependencies on Prisma, Redis, Next.js, or any web framework.**

All external dependencies are injected via interfaces (`AutoscalerDeps`, `GatewayStorage`, `StateStore`). The library provides default implementations but consumers can swap in their own.

### Examples

```typescript
// Dependency injection pattern
interface AutoscalerDeps {
  settingsStore: SettingsStore;
  stateStore: StateStore;
  sessionResolver: SessionResolver;
  logger?: Logger;
  credentialStore?: CredentialStore;
}
```

### What this means

- `src/` never imports from `server/` (enforced by CI)
- All adapters (Redis, InMemory, etc.) implement interfaces
- No framework-specific types in public API
- Host applications write thin shims, not core logic

## Consequences

### Positive
- Library can be used in any TypeScript project
- Testing is easier (mock via interfaces)
- No framework lock-in
- Smaller bundle for library-only consumers

### Negative
- More boilerplate than hard-coding dependencies
- Requires discipline to maintain the pattern
- Thin shims in host apps must be maintained

### Neutral
- `server/` exists as a reference implementation with Prisma + Redis
- CI enforces the boundary with a grep-based check

## Alternatives Considered

1. **Express/Hono as dependency** — Would simplify the proxy server but lock consumers into that framework
2. **Prisma as hard dependency** — Would simplify state management but exclude non-PostgreSQL users
3. **Monolithic package** — Everything in one place, harder to reuse portions

## References

- `docs/architecture/lib-vs-service.md`
- `.github/workflows/ci.yml` (boundary check)
