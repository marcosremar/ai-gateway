/**
 * Pure, side-effect-free helpers for the `ai-gateway` CLI (`bin/ai-gateway.ts`).
 *
 * Extracted here so the parsing/validation logic is unit-testable without
 * importing `bin/ai-gateway.ts` (which runs `main()` at module load). Keep this
 * file dependency-free and free of `process.exit`/console — return values and
 * let the caller decide on output/exit behavior.
 */

/** Process exit codes, mirroring the cost-audit binary's documented scheme.
 *  2 = usage error (bad args/flags); 1 = runtime/HTTP error. */
export const EXIT_USAGE = 2;
export const EXIT_RUNTIME = 1;

/** Result of validating a numeric CLI flag value. */
export interface NumericFlagResult {
  /** Parsed value when valid. */
  value?: number;
  /** Human-readable error when invalid (caller should print + exit EXIT_USAGE). */
  error?: string;
}

/**
 * Validate a numeric flag value instead of silently producing `NaN`.
 *
 * Returns `{ value }` on success or `{ error }` on failure. `undefined`/missing
 * input is treated as "not provided" → `{ value: undefined }` (no error), so the
 * caller can apply its own default.
 *
 * @param raw   the raw string captured for the flag (or undefined if absent)
 * @param flag  the flag name, for the error message (e.g. "-n")
 * @param opts  optional bounds + integer requirement
 */
export function validateNumericFlag(
  raw: string | undefined,
  flag: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): NumericFlagResult {
  if (raw === undefined) return { value: undefined };
  const trimmed = raw.trim();
  if (trimmed === '') return { error: `Invalid value for ${flag}: expected a number, got empty string` };
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return { error: `Invalid value for ${flag}: "${raw}" is not a number` };
  }
  if (opts.integer && !Number.isInteger(num)) {
    return { error: `Invalid value for ${flag}: "${raw}" must be an integer` };
  }
  if (opts.min !== undefined && num < opts.min) {
    return { error: `Invalid value for ${flag}: ${num} is below the minimum of ${opts.min}` };
  }
  if (opts.max !== undefined && num > opts.max) {
    return { error: `Invalid value for ${flag}: ${num} exceeds the maximum of ${opts.max}` };
  }
  return { value: num };
}

/**
 * Like `getArg`, but rejects a value that is itself a flag.
 *
 * `getArg(args, '-m')` returns the next token even if it starts with `-`, so
 * `chat -m --no-stream` swallows `--no-stream` as the model. This guard returns
 * `undefined` when the next token looks like a flag, matching the cost-audit
 * binary's `getFlag` behavior.
 */
export function getArgSafe(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value.startsWith('-')) return undefined;
  return value;
}

/**
 * Parse and validate the `--max-cost-usd` hourly cost ceiling for `gpu deploy`.
 *
 * Returns `{ value }` (the dollars/hr cap) when valid, `{ error }` when the
 * flag was provided but malformed, or `{ value: undefined }` when absent.
 */
export function parseMaxCostUsd(raw: string | undefined): NumericFlagResult {
  return validateNumericFlag(raw, '--max-cost-usd', { min: 0.000001 });
}

/**
 * Classify a thrown error into a CLI exit code.
 *
 * Usage errors (bad args/flags) should be raised as `UsageError` so they map to
 * EXIT_USAGE (2); everything else (HTTP/runtime/network failures) maps to
 * EXIT_RUNTIME (1).
 */
export function classifyExitCode(err: unknown): number {
  if (err instanceof UsageError) return EXIT_USAGE;
  if (err && typeof err === 'object' && (err as { isUsageError?: boolean }).isUsageError === true) {
    return EXIT_USAGE;
  }
  return EXIT_RUNTIME;
}

