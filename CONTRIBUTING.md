# Contributing to AI Gateway

Thank you for your interest in contributing to `@parle/ai-gateway`! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Commit Messages](#commit-messages)
- [Architecture](#architecture)

## Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/). Be respectful, inclusive, and constructive in all interactions.

## Getting Started

### Prerequisites

- **Bun** (latest stable) — `bun install`
- **Node.js** 20+ (if not using Bun)
- **TypeScript** 5+ (included)
- **Docker** (optional, for local GPU testing)

### First-time Setup

```bash
# Clone the repository
git clone https://github.com/marcosremar/ai-gateway.git
cd ai-gateway

# Install dependencies
bun install

# Verify setup
bun run typecheck
bun run test:unit
```

### Project Structure

```
ai-gateway/
├── src/              # Library code (publishable)
├── server/           # Reference service (can import from src/)
├── sdk/              # Client SDKs (TypeScript + Python)
├── __tests__/        # Test files
├── docs/             # Documentation
├── scripts/          # Utility scripts
└── examples/         # Example usage
```

**Golden Rule**: `src/` must never import from `server/`. Enforced by CI.

## Development Setup

### Commands

```bash
bun run typecheck    # Type check only
bun run build        # Build library bundle
bun run test         # Run all tests
bun run test:unit    # Unit tests only (fast)
bun run serve.ts     # Start dev server
```

### VS Code

We provide workspace settings in `.vscode/`. Install recommended extensions for the best experience:
- ESLint
- Prettier
- TypeScript

## Making Changes

### 1. Find an Issue

- Look for [good first issue](https://github.com/marcosremar/ai-gateway/labels/good%20first%20issue) labels
- Check the [improvement checklist](docs/improvement-checklist.md)
- Or open a new issue describing your idea

### 2. Create a Branch

```bash
git checkout main
git pull
git checkout -b feature/your-feature-name
# or: git checkout -b fix/issue-description
```

### 3. Write Code

- Follow existing patterns in the codebase
- Use TypeScript strict mode (no `any`)
- Add JSDoc to public APIs
- Write tests for new functionality

### 4. Run Checks

Before committing:

```bash
bun run typecheck     # Must pass
bun run lint          # Fix any warnings
bun run test:unit     # Unit tests must pass
```

## Testing

### Test Categories

- **Unit tests** — `__tests__/*-unit.test.ts` (fast, no external deps)
- **Integration tests** — `__tests__/*-integration.test.ts` (require mock services)
- **Live tests** — `__tests__/*-real-api.test.ts` (require API keys)
- **Load tests** — `__tests__/load-*.test.ts` and `load-testing/`

### Writing Tests

```typescript
import { describe, it, expect, vi } from 'vitest';
import { yourFunction } from '../src/your-module';

describe('yourFunction', () => {
  it('should do something specific', () => {
    const result = yourFunction(input);
    expect(result).toEqual(expected);
  });

  it('should handle edge case', () => {
    expect(() => yourFunction(invalidInput)).toThrow(ExpectedError);
  });
});
```

### Skipping External Dependencies

```typescript
// Skip if no GPU/credentials available
describe.skipIf(process.env.SKIP_GPU_TESTS === '1')('GPU tests', () => {
  it('should boot a GPU', async () => {
    // ...
  });
});
```

## Submitting Changes

### 1. Create a Changeset (for versioned changes)

```bash
bunx changeset
```

Select the packages changed, choose semver type (patch/minor/major), and write a summary.

### 2. Push and Open PR

```bash
git add .
git commit -m "feat: add your feature"
git push origin feature/your-feature-name
```

Then open a Pull Request on GitHub.

### 3. PR Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run test:unit` passes
- [ ] `bun run build` succeeds
- [ ] Changeset added (if user-facing)
- [ ] Documentation updated (if API changes)
- [ ] No `console.log` (use logger)
- [ ] No `any` types

### 4. CI Checks

All PRs run:
- Type check
- Unit tests
- Build
- Lib/service boundary check

### 5. Review Process

- At least 1 maintainer must approve
- Address review comments promptly
- Keep PRs focused and small (< 400 lines ideal)

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `style:` — Formatting, no code change
- `refactor:` — Code change, no feature behavior change
- `perf:` — Performance improvement
- `test:` — Adding or fixing tests
- `chore:` — Maintenance, build process, dependencies

### Examples

```
feat(autoscaler): add predictive warmup for GPU tiers
fix(proxy): handle streaming timeout on slow providers
docs: add troubleshooting guide for RunPod failures
perf(caching): reduce memory footprint by 30%
test(auth): add HMAC token verification edge cases
```

## Architecture

### Key Design Decisions

1. **Framework-agnostic** — No hard dependencies on Prisma, Redis, or Next.js
2. **Dependency injection** — All external dependencies injected via interfaces
3. **Modular exports** — Each subpath independently importable
4. **Tier cascade** — GPU autoscaler walks through tiers (cheapest first)
5. **Provider fallback** — AI providers fail over automatically with cooldown

See [docs/architecture/](docs/architecture/) for detailed decisions.

### Module Boundaries

- `src/` — Publishable library, zero framework dependencies
- `server/` — Reference service implementation, can import from `src/`
- `src/proxy/` — HTTP proxy server (pure Node.js)
- `src/providers/` — AI provider implementations
- `src/autoscaler/` — GPU autoscaling engine
- `src/adapters/` — State persistence adapters

### Adding New Features

1. **New AI provider** → `src/providers/<name>.ts` + register in `src/providers/index.ts`
2. **New GPU provider** → `src/gpu-providers/<name>.ts`
3. **New endpoint** → `src/proxy/routes/<name>.ts` + wire in `src/proxy/server.ts`
4. **New autoscaler feature** → `src/autoscaler/<name>.ts` + wire in factory
5. **New adapter** → `src/adapters/<name>.ts` + export in `src/adapters/index.ts`

## Questions?

- Check [CLAUDE.md](CLAUDE.md) for AI assistant guidelines
- Check [README.md](README.md) for overview
- Check [docs/](docs/) for detailed guides
- Open an issue for architecture questions

Thank you for contributing! 🙏
