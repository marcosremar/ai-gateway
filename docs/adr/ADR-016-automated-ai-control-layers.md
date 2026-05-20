# ADR-016: Automated AI Control Layers

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** AI Gateway maintainers

## Context

ADR-015 introduced a project-specific AI quality fitness gate. That gate protects the most important AI Gateway boundaries, but AI-generated code can still introduce risks outside normal TypeScript compilation: vulnerable dependencies, leaked provider credentials, unsafe GitHub Actions, Docker supply-chain drift, unused scaffolding, weak tests and security issues.

The Gateway has high-risk surfaces: API key authentication, provider tokens, GPU deploy orchestration, Docker images, WebSocket payloads, cost controls and provider routing. These need automated controls because manual review does not reliably catch generated-code drift.

## Decision

Add layered automated controls around AI-generated changes:

- `dependency-cruiser` enforces the architecture graph and reports circular dependencies.
- `eslint-plugin-security` extends linting with JavaScript security rules.
- `fast-check` enables property-based tests for pure domain logic.
- `knip` provides dead-code and dependency-hygiene auditing.
- `scripts/supply-chain-policy.ts` audits workflow permissions, action pinning, floating refs, Docker `:latest`, deprecated Hugging Face transfer variables and `curl | bash`.
- CodeQL runs broad JavaScript/TypeScript SAST.
- Semgrep runs project security rules for high-confidence findings.
- Gitleaks runs secret scanning in CI.
- Dependency Review and OSV-Scanner run dependency vulnerability gates.
- README quality-control documentation is generated from `docs/quality-controls.json`.

Hard gates block only on rules that can pass today. Existing debt is exposed as warnings or non-blocking audits until it is triaged and ratcheted.

## Reasoning

Generated code fails in predictable ways: invented dependencies, duplicated abstractions, boundary violations, weak tests, accidental secrets, unsafe install snippets and security patterns that look plausible. These controls convert those risks into measurable gates.

The controls are split by responsibility:

- Fitness and dependency graph checks protect AI Gateway architecture.
- Supply-chain checks protect CI and Docker delivery paths.
- SAST and secret scanning protect externally reachable Gateway surfaces.
- Property and mutation tests improve confidence beyond coverage percentages.
- Knip keeps AI-generated scaffolding visible without blocking on current legacy debt.

## Alternatives Considered

- Only use code review. Rejected because review does not scale for generated code and misses non-local dependency/security drift.
- Make every scanner blocking immediately. Rejected because existing warnings would make CI unusable before debt is triaged.
- Put everything into one large custom script. Rejected because dedicated tools are better for dependency graphs, SAST, secrets and dead-code analysis.

## Consequences

- `quality:ai` becomes a broader local gate.
- New CI workflows may surface latent security or dependency debt.
- Some controls intentionally start as ratchets; maintainers must promote them to strict mode after cleanup.
- README quality-control docs must be updated through `bun run quality:readme`.

## Monitoring

- `quality:fitness` error count must remain zero.
- `quality:supply-chain` error count must remain zero; warning count should trend down.
- `quality:architecture` error count must remain zero; circular warnings should trend down.
- CodeQL, Semgrep, Gitleaks, Dependency Review and OSV findings should be reviewed per PR.
- Knip issue count should be tracked before promoting `quality:deadcode:strict`.