/** Error subtype for CLI usage problems (bad/missing args). Maps to EXIT_USAGE. */
export class UsageError extends Error {
  readonly isUsageError = true;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// ── #804: top-level --version / --help dispatch ───────────────────────────────

/**
 * Classify a top-level argv into an early-exit flag, before per-command dispatch.
 *
 * `version` is only a positional command today; `ai-gateway --version`/`-v` fall
 * through to "unknown command". This recognises the GNU-style flags. Note `-v`
 * is ONLY treated as version when it is the *first* token with no command — the
 * `tts -v <voice>` shorthand (a value flag on a real command) is unaffected.
 *
 * @returns `'version'` | `'help'` | `undefined` (no top-level flag → dispatch normally)
 */
export function parseTopLevelFlag(args: string[]): 'version' | 'help' | undefined {
  const first = args[0];
  if (first === undefined) return undefined;
  if (first === '--version' || first === '-V' || first === '-v') return 'version';
  if (first === '--help' || first === '-h') return 'help';
  return undefined;
}

// ── #806: unknown / misspelled flag detection ─────────────────────────────────

/** Levenshtein distance — small, dependency-free, for "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Result of scanning a command's argv for unrecognised `--flags`. */
export interface UnknownFlagsResult {
  /** Flags present in argv that are not in the known set. */
  unknown: string[];
  /** Best-effort "did you mean" suggestion for the first unknown flag. */
  suggestion?: string;
}

/**
 * Detect unrecognised `--flags`/`-x` tokens for a command (#806).
 *
 * `getArg`/`hasFlag` silently ignore unknown flags, so a typo like `--maxtokens`
 * is dropped without error. This collects them and suggests the closest known
 * flag (edit-distance ≤ 2) so the caller can warn.
 *
 * Only tokens that *start with* `-` and are not a lone `-`/`--` are considered.
 * Negative numbers (`-5`) are skipped — they're values, not flags.
 *
 * @param args   the argv slice for the command (excluding the command name)
 * @param known  the set/array of recognised flag spellings (both short + long)
 */
export function detectUnknownFlags(args: string[], known: Iterable<string>): UnknownFlagsResult {
  const knownSet = known instanceof Set ? known : new Set(known);
  const unknown: string[] = [];
  for (const tok of args) {
    if (!tok.startsWith('-') || tok === '-' || tok === '--') continue;
    // Skip negative numbers (e.g. "-5", "-1.5") — they are values, not flags.
    if (/^-\d/.test(tok)) continue;
    // Strip an inline value: --model=x → --model
    const flag = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
    if (!knownSet.has(flag)) unknown.push(flag);
  }
  let suggestion: string | undefined;
  if (unknown.length > 0) {
    const bad = unknown[0].replace(/^-+/, '');
    let best: string | undefined;
    let bestDist = Infinity;
    for (const k of knownSet) {
      const d = editDistance(bad, k.replace(/^-+/, ''));
      if (d < bestDist) { bestDist = d; best = k; }
    }
    if (best !== undefined && bestDist <= 2) suggestion = best;
  }
  return { unknown, suggestion };
}

// ── #809 / #852: gpu offers --sort ────────────────────────────────────────────

export type OffersSortKey = 'price' | 'vram' | 'score';

/** Parse/validate the `gpu offers --sort` key. Defaults to `price` (cheapest-first). */
export function parseOffersSort(raw: string | undefined): { value: OffersSortKey } | { error: string } {
  if (raw === undefined) return { value: 'price' };
  const v = raw.trim().toLowerCase();
  if (v === 'price' || v === 'vram' || v === 'score') return { value: v };
  return { error: `Invalid --sort: "${raw}" (expected price|vram|score)` };
}

interface OfferLike {
  pricePerHr?: number;
  vram?: number;
  vramGb?: number;
  score?: number;
}

/**
 * Sort GPU offers by the chosen key (#852). Returns a new array (does not mutate).
 *   - `price`: ascending (cheapest first — the documented default)
 *   - `vram` : descending (most VRAM first)
 *   - `score`: descending (best score first)
 */
export function sortOffers<T extends OfferLike>(offers: readonly T[], key: OffersSortKey): T[] {
  const arr = [...offers];
  const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  if (key === 'price') {
    return arr.sort((a, b) => (num(a.pricePerHr) ?? Infinity) - (num(b.pricePerHr) ?? Infinity));
  }
  if (key === 'vram') {
    return arr.sort((a, b) => (num(b.vramGb ?? b.vram) ?? -1) - (num(a.vramGb ?? a.vram) ?? -1));
  }
  return arr.sort((a, b) => (num(b.score) ?? -1) - (num(a.score) ?? -1));
}

// ── #843: aggregate burn rate across instances ────────────────────────────────

/**
 * Sum the per-hour cost across active GPU instances (#843) so `gpu list` can
 * print a combined-burn footer. Ignores missing/non-numeric `costPerHr`.
 */
export function sumBurnRate(instances: ReadonlyArray<{ costPerHr?: unknown }>): { totalPerHr: number; counted: number } {
  let totalPerHr = 0;
  let counted = 0;
  for (const inst of instances) {
    const v = typeof inst.costPerHr === 'number' ? inst.costPerHr : Number(inst.costPerHr);
    if (Number.isFinite(v) && v > 0) {
      totalPerHr += v;
      counted++;
    }
  }
  return { totalPerHr, counted };
}

// ── #854 / #863: API-key source provenance ────────────────────────────────────

/** The env var names the CLI consults for the gateway API key, in precedence order. */
export const KEY_ENV_PRECEDENCE = [
  'AIGW_APP_KEY',
  'AI_GATEWAY_KEY',
  'GATEWAY_API_KEY',
  'GATEWAY_API_KEYS',
] as const;

/**
 * Resolve which env var supplied the API key (#854) so `config` can show
 * provenance. Mirrors `getConfig()`'s precedence; for `GATEWAY_API_KEYS`
 * (the "key:name,..." multi-key format) it returns the first key.
 *
 * @returns `{ key, source }` — `source` is `'none'` when no key is set.
 */
export function resolveKeySource(env: Record<string, string | undefined>): { key: string; source: string } {
  for (const name of KEY_ENV_PRECEDENCE) {
    const raw = env[name];
    if (!raw) continue;
    if (name === 'GATEWAY_API_KEYS') {
      const first = raw.split(',')[0]?.split(':')[0]?.trim();
      if (first) return { key: first, source: name };
      continue;
    }
    return { key: raw, source: name };
  }
  return { key: '', source: 'none' };
}

/** Mask a secret for display: first 8 + last 4 chars, or `(not set)` when empty. */
export function maskKey(key: string): string {
  if (!key) return '(not set)';
  if (key.length <= 12) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

// ── #857: whoami identity parsing ─────────────────────────────────────────────

/**
 * Parse the `key:user[:label]` structured API-key format into an identity (#857).
 * Pure version of `cmdWhoami`'s inline `key.split(':')` logic so it's testable.
 */
export function parseUserIdentity(key: string): { user: string; label?: string; keyHint: string } {
  const parts = key.split(':');
  if (parts.length >= 2) {
    return {
      user: parts[1] || 'default',
      label: parts.length >= 3 ? parts.slice(2).join(':') : undefined,
      keyHint: `${parts[0].slice(0, 8)}…`,
    };
  }
  return { user: 'default', keyHint: `${key.slice(0, 8)}…` };
}

// ── #858: gateway URL validation ──────────────────────────────────────────────

/**
 * Validate a resolved gateway URL early with a clear error (#858), matching the
 * SDK's constructor check. Returns the normalised (trailing-slash-stripped) URL
 * or a usage error string.
 */
export function validateGatewayUrl(raw: string | undefined): { value: string } | { error: string } {
  if (!raw || !raw.trim()) return { error: 'Gateway URL is empty — set AI_GATEWAY_URL' };
  const url = raw.trim();
  if (!/^https?:\/\/[^/\s]+/i.test(url)) {
    return { error: `Invalid gateway URL "${raw}" — must be a full http(s):// URL` };
  }
  try {
    new URL(url);
  } catch {
    return { error: `Invalid gateway URL "${raw}" — could not be parsed` };
  }
  return { value: url.replace(/\/+$/, '') };
}

// ── #898 / #826: structured HTTP error parsing ────────────────────────────────

export interface ParsedHttpError {
  /** Best-effort human message. */
  message: string;
  /** Structured `code` from the gateway error body, when present (e.g. CREDIT_EXHAUSTED). */
  code?: string;
  /** Whether the gateway flagged the error as retryable. */
  retryable?: boolean;
}

/**
 * Parse a non-OK HTTP response body into a structured error (#898/#826).
 *
 * The gateway returns `{ error, code, message, retryable }` (ErrorResponseSchema).
 * Surfaces `code`/`retryable` so users see `CREDIT_EXHAUSTED` etc. instead of a
 * bare status. Falls back to the raw (truncated) text when the body is not JSON.
 */
export function parseHttpError(status: number, body: string): ParsedHttpError {
  const truncated = body.length > 300 ? `${body.slice(0, 300)}…` : body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { message: `HTTP ${status}: ${truncated || '(empty body)'}` };
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const inner = (o.error && typeof o.error === 'object') ? (o.error as Record<string, unknown>) : o;
    const msg = (typeof inner.message === 'string' && inner.message)
      || (typeof o.message === 'string' && o.message)
      || (typeof o.error === 'string' && o.error)
      || `HTTP ${status}`;
    const code = typeof o.code === 'string' ? o.code
      : typeof inner.code === 'string' ? inner.code
      : undefined;
    const retryable = typeof o.retryable === 'boolean' ? o.retryable
      : typeof inner.retryable === 'boolean' ? inner.retryable
      : undefined;
    return { message: String(msg), code, retryable };
  }
  return { message: `HTTP ${status}: ${truncated}` };
}

/** Format a ParsedHttpError for a single-line CLI message (includes the code when set). */
export function formatHttpError(err: ParsedHttpError): string {
  if (err.code) {
    const retry = err.retryable === true ? ' (retryable)' : err.retryable === false ? ' (not retryable)' : '';
    return `${err.code}: ${err.message}${retry}`;
  }
  return err.message;
}

// ── #816: overwrite guard for binary-output commands ──────────────────────────

/**
 * Decide whether to warn/refuse before clobbering an existing output file (#816).
 *
 * @param exists  whether the target path already exists on disk
 * @param force   whether `--force` was passed (caller may overwrite silently)
 * @returns `'ok'` (write), `'warn'` (exists but force/non-default → warn only),
 *          or `'block'` (exists, default path, no force → refuse with guidance)
 */
export function overwriteDecision(opts: { exists: boolean; force?: boolean; isDefaultPath?: boolean }): 'ok' | 'warn' | 'block' {
  if (!opts.exists) return 'ok';
  if (opts.force) return 'warn';
  if (opts.isDefaultPath) return 'block';
  return 'warn';
}

// ── #817: client-side upload size validation ──────────────────────────────────

/** Default audio upload cap (25 MB) — matches the CLI's documented STT limit. */
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Validate a file size client-side before upload (#817) so a multi-MB file
 * fails fast locally instead of after a wasted upload + provider charge.
 */
export function validateUploadSize(bytes: number, maxBytes = MAX_AUDIO_UPLOAD_BYTES): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(bytes) || bytes < 0) return { ok: false, error: 'Invalid file size' };
  if (bytes === 0) return { ok: false, error: 'File is empty (0 bytes)' };
  if (bytes > maxBytes) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    return { ok: false, error: `File too large: ${mb}MB (max ${maxMb}MB)` };
  }
  return { ok: true };
}

