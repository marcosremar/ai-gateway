# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records for the AI Gateway project.

## What is an ADR?

An ADR is a document that captures an important architectural decision made along with its context and consequences. ADRs are immutable — once accepted, they are not modified. If a decision changes, a new ADR is created that supersedes the old one.

## For AI Coding Agents (Vibe Coding)

When making architectural decisions during AI-assisted development:

1. **Check first** — Before suggesting major changes, verify if an ADR already exists for the concern
2. **Query by keyword** — Use `grep -l "keyword" docs/adr/*.md` to find relevant ADRs
3. **Create if missing** — If no ADR exists for a significant decision, create one using `TEMPLATE.md`
4. **Index below** — Use the quick lookup table to find relevant ADRs for common concerns

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [ADR-001](ADR-001-gpu-cascade-order.md) | GPU Cascade Order | Accepted | 2024-01-15 |
| [ADR-002](ADR-002-lru-translation-cache.md) | LRU Translation Cache | Accepted | 2024-02-20 |
| [ADR-003](ADR-003-per-stage-circuit-breakers.md) | Per-Stage Circuit Breakers | Accepted | 2024-03-10 |
| [ADR-004](ADR-004-request-racing-gpu-cloud.md) | Request Racing — GPU + Cloud | Accepted | 2024-04-05 |
| [ADR-005](ADR-005-snapgpu-criu-policy.md) | SnapGPU/CRIU Fast Boot Policy | Accepted | 2024-05-12 |
| [ADR-006](ADR-006-per-stage-warmth-tracking.md) | Per-Stage Warmth Tracking | Accepted | 2024-06-01 |
| [ADR-007](ADR-007-p95-latency-demotion.md) | P95 Latency Demotion | Accepted | 2024-07-20 |
| [ADR-008](ADR-008-hybrid-routing-gpu-cloud.md) | Hybrid Routing (GPU + Cloud) | Accepted | 2024-08-15 |
| [ADR-009](ADR-009-provider-cooldown-tracking.md) | Provider Cooldown Tracking | Accepted | 2024-09-01 |
| [ADR-010](ADR-010-persistent-pull-history-and-dynamic-tier-ranking.md) | Persistent Pull History + Dynamic Tier Ranking | Accepted | 2026-04-17 |
| [ADR-011](ADR-011-idle-stop-not-destroy-policy.md) | Idle Policy — Stop, Not Destroy; 5-min Floor | Accepted | 2026-04-17 |
| [ADR-012](ADR-012-criugpu-snapshot-lifecycle.md) | CRIUgpu Snapshot Lifecycle — Capture, Restore, Catalog | Accepted | 2026-04-17 |
| [ADR-013](ADR-013-standby-pool-policy.md) | Standby Pool Policy | Accepted | 2026-04-17 |
| [ADR-014](ADR-014-snapshot-capable-provider-landscape-2026.md) | Snapshot-Capable Provider Landscape (2026) | Accepted | 2026-04-17 |
| [ADR-015](ADR-015-ai-quality-fitness-gates.md) | AI Quality Fitness Gates | Accepted | 2026-05-04 |
| [ADR-016](ADR-016-automated-ai-control-layers.md) | Automated AI Control Layers | Accepted | 2026-05-04 |

## Creating a New ADR

1. Copy `docs/adr/TEMPLATE.md` to `docs/adr/ADR-XXX-title.md`
2. Fill in the template
3. Add entry to this index
4. Commit with message: `docs: add ADR-XXX for <title>`

## ADR Format

Each ADR should contain:
- **Status:** Proposed | Accepted | Deprecated | Superseded
- **Date:** ISO 8601 date
- **Deciders:** Names of people who made the decision
- **Context:** What problem are we solving?
- **Decision:** What did we decide?
- **Reasoning:** Why this decision?
- **Alternatives Considered:** What else did we consider?
- **Consequences:** What are the trade-offs?
- **Monitoring:** What metrics should we track?

## Superseded ADRs

When an ADR is superseded, update its status and add a link to the new ADR:

```
**Superseded by:** [ADR-XXX](ADR-XXX-title.md)
```
