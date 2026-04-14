# Migration Guide

This document tracks breaking changes between versions and how to migrate.

---

## v0.1.x → v0.2.x (Upcoming)

### Breaking Changes

#### 1. ESLint rules tightened

**What changed:** `@typescript-eslint/no-explicit-any` is now `error` (was `warn`).

**Migration:** Replace `any` with proper types in your code. If unavoidable, use `unknown` and narrow.

```typescript
// Before
function handleRequest(req: any) { ... }

// After
function handleRequest(req: IncomingMessage) { ... }
```

#### 2. Console.log usage discouraged

**What changed:** `no-console` rule now warns on `console.log` (allows `warn`, `error`).

**Migration:** Use the logger instead.

```typescript
// Before
console.log('Starting server...');

// After
import { createLogger } from '@parle/ai-gateway/logger';
const log = createLogger('serve');
log.info({}, 'Starting server...');
```

#### 3. Error responses now include `code` field

**What changed:** All error responses now include a structured `code` field (e.g., `PROVIDER_TIMEOUT`).

**Migration:** If your client code parses error responses, add handling for the new `code` field.

```json
// New error format
{
  "error": "ProviderError",
  "code": "PROVIDER_TIMEOUT",
  "message": "Provider groq timed out after 30000ms",
  "statusCode": 504,
  "retryable": true
}
```

#### 4. New constants module

**What changed:** Magic strings (GPU types, provider IDs, model names) are now centralized in `src/constants/`.

**Migration:** If you referenced GPU type names or model names as strings, use the constants instead.

```typescript
// Before
const gpuType = 'NVIDIA GeForce RTX 4090';

// After
import { GPU_TYPES } from '@parle/ai-gateway/constants';
const gpuType = GPU_TYPES.RTX_4090;
```

#### 5. Dynamic imports replace require() in serve.ts

**What changed:** `serve.ts` now uses `await import()` instead of `require()` for workload handlers.

**Migration:** If you have custom workload handlers, update them to be ESM-compatible.

---

## v0.0.x → v0.1.0 (Initial Release)

No previous version to migrate from. This is the first release.

---

## Deprecations (Future)

| Feature | Deprecated In | Removal In | Replacement |
|---------|--------------|------------|-------------|
| `HF_HUB_ENABLE_HF_TRANSFER=1` | v0.1.0 | v0.3.0 | `HF_XET_HIGH_PERFORMANCE=1` |
| `hf_transfer` pip package | v0.1.0 | v0.3.0 | `hf_xet` |
| Direct provider HTTP calls | v0.1.0 | v0.3.0 | Use `ai-gateway` SDK or API |
| SSE/WS/WebRTC endpoints | v0.1.0 | N/A | Blocked (410 Gone) |