// ── #896: `--` separator for verbatim chat messages ───────────────────────────

/**
 * Collect a chat message from argv, supporting a `--` separator that terminates
 * flag parsing so a message like `chat -- -5 degrees` is preserved verbatim (#896).
 *
 * Before `--`: tokens starting with `-` are dropped (existing behaviour), and a
 * value flag in `valuedFlags` consumes its following token. After `--`: every
 * token is taken verbatim.
 */
export function chatMessageArgsWithSeparator(args: string[], valuedFlags: Iterable<string>): string[] {
  const valued = valuedFlags instanceof Set ? valuedFlags : new Set(valuedFlags);
  const sep = args.indexOf('--');
  const message: string[] = [];
  const end = sep === -1 ? args.length : sep;
  // Pre-separator: skip flags + their values. Start at 1 to skip the command name.
  for (let i = 1; i < end; i++) {
    const arg = args[i];
    if (valued.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    message.push(arg);
  }
  // Post-separator: everything verbatim.
  if (sep !== -1) {
    for (let i = sep + 1; i < args.length; i++) message.push(args[i]);
  }
  return message;
}

// ── #845: configurable low-balance threshold ──────────────────────────────────

/** Default low-balance warning threshold (USD). */
export const DEFAULT_LOW_BALANCE_USD = 5;

/**
 * Resolve the low-balance warning threshold (#845) from `AIGW_LOW_BALANCE_USD`,
 * falling back to the documented default. Non-numeric/≤0 values are ignored.
 */
export function resolveLowBalanceThreshold(raw: string | undefined, fallback = DEFAULT_LOW_BALANCE_USD): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// ── #802 / #818: quiet / NO_COLOR decorative-output suppression ────────────────

/**
 * Decide whether decorative output (spinners, "✓ saved" lines, the low-balance
 * banner) should be suppressed (#802/#818) so JSON consumers and cron jobs get
 * clean output. True when `--quiet`/`-q`, `NO_COLOR`, or non-TTY.
 */
export function shouldSuppressDecorative(opts: { quiet?: boolean; noColor?: boolean; isTTY?: boolean }): boolean {
  if (opts.quiet) return true;
  if (opts.noColor) return true;
  if (opts.isTTY === false) return true;
  return false;
}

// ── #815: `-o -` stdout target detection ──────────────────────────────────────

/**
 * Detect whether an `-o`/`--output` value targets stdout (`-`) rather than a file
 * (#815) so binary commands (tts/image/speech) can stream bytes to a pipe.
 */
export function isStdoutTarget(output: string | undefined): boolean {
  return output === '-';
}

// ── #801 / #819 / #855: global `--json` flag handling ─────────────────────────

/**
 * Detect a global `--json` flag for read commands (#801) so any command can emit
 * machine-readable output. Pure: scans argv for the flag, ignoring its position.
 */
export function hasJsonFlag(args: string[]): boolean {
  return args.includes('--json');
}

/**
 * Serialise a value for `--json` output (#801/#855). Stable 2-space indentation,
 * and `undefined` is normalised to `null` so the top-level value is always valid
 * JSON. Kept here (not inline `JSON.stringify`) so every command formats alike.
 */
export function jsonOutput(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, null, 2);
}

