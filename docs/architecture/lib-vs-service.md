# Architecture — Library vs Service boundary

> **Status**: policy (not aspirational). Enforced by CI via a grep check
> in `.github/workflows/ci.yml` that fails if `src/**` imports from
> `server/**`.
>
> **Why this matters**: `@parle/ai-gateway` is consumed in two different
> ways — as a publishable npm library by downstream TypeScript projects,
> and as a reference HTTP service running on Fly.io. These two modes have
> different contracts, different dependency footprints, and different
> release cadences. Mixing them produces an unpublishable tangle where
> the library silently depends on Fly/Bun globals and the service can't
> be rebuilt from published artifacts.

---

## The two layers

```
┌───────────────────────────────────────────────────┐
│  server/                                          │
│  reference HTTP service (Fly.io, Bun)             │
│  - Binds to HTTP port                             │
│  - Loads env vars                                 │
│  - Wires Prisma, Neon, Redis                      │
│  - Owns graceful shutdown                         │
│  - Imports from src/ only                         │
└─────────────┬─────────────────────────────────────┘
              │ imports (one-way)
              ▼
┌───────────────────────────────────────────────────┐
│  src/                                             │
│  publishable library (`@parle/ai-gateway`)        │
│  - Pure TypeScript, no framework assumptions      │
│  - DI everywhere (StateStore, Logger, Hooks)      │
│  - No process-level side effects at import time   │
│  - Zero imports from server/                      │
│  - Consumed by server/ AND by external packages   │
└───────────────────────────────────────────────────┘
```

**Rule 1 — one-way imports**: `server/` may import from `src/`. `src/`
may **never** import from `server/`. This is enforced in CI.

**Rule 2 — no process-level side effects in `src/`**: no `server.listen()`,
no `process.on('SIGTERM')`, no `console.log` at module scope. Side effects
belong in `server/` or in an application-level entry file.

**Rule 3 — DI for anything that touches the outside world**: persistence,
logging, credentials, session resolution. The library exports interfaces
(`StateStore`, `Logger`, `CredentialStore`, `SessionResolver`); the host
app provides implementations. This is what makes the library framework-
agnostic.

**Rule 4 — no hard dependency on Prisma, Redis, Next.js, Bun, or Fly.io**
in `src/`. These are runtime concerns the host app chooses. The library
accepts state stores via the `StateStore` interface, not by importing
`@prisma/client`. The one historical exception (`@prisma/client` in
`src/database/`) is allowed because it's mocked in tests via a vitest
alias and never imported by the lib's core paths.

---

## What goes where

| Concern | Location | Example |
|---|---|---|
| Provider client (RunPod, Vast) | `src/gpu-providers/` | Pure class, no env read at import |
| Autoscaler engine | `src/autoscaler/` | Receives deps via constructor |
| HTTP proxy | `src/proxy/` | Pure `http.createServer` wiring, framework-agnostic |
| Gateway SDK client | `src/sdk/` | Used both in-process and remotely |
| Prometheus exporter | `server/metrics.ts` | Reads process-level state |
| Fly.io secret wiring | `server/` | env-specific |
| WebSocket server | `server/ws-server.ts` | Bun-specific `Bun.serve()` |
| GPU deploy loop | `server/gpu-deploy.ts` | Mutates global state |
| SLO targets | `src/alerting/slo-targets.ts` | Pure data, consumed by both layers |

If you're adding a new module and don't know which side it belongs on,
ask: **"can this be published to npm and used from a different host
app?"** If yes → `src/`. If no → `server/`.

---

## Cross-cutting: what `serve.ts` does

The `serve.ts` file at the repo root is a **third layer** — a thin
Fly.io-specific entry point that imports ONLY from `src/`. It does not
import from `server/`. This lets us deploy a lightweight proxy to Fly.io
that ships with just the library's public surface, not the full
reference service.

```
serve.ts (Fly.io entry) ─── imports ───▶ src/ (library only)
server/ws-server.ts (full ref service) ─── imports ───▶ src/
```

The separation also means the library's tests (`__tests__/proxy-*.test.ts`
etc.) don't pick up any state from `server/`.

---

## Enforcement

### CI check

`.github/workflows/ci.yml` runs:

```bash
if grep -rn --include='*.ts' -E "from ['\"]\\.\\./\\.\\./server/|from ['\"]\\.\\./server/" src/ 2>/dev/null; then
  exit 1
fi
```

A PR that adds `import { foo } from '../server/...'` in any `src/` file
fails the CI job. Reviewers can rely on the guard; they don't have to
spot it by eye.

### Typecheck doesn't catch this

TypeScript's project structure allows cross-imports by default because
they compile fine. Only the guard script blocks them. If you find a
bypass (symlinks, module aliases, relative `../../` that sneaks through),
file a bug on the guard.

---

## Exceptions

There are **zero standing exceptions**. If a refactor needs one, it
needs a PR against this document discussing why, and the CI guard needs
to be tightened afterward — never loosened.

The closest thing to an exception is `src/database/` which imports
`@prisma/client` as a peer dep. That's allowed because Prisma is a
typed DB client, not a server-shape module, and because tests alias it
to a mock in `vitest.config.ts`. It is not a precedent.

---

## History

- 2026-04-12 — Policy formalized during the production-readiness sprint
  (`docs/production-readiness-plan.md` item 9). CI guard landed in the
  same PR.
