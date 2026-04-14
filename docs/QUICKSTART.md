# Onboarding — Quick Start Guide

Welcome to AI Gateway! This guide gets you productive in 5 minutes.

## Prerequisites

- **Bun** (latest) — `bun install`
- **Git** — for version control

## 5-Minute Setup

```bash
# 1. Clone
git clone https://github.com/marcosremar/ai-gateway.git
cd ai-gateway

# 2. Install
bun install

# 3. Configure
cp .env.example .env
# Edit .env and add your GROQ_API_KEY

# 4. Verify
bun run typecheck    # Should pass
bun run test:unit    # Should pass

# 5. Run!
bun run dev          # Dev with hot-reload
# or
bun run serve.ts     # Production mode
```

## First Steps

### Test the Gateway

```bash
# Health check
curl http://localhost:4000/health

# Chat completion
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Speech pipeline (audio → translated audio)
curl -X POST "http://localhost:4000/v1/speech?source=fr&target=en" \
  -H "Content-Type: audio/wav" \
  --data-binary @audio.wav
```

### Project Structure

```
ai-gateway/
├── src/              ← Library code (76 modules)
│   ├── errors/       ← Error hierarchy
│   ├── constants/    ← GPU types, models, timeouts
│   ├── utils/        ← Shared utilities
│   ├── config/       ← Centralized config
│   ├── middleware/   ← Auth, RBAC, rate limit, etc.
│   └── ...           ← 70+ more modules
├── server/           ← Reference service
├── __tests__/        ← Tests (378 files)
│   ├── unit/         ← 218 unit tests
│   ├── integration/  ← 61 integration tests
│   ├── e2e/          ← 46 e2e tests
│   └── load/         ← 50 load tests
├── docs/             ← Documentation (23 files)
└── scripts/          ← Utility scripts
```

## Common Commands

```bash
bun run dev              # Dev with hot-reload
bun run build            # Build library
bun run test:unit        # Unit tests
bun run test:coverage    # Tests with coverage
bun run format           # Format code
bun run lint             # Lint code
bun run typecheck        # Type check
```

## Need Help?

- **Architecture** → `docs/decisions/`
- **Troubleshooting** → `docs/troubleshooting.md`
- **Security** → `docs/security-architecture.md`
- **Contributing** → `CONTRIBUTING.md`