// ── #803: per-subcommand `--help` / `-h` detection ────────────────────────────

/**
 * Detect a `-h`/`--help` request anywhere in a command's argv (#803).
 *
 * Per-command help today only fires for keys present in the `HELP` map; commands
 * like `balance`, `config`, `whoami`, `ping`, `voices` have no entry so
 * `ai-gateway balance --help` falls through and *runs* the command. A command
 * can call this first and print a one-liner instead of executing.
 */
export function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

// ── #811: group `gpu` subcommands by lifecycle for help ───────────────────────

/** A grouped view of `gpu` subcommands for a less wall-of-text help screen (#811). */
export interface GpuSubcommandGroups {
  Lifecycle: string[];
  Cost: string[];
  Dev: string[];
  Advanced: string[];
}

/**
 * Classify the (long) flat list of `gpu` subcommands into lifecycle groups (#811)
 * so the help text can render "Lifecycle / Cost / Dev / Advanced" sections. Pure —
 * returns the grouping; the caller does the rendering. Unknown commands fall into
 * `Advanced` so nothing is silently dropped.
 */
export function groupGpuSubcommands(subcommands: readonly string[]): GpuSubcommandGroups {
  const LIFECYCLE = new Set(['status', 'deploy', 'stop', 'resume', 'terminate', 'list', 'logs', 'inspect']);
  const COST = new Set(['offers', 'best', 'sweep', 'preflight']);
  const DEV = new Set(['ssh', 'patch', 'commit', 'pull', 'dev', 'push']);
  const groups: GpuSubcommandGroups = { Lifecycle: [], Cost: [], Dev: [], Advanced: [] };
  for (const cmd of subcommands) {
    if (LIFECYCLE.has(cmd)) groups.Lifecycle.push(cmd);
    else if (COST.has(cmd)) groups.Cost.push(cmd);
    else if (DEV.has(cmd)) groups.Dev.push(cmd);
    else groups.Advanced.push(cmd);
  }
  return groups;
}

// ── #846: spot / interruptible price savings ──────────────────────────────────

/**
 * Compute the % savings of a spot/interruptible price vs the on-demand price (#846)
 * so `gpu offers` can flag the cheaper interruptible option. Returns `null` when
 * spot is missing/zero or not actually cheaper than on-demand.
 *
 * @returns `{ savingsPct, spotPerHr, onDemandPerHr }` or `null`
 */
export function computeSpotSavings(
  onDemandPerHr: number | undefined,
  spotPerHr: number | undefined,
): { savingsPct: number; spotPerHr: number; onDemandPerHr: number } | null {
  const od = typeof onDemandPerHr === 'number' && Number.isFinite(onDemandPerHr) ? onDemandPerHr : NaN;
  const sp = typeof spotPerHr === 'number' && Number.isFinite(spotPerHr) ? spotPerHr : NaN;
  if (!(od > 0) || !(sp > 0) || sp >= od) return null;
  const savingsPct = Math.round(((od - sp) / od) * 100);
  return { savingsPct, spotPerHr: sp, onDemandPerHr: od };
}

