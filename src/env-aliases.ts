// ── Provider env-var alias normalization ─────────────────────────────────────
// Historically the codebase grew two spellings for the TensorDock credential:
//   - `TENSORDOCK_API_TOKEN` — used by `.env.example`, `.env.test`,
//     scripts/validate-env.sh, and the autoscaler (provider-monitor /
//     config-loader / reconcile).
//   - `TENSORDOCK_API_KEY` — used by the deploy path (server/gpu-handlers*,
//     gpu-sweep, src/config, credential-resolver, gpu-driver).
// A user could only ever satisfy ONE of them, so following `.env.example`
// (TOKEN) silently broke every deploy/sweep code path that reads KEY (and vice
// versa). Normalize the two names to each other at startup so either spelling
// works regardless of which reader runs. Purely additive — never overwrites a
// value the user already set.

/** Mirror env var `a` ↔ `b`: copy whichever is set into the unset one. Never
 *  overwrites a value the user already provided. Exported for testing. */
export function aliasEnv(a: string, b: string): void {
  const va = process.env[a];
  const vb = process.env[b];
  if (va && !vb) process.env[b] = va;
  else if (vb && !va) process.env[a] = vb;
}

let done = false;

/** Mirror provider credential env-var aliases. Idempotent. */
export function normalizeProviderEnvAliases(): void {
  if (done) return;
  done = true;
  aliasEnv('TENSORDOCK_API_TOKEN', 'TENSORDOCK_API_KEY');
}

// Run on import so merely importing this module (early in the server + library
// entrypoints) applies the normalization before any handler reads the env.
normalizeProviderEnvAliases();
