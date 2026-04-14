# Onboarding Guide — First Time Contributor

Welcome to `@parle/ai-gateway`! This guide will get you from zero to your first contribution.

## 1. Quick Setup (5 min)

```bash
git clone https://github.com/marcosremar/ai-gateway.git
cd ai-gateway
bun install
bun run typecheck    # Should pass
bun run test:unit    # Should pass (~15s)
```

That's it. You're ready to contribute.

## 2. Understand the Project

### What does this do?

AI Gateway is a **proxy + autoscaler** that sits between your app and AI providers (OpenAI, Groq, etc.). It:
1. **Routes requests** to the best available provider (GPU first, cloud fallback)
2. **Auto-scales GPUs** across providers (RunPod → Vast.ai → Modal)
3. **Runs a speech pipeline** — audio in, translated audio out (STT → LLM → TTS)

### Key directories

```
src/              ← Library code (what gets published)
server/           ← Reference service (Prisma + Redis)
__tests__/        ← All tests
docs/             ← Documentation
scripts/          ← Benchmark/deploy utilities
sdk/              ← Client SDKs (TypeScript + Python)
```

### Golden rule

**`src/` must never import from `server/`.** This is enforced by CI. Think of `src/` as the library and `server/` as one possible consumer.

## 3. Your First PR

### Easy starting points

1. **Fix a typo in docs** — Always welcome
2. **Add a test** — Pick an untested function, write a test
3. **Add JSDoc** — Public APIs need documentation
4. **Pick a `good first issue`** — Check the issues label

### Workflow

```bash
# 1. Create a branch
git checkout -b fix/your-fix

# 2. Make changes
# ... edit files ...

# 3. Check your work
bun run typecheck
bun run lint
bun run test:unit

# 4. Commit
git add .
git commit -m "fix: description of your fix"

# 5. Push and open a PR
git push origin fix/your-fix
```

## 4. Common Pitfalls

| Problem | Solution |
|---------|----------|
| `bun install` fails | Run `bun install --frozen-lockfile` |
| Tests fail with `GROQ_API_KEY` | Set `SKIP_GPU_TESTS=1` |
| Typecheck fails on `@prisma/client` | This is expected — it's mocked in tests |
| `serve.ts` won't start | You need `GROQ_API_KEY` in `.env` |
| ESLint complains about imports | Run `bun run lint:fix` |

## 5. Commands Cheat Sheet

```bash
bun run typecheck       # Type check (fast)
bun run lint            # ESLint check
bun run lint:fix        # Auto-fix ESLint issues
bun run format          # Format with Prettier
bun run test:unit       # Unit tests only (fastest)
bun run test            # All tests (slow)
bun run test:coverage   # Run with coverage report
bun run build           # Build library bundle
bun run serve.ts        # Start dev server (needs GROQ_API_KEY)
```

## 6. Where to Get Help

- **Architecture questions** → Check `docs/decisions/` (ADRs)
- **How to use a module** → Check `CLAUDE.md` and `README.md`
- **Bug in the code** → Open an issue with the bug template
- **Not sure where to start** → Check `docs/improvement-checklist.md`

## 7. Code Review Expectations

When your PR is reviewed, expect:
- Requests for tests on new code
- Suggestions to simplify complex functions
- Requests for JSDoc on public APIs
- Checks that `src/` doesn't import from `server/`

This is normal — don't be discouraged! Every review makes the codebase better.

Welcome aboard! 🎉