// ── #847: per-request cost estimate for chat / benchmark ──────────────────────

/**
 * Estimate the dollar cost of a single request from token usage and a per-1M-token
 * price (#847) so `chat`/`benchmark` can surface spend at the point of use. Self
 * contained (no cross-module import of the pricing table) — the caller supplies the
 * rate it looked up. Returns `null` when usage/pricing is unavailable.
 *
 * @param usage          token counts (`promptTokens`/`completionTokens`)
 * @param pricePer1M     `{ input, output }` USD per 1,000,000 tokens
 */
export function estimateChatCostUsd(
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
  pricePer1M: { input?: number; output?: number } | undefined,
): number | null {
  if (!usage || !pricePer1M) return null;
  const inTok = Number(usage.promptTokens);
  const outTok = Number(usage.completionTokens);
  const inRate = Number(pricePer1M.input);
  const outRate = Number(pricePer1M.output);
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  if (!Number.isFinite(inRate) && !Number.isFinite(outRate)) return null;
  const cost =
    (Number.isFinite(inTok) && Number.isFinite(inRate) ? (inTok / 1_000_000) * inRate : 0) +
    (Number.isFinite(outTok) && Number.isFinite(outRate) ? (outTok / 1_000_000) * outRate : 0);
  return Number.isFinite(cost) ? cost : null;
}

// ── #856: gateway URL env precedence + provenance ─────────────────────────────

/** The env var names that influence the resolved gateway URL, in precedence order. */
export const URL_ENV_PRECEDENCE = ['AI_GATEWAY_URL', 'GATEWAY_URL', 'PORT'] as const;

/**
 * Resolve the gateway URL from the environment AND report which source won (#856),
 * mirroring `getConfig()`'s precedence so `config` can print provenance. `PORT`
 * only contributes a default `http://localhost:<port>` (not a full URL).
 *
 * @returns `{ url, source }` — `source` is `'default'` when nothing is set.
 */
export function resolveGatewayUrlFromEnv(
  env: Record<string, string | undefined>,
  defaultUrl = 'http://localhost:4000',
): { url: string; source: string } {
  if (env.AI_GATEWAY_URL) return { url: env.AI_GATEWAY_URL, source: 'AI_GATEWAY_URL' };
  if (env.GATEWAY_URL) return { url: env.GATEWAY_URL, source: 'GATEWAY_URL' };
  if (env.PORT && /^\d+$/.test(env.PORT)) {
    const port = env.PORT;
    return { url: port === '4000' ? defaultUrl : `http://localhost:${port}`, source: 'PORT' };
  }
  return { url: defaultUrl, source: 'default' };
}

// ── #855: machine-readable config / whoami payloads ───────────────────────────

/**
 * Build the `{ url, keySource, connected, ... }` payload for `config --json` /
 * `whoami --json` (#855) so CI provisioning scripts get structured identity +
 * connectivity instead of human-only key/value lines.
 */
export function buildConfigJson(input: {
  url: string;
  urlSource?: string;
  keySource: string;
  keyMasked: string;
  connected?: boolean;
  userId?: string;
}): Record<string, unknown> {
  return {
    url: input.url,
    urlSource: input.urlSource ?? 'default',
    keySource: input.keySource,
    key: input.keyMasked,
    connected: input.connected ?? false,
    ...(input.userId ? { userId: input.userId } : {}),
  };
}

// ── #859: `.env` walk-up discovery description ─────────────────────────────────

/** How many parent directories `loadCwdEnv` walks up looking for a `.env`. */
export const ENV_WALK_UP_LEVELS = 6;

/**
 * Describe the `.env` walk-up discovery (#859) for help / `config` output so the
 * (otherwise invisible) per-project key resolution is predictable. When a found
 * path is supplied, names it; otherwise states the search depth.
 */
export function describeEnvDiscovery(foundPath?: string): string {
  if (foundPath) return `Loaded .env from ${foundPath}`;
  return `No .env found (searched cwd and up to ${ENV_WALK_UP_LEVELS} parent directories)`;
}

// ── #860: warn when no API key but gateway likely requires one ─────────────────

/**
 * Decide whether to warn that no API key is configured (#860). When the target is
 * a remote (non-localhost) gateway and no key is set, requests will 401 with a raw
 * error; warn up front. Localhost is exempt (the server allows unauthenticated
 * localhost when no key is configured).
 */
export function needsApiKeyWarning(opts: { key: string; isLocal: boolean }): boolean {
  return !opts.key && !opts.isLocal;
}

/**
 * Determine whether a URL points at the local machine (#860 helper). Pure,
 * mirrors the CLI's `isLocalUrl`. Malformed URLs are treated as non-local so the
 * caller errs toward warning.
 */
export function isLocalGatewayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // URL normalises IPv6 hosts with brackets (e.g. "[::1]"); strip them.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// WAVE 4 — additional localized CLI helpers (docs/optimizations/09-cli-sdk-dx.md)
// ════════════════════════════════════════════════════════════════════════════

// ── #810: shell-completion script generation ──────────────────────────────────

export type CompletionShell = 'bash' | 'zsh' | 'fish';

