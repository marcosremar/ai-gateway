# ADR-015: AI Quality Fitness Gates

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** AI Gateway maintainers

## Context

AI coding agents can generate code faster than humans can review line by line. This increases the risk of architectural drift, hallucinated dependencies, weak tests, oversized modules, and code that works locally but violates Gateway boundaries.

The project already has hard architectural rules: `src/` is publishable, `server/` is the HTTP delivery layer, `web/` is the Next.js UI, and runtime infrastructure must be hidden behind explicit Gateway interfaces.

## Decision

Add an automated quality fitness gate:

- `bun run quality:fitness` runs repository-specific architecture and dependency checks.
- `bun run quality:ai` runs typecheck, lint, build, and the fitness gate.
- `bun run quality:ai:test` also runs the unit test suite.
- `bun run quality:ai:deep` also runs mutation testing for high-risk changes.
- CI runs `quality:fitness` in the Typecheck & Lint shard.

Current legacy violations are tracked in `quality-fitness-baseline.json` so the gate can ratchet forward without requiring an unrelated architectural migration in the same change.

## Reasoning

The gate encodes project-specific rules that generic linters do not know:

- `src/` and `sdk/` must not import `server/` or `web/`.
- `src/` must not use Prisma, Redis, or Next.js directly.
- `web/src` must not import `server/` and may only import the browser SDK from `src/`.
- external imports must be declared in the appropriate package manifest.
- shared UI components must be imported from `web/src/components/ui`.
- deprecated Hugging Face transfer flags are reported so Docker/model download code moves toward `hf_xet`.

This keeps humans focused on intent, stage behavior, Provider routing, Budget Gate implications, and architectural tradeoffs while automation rejects obvious drift.

## Alternatives Considered

### Only Human Review

Rejected because AI-generated diffs can be large and plausible. Manual review alone does not scale with agent output.

### Generic Linting Only

Rejected because ESLint and TypeScript do not understand Gateway bounded contexts, provider boundaries, or optional dependency policy.

### Strict Gate With No Baseline

Rejected for now because existing legacy Database code still has known violations. Blocking all work until that migration is complete would reduce adoption of the gate.

## Consequences

### Positive

- New architectural violations fail quickly in local runs and CI.
- Hallucinated package imports are caught before install/runtime.
- Existing quality debt is visible as warnings and can be ratcheted down.
- Mutation testing has an explicit command for high-risk AI-generated changes.

### Negative

- The custom gate must evolve with project boundaries.
- Legacy baseline entries can hide debt if they are not periodically removed.
- Mutation testing is too expensive for every PR and remains a deep check.

## Monitoring

```
quality_fitness_errors
quality_fitness_warnings
quality_fitness_baseline_entries
mutation_score_percent
```

## Notes

Remove entries from `quality-fitness-baseline.json` as the Database context is moved fully behind DI ports.
