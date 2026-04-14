# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) — short documents explaining why key technical decisions were made and the context behind them.

## What is an ADR?

An ADR is a lightweight document that captures:
- **Context**: What problem are we solving?
- **Decision**: What did we choose?
- **Consequences**: What are the trade-offs?

## ADR Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [001](001-framework-agnostic-design.md) | Framework-Agnostic Design | Accepted | 2026-01-15 |
| [002](002-lib-vs-service-architecture.md) | Lib vs Service Split | Accepted | 2026-01-15 |
| [003](003-transport-policy.md) | Transport Policy (No SSE/WS/WebRTC) | Accepted | 2026-02-01 |
| [004](004-why-pino-over-winston.md) | Why Pino Over Winston | Accepted | 2026-02-10 |
| [005](005-why-tsup-over-esbuild.md) | Why tsup Over Raw esbuild | Accepted | 2026-02-10 |
| [006](006-provider-fallback-strategy.md) | Provider Fallback Strategy | Accepted | 2026-02-15 |
| [007](007-gpu-autoscaler-tier-design.md) | GPU Autoscaler Tier Design | Accepted | 2026-02-20 |
| [008](008-speech-pipeline-design.md) | Speech Pipeline (STT→LLM→TTS) | Accepted | 2026-03-01 |

## How to Create a New ADR

1. Copy `template.md` to `NNN-short-title.md`
2. Fill in the template
3. Update this index
4. Reference the ADR in relevant code comments