/** Parse/validate the `completion <shell>` argument (#810). */
export function parseCompletionShell(raw: string | undefined): { value: CompletionShell } | { error: string } {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'bash' || v === 'zsh' || v === 'fish') return { value: v };
  return { error: `Unknown shell "${raw ?? ''}" (expected bash|zsh|fish)` };
}

/**
 * Emit a shell-completion script for the `ai-gateway` CLI (#810). A manual
 * switch/case CLI with ~30 commands and a deep `gpu` subtree has zero discovery
 * help; this returns a static completion script the caller writes to stdout
 * (`ai-gateway completion bash`). Pure — no I/O.
 *
 * @param shell    target shell
 * @param commands top-level command names to complete
 * @param prog     program name (default `ai-gateway`)
 */
export function generateCompletionScript(
  shell: CompletionShell,
  commands: readonly string[],
  prog = 'ai-gateway',
): string {
  const words = commands.join(' ');
  if (shell === 'bash') {
    return [
      `# ${prog} bash completion`,
      `_${prog.replace(/-/g, '_')}() {`,
      `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
      `  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )`,
      `}`,
      `complete -F _${prog.replace(/-/g, '_')} ${prog}`,
    ].join('\n');
  }
  if (shell === 'zsh') {
    return [
      `#compdef ${prog}`,
      `_${prog.replace(/-/g, '_')}() {`,
      `  local -a cmds; cmds=(${commands.map(c => `'${c}'`).join(' ')})`,
      `  _describe '${prog} command' cmds`,
      `}`,
      `compdef _${prog.replace(/-/g, '_')} ${prog}`,
    ].join('\n');
  }
  // fish
  return commands
    .map(c => `complete -c ${prog} -n '__fish_use_subcommand' -a '${c}'`)
    .join('\n');
}

// ── #813: normalise live TTS voices (vs the hardcoded fallback) ────────────────

export interface NormalizedVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
}

/**
 * Normalise a `/v1/tts/voices` payload into a stable list (#813) so `voices`
 * reflects the configured provider instead of a hardcoded set. Accepts the raw
 * `voices` array (objects or bare strings) and de-dupes by id. Returns `[]` for a
 * missing/garbage payload so the caller can fall back to its static list.
 */
export function normalizeVoices(raw: unknown): NormalizedVoice[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NormalizedVoice[] = [];
  for (const item of raw) {
    let v: NormalizedVoice | undefined;
    if (typeof item === 'string') {
      if (item.trim()) v = { id: item.trim(), name: item.trim() };
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name : undefined;
      if (id) {
        v = {
          id,
          name: typeof o.name === 'string' ? o.name : id,
          language: typeof o.language === 'string' ? o.language : undefined,
          gender: typeof o.gender === 'string' ? o.gender : undefined,
        };
      }
    }
    if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
  }
  return out;
}

// ── #819: `media test` machine-readable summary ───────────────────────────────

/**
 * Build a machine-readable summary for `media test --json` (#819) and the exit
 * code that CI should use (0 = all pass, 1 = any failure). Pure — caller prints
 * the JSON and exits with the returned code.
 */
export function buildMediaTestSummary(results: { image: boolean; audio: boolean }): {
  json: { image: boolean; audio: boolean; ok: boolean };
  exitCode: number;
} {
  const ok = results.image && results.audio;
  return { json: { image: results.image, audio: results.audio, ok }, exitCode: ok ? 0 : EXIT_RUNTIME };
}

// ── #820: native 16kHz silence WAV (no python3 subprocess) ────────────────────

/**
 * Generate a mono 16-bit PCM WAV of silence in pure TypeScript (#820) so
 * `benchmark` no longer shells out to `python3 -c` (which crashes on a host
 * without python3). Returns the full WAV byte stream (44-byte header + samples).
 *
 * @param seconds     duration in seconds (default 1)
 * @param sampleRate  sample rate in Hz (default 16000 — Whisper's native rate)
 */
export function makeSilenceWav(seconds = 1, sampleRate = 16_000): Uint8Array {
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.floor(sampleRate) : 16_000;
  const numSamples = Math.floor(sec * rate);
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // audio format = PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, rate, true);        // sample rate
  view.setUint32(28, rate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true);        // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // samples already zero-initialised (silence)
  return new Uint8Array(buf);
}

// ── #844: dedicated cost / spend summary ──────────────────────────────────────

export interface CostSummaryInput {
  /** Per-instance hourly costs of currently running GPU instances. */
  instanceHourly: readonly number[];
  /** Today's GPU spend so far (USD), if known. */
  dailySpendUsd?: number;
  /** Per-provider balances (USD) keyed by provider name. */
  balances?: Record<string, number>;
}

export interface CostSummary {
  /** Combined hourly burn across all running instances. */
  hourlyBurnUsd: number;
  /** Number of instances contributing to the burn. */
  runningInstances: number;
  /** Projected 24h cost at the current burn rate. */
  projectedDailyUsd: number;
  /** Projected 30-day cost at the current burn rate. */
  projectedMonthlyUsd: number;
  /** Echoed daily spend so far (0 when unknown). */
  dailySpendUsd: number;
  /** Sum of all known provider balances. */
  totalBalanceUsd: number;
}

/**
 * Summarise GPU spend for a dedicated `ai-gateway cost` view (#844): combined
 * hourly burn, projected daily/monthly cost, and total balance. Pure — the caller
 * fetches `gpu list` + `balance` and feeds the numbers in.
 */
export function buildCostSummary(input: CostSummaryInput): CostSummary {
  let hourlyBurnUsd = 0;
  let runningInstances = 0;
  for (const h of input.instanceHourly) {
    if (Number.isFinite(h) && h > 0) { hourlyBurnUsd += h; runningInstances++; }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const totalBalanceUsd = input.balances
    ? Object.values(input.balances).reduce((a, b) => (Number.isFinite(b) ? a + b : a), 0)
    : 0;
  return {
    hourlyBurnUsd: round2(hourlyBurnUsd),
    runningInstances,
    projectedDailyUsd: round2(hourlyBurnUsd * 24),
    projectedMonthlyUsd: round2(hourlyBurnUsd * 24 * 30),
    dailySpendUsd: Number.isFinite(input.dailySpendUsd as number) ? round2(input.dailySpendUsd as number) : 0,
    totalBalanceUsd: round2(totalBalanceUsd),
  };
}

// ── #848: idle / auto-stop reassurance note ───────────────────────────────────

/** Default idle auto-stop window (minutes), mirroring IDLE_TIMEOUT_MIN. */
export const DEFAULT_IDLE_STOP_MIN = 15;
/** Default auto-destroy window after stop (hours). */
export const DEFAULT_AUTO_DESTROY_HOURS = 2;

/**
 * One-line reassurance that a freshly-deployed pod won't bill forever (#848):
 * "auto-stops after 15m idle, auto-destroys 2h later". Pure string builder so the
 * deploy command can print it without restating the policy inline.
 */
export function idleStopNote(idleMin = DEFAULT_IDLE_STOP_MIN, destroyHours = DEFAULT_AUTO_DESTROY_HOURS): string {
  return `Pod auto-stops after ${idleMin}m idle, then auto-destroys ${destroyHours}h later (no charges while stopped).`;
}

// ── #849: zombie-pod cost annotation ──────────────────────────────────────────

/**
 * Annotate a `running`-but-unreachable ("zombie") pod with its financial stakes
 * (#849) so the user understands the cost of leaving it. Returns the per-hour and
 * projected-daily burn plus a ready-to-print warning, or `null` when the cost is
 * unknown/zero (nothing to warn about).
 */
export function annotateZombieCost(costPerHr: unknown): { hourlyUsd: number; dailyUsd: number; warning: string } | null {
  const v = typeof costPerHr === 'number' ? costPerHr : Number(costPerHr);
  if (!Number.isFinite(v) || v <= 0) return null;
  const hourlyUsd = Math.round(v * 100) / 100;
  const dailyUsd = Math.round(v * 24 * 100) / 100;
  return {
    hourlyUsd,
    dailyUsd,
    warning: `ZOMBIE pod burning $${hourlyUsd.toFixed(2)}/hr ($${dailyUsd.toFixed(2)}/day) — terminate to stop charges.`,
  };
}

// ── #850: discover sibling binaries from the main CLI ──────────────────────────

export interface SiblingBinary {
  name: string;
  summary: string;
}

/**
 * The companion binaries shipped alongside `ai-gateway` (#850) so the main help
 * can point at them (e.g. the cost-audit orphan sweep). Pure metadata — the
 * caller renders it under a "See also" section.
 */
export function listSiblingBinaries(): SiblingBinary[] {
  return [
    { name: 'ai-gateway-cost-audit', summary: 'Sweep & terminate orphaned GPU instances (cost leak cleanup).' },
  ];
}

// ── #891: scripting contract (exit codes + JSON-capable commands) ──────────────

export interface ScriptingContract {
  exitCodes: Array<{ code: number; meaning: string }>;
  jsonCommands: string[];
}

/**
 * Describe the CLI's scripting contract (#891): the exit-code scheme and which
 * commands honour `--json`. Pure metadata so a `docs/cli` page or `--help` footer
 * can render a reliable automation reference instead of leaving it undocumented.
 */
export function describeScriptingContract(jsonCommands: readonly string[]): ScriptingContract {
  return {
    exitCodes: [
      { code: 0, meaning: 'success' },
      { code: EXIT_RUNTIME, meaning: 'runtime / HTTP / network error' },
      { code: EXIT_USAGE, meaning: 'usage error (bad args or flags)' },
      { code: 130, meaning: 'interrupted (Ctrl-C / SIGINT)' },
    ],
    jsonCommands: [...jsonCommands].sort(),
  };
}

// ── #899: SIGINT (Ctrl-C) clean-exit handling ─────────────────────────────────

/** Conventional exit code for a process terminated by SIGINT (128 + 2). */
export const EXIT_SIGINT = 130;

/**
 * Build the clean-exit payload for a Ctrl-C during a streaming/polling loop
 * (#899): a trailing newline to flush the half-written line, an optional summary,
 * and exit code 130. Pure — the caller writes `flush`+`summary` then exits.
 */
export function buildInterruptExit(summary?: string): { flush: string; summary?: string; exitCode: number } {
  return { flush: '\n', summary: summary && summary.trim() ? summary : undefined, exitCode: EXIT_SIGINT };
}

// ── #900: deploy poller — distinguish timeout from completion ──────────────────

export type DeployPollOutcome = 'ready' | 'error' | 'timeout';

/**
 * Classify the terminal outcome of the deploy status poll loop (#900). Today the
 * loop simply falls through when it exhausts iterations without `ready`/`error`,
 * printing nothing and exiting 0 — so scripts assume success. This returns an
 * explicit outcome + message + exit code so a timeout is reported and non-zero.
 *
 * @param lastStatus the last status seen, or undefined if the loop never saw one
 * @param exhausted  whether the poll loop ran out of iterations
 */
export function classifyDeployPollOutcome(
  lastStatus: string | undefined,
  exhausted: boolean,
): { outcome: DeployPollOutcome; message: string; exitCode: number } {
  if (lastStatus === 'ready') {
    return { outcome: 'ready', message: 'GPU ready.', exitCode: 0 };
  }
  if (lastStatus === 'error') {
    return { outcome: 'error', message: 'Deploy failed.', exitCode: EXIT_RUNTIME };
  }
  if (exhausted) {
    return {
      outcome: 'timeout',
      message: 'Still deploying after the poll window — check `ai-gateway gpu status`.',
      exitCode: EXIT_RUNTIME,
    };
  }
  // Not exhausted and not terminal → caller should keep polling.
  return { outcome: 'timeout', message: 'Deploy still in progress.', exitCode: EXIT_RUNTIME };
}

// ── #812: surface the auto-start-server behaviour ────────────────────────────

/**
 * One-line, NO_COLOR-friendly note explaining why the CLI is auto-starting a
 * local gateway and how to disable it (#812). The localhost auto-start spawns
 * `server/ws-server.ts` detached, which is powerful but surprising; printing the
 * reasoning + the escape hatch on first spawn removes the surprise.
 *
 * @param port the port the local gateway is being started on
 */
export function autoStartNote(port: string | number): string {
  return (
    `Auto-starting a local gateway on port ${port} ` +
    `(URL points at localhost and nothing is listening). ` +
    `To use a remote gateway instead, set AI_GATEWAY_URL; ` +
    `stop this one with \`ai-gateway server stop\`.`
  );
}

// ── #853: dry-run / estimate-only mode for `gpu deploy` ──────────────────────

export interface DeployDryRun {
  /** Whether any dry-run / estimate-only / preflight-only flag was supplied. */
  dryRun: boolean;
  /** The canonical flag that was matched (for messaging), or undefined. */
  flag?: string;
}

/** Flags that put `gpu deploy` into estimate-only mode (no provisioning), mirroring
 *  `gpu finetune`'s `--dry-run`/`--no-estimate`/`--preflight-only` family (#853). */
export const DEPLOY_DRY_RUN_FLAGS = ['--dry-run', '--estimate-only', '--preflight-only'] as const;

/**
 * Detect whether `gpu deploy` was asked to run preflight + print the would-be
 * cost WITHOUT provisioning (#853). `gpu deploy` currently has no such mode even
 * though `gpu finetune` does. Pure so it is unit-testable without the CLI.
 */
export function parseDeployDryRun(args: string[]): DeployDryRun {
  for (const flag of DEPLOY_DRY_RUN_FLAGS) {
    if (args.includes(flag)) return { dryRun: true, flag };
  }
  return { dryRun: false };
}

/**
 * Human-readable summary line for a dry-run deploy (#853), given the preflight
 * estimate. Keeps the messaging in one tested place; the caller just prints it
 * and exits 0 without calling `/v1/gpu/deploy`.
 */
export function describeDeployDryRun(estimate: {
  gpuType?: string;
  pricePerHrUsd?: number;
  provider?: string;
}): string {
  const parts: string[] = ['Dry run — no GPU provisioned.'];
  if (estimate.gpuType) parts.push(`gpu=${estimate.gpuType}`);
  if (estimate.provider) parts.push(`provider=${estimate.provider}`);
  if (typeof estimate.pricePerHrUsd === 'number' && Number.isFinite(estimate.pricePerHrUsd)) {
    parts.push(`est=$${estimate.pricePerHrUsd.toFixed(2)}/hr`);
  } else {
    parts.push('est=unknown');
  }
  return parts.join('  ');
}

// ── #814: use the dedicated /v1/detect-language endpoint ─────────────────────

export interface DetectLanguageRequest {
  endpoint: string;
  method: 'POST';
  body: { text: string };
}

/**
 * Build the request for the dedicated language-detection endpoint (#814). The
 * CLI currently re-implements detection via a hand-rolled chat completion, which
 * is costlier and inconsistent with the SDK's `detectLanguage()`. This targets
 * `/v1/detect-language` instead. Pure — returns the request shape for the caller.
 */
export function buildDetectLanguageRequest(text: string): DetectLanguageRequest {
  return { endpoint: '/v1/detect-language', method: 'POST', body: { text: text ?? '' } };
}

/**
 * Normalise a `/v1/detect-language` response (#814) into a stable shape, tolerant
 * of the legacy chat-derived payloads (which returned a bare language string or a
 * `detected_language` field) so the CLI output stays consistent across providers.
 */
export function parseDetectLanguageResponse(
  raw: unknown,
): { language: string; confidence?: number } {
  if (typeof raw === 'string') {
    const lang = raw.trim();
    return { language: lang || 'unknown' };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const lang =
      (typeof o.language === 'string' && o.language) ||
      (typeof o.detected_language === 'string' && o.detected_language) ||
      (typeof o.lang === 'string' && o.lang) ||
      '';
    const conf = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
      ? o.confidence
      : undefined;
    return { language: lang.trim() || 'unknown', ...(conf !== undefined ? { confidence: conf } : {}) };
  }
  return { language: 'unknown' };
}
