/**
 * Fail-fast preflight checks — run BEFORE provisioning a GPU.
 *
 * validateSpec (spec.ts) covers schema/shape. This module covers *live* checks
 * that would otherwise only surface on the pod, minutes and dollars into a run:
 *   - HF dataset / model existence + accessibility
 *   - HF token write-access when a push target is set
 *   - R2/S3 creds present when r2Bucket is set (the silent-data-loss bug)
 *   - dataset has prep input (metadata.jsonl/train.jsonl) when a preset needs it
 *   - trainer script exists locally for custom runs
 *
 * Pure HTTP via injectable fetch — no provider SDKs, no src→server import.
 */

import { existsSync } from 'node:fs';

import type { FinetuneOpts } from './types.js';
import { loadPreset } from './spec.js';
import { resolveR2Creds } from './run.js';

export type PreflightStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightResult {
  /** false when any check failed. warn-only results stay ok=true. */
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to fs.existsSync. */
  fileExists?: (path: string) => boolean;
}

const HF_API = 'https://huggingface.co/api';

/** `hf://owner/repo` (or `owner/repo`) → `owner/repo`; undefined passthrough. */
function stripHf(ref?: string): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^hf:\/\//, '').replace(/\/+$/, '').trim() || undefined;
}

function authHeaders(token: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Probe an HF repo (dataset|model) for existence/accessibility.
 * 200 → ok; 404 → fail (not found); 401/403 → fail (private, token lacks access).
 * Network error → warn (don't block a run on a flaky link).
 */
async function checkHfRepo(
  kind: 'dataset' | 'model',
  ref: string,
  token: string,
  doFetch: typeof fetch,
): Promise<PreflightCheck> {
  const repo = stripHf(ref)!;
  const name = `HF ${kind} ${repo}`;
  const base = kind === 'dataset' ? `${HF_API}/datasets` : `${HF_API}/models`;
  try {
    const res = await doFetch(`${base}/${repo}`, { headers: authHeaders(token) });
    if (res.status === 200) return { name, status: 'ok', detail: 'reachable' };
    if (res.status === 404) return { name, status: 'fail', detail: 'not found (404) — check owner/repo' };
    if (res.status === 401 || res.status === 403) {
      return {
        name, status: 'fail',
        detail: token
          ? `private/forbidden (${res.status}) — token lacks read access`
          : `private (${res.status}) — set HF_TOKEN with read access`,
      };
    }
    return { name, status: 'warn', detail: `unexpected HTTP ${res.status} — could not verify` };
  } catch (e) {
    return { name, status: 'warn', detail: `could not verify (network: ${(e as Error).message})` };
  }
}

/**
 * When a push target (pushToHf/hfBase) is set, verify the token can write.
 * No token → fail. whoami 401 → fail (invalid). role 'read' → fail (read-only).
 * Otherwise ok (write/admin/fine-grained tokens pass; runtime create_repo handles repo).
 */
async function checkHfWriteAccess(token: string, doFetch: typeof fetch): Promise<PreflightCheck> {
  const name = 'HF write access';
  if (!token) return { name, status: 'fail', detail: 'push target set but no HF_TOKEN — cannot upload weights' };
  try {
    const res = await doFetch(`${HF_API}/whoami-v2`, { headers: authHeaders(token) });
    if (res.status === 401) return { name, status: 'fail', detail: 'HF_TOKEN invalid (whoami 401)' };
    if (res.status !== 200) return { name, status: 'warn', detail: `whoami HTTP ${res.status} — could not verify role` };
    const body = (await res.json()) as { auth?: { accessToken?: { role?: string } } };
    const role = body?.auth?.accessToken?.role;
    if (role === 'read') return { name, status: 'fail', detail: 'HF_TOKEN is read-only — push will fail. Use a write token.' };
    return { name, status: 'ok', detail: role ? `token role: ${role}` : 'token valid (fine-grained)' };
  } catch (e) {
    return { name, status: 'warn', detail: `could not verify (network: ${(e as Error).message})` };
  }
}

/**
 * When a preset declares a prepareScript, the dataset must carry a
 * metadata.jsonl/train.jsonl for auto-prep. List the repo tree and warn if absent.
 */
async function checkDatasetPrepInput(ref: string, token: string, doFetch: typeof fetch): Promise<PreflightCheck> {
  const repo = stripHf(ref)!;
  const name = 'dataset prep input';
  try {
    const res = await doFetch(`${HF_API}/datasets/${repo}/tree/main`, { headers: authHeaders(token) });
    if (res.status !== 200) return { name, status: 'warn', detail: `tree HTTP ${res.status} — could not list files` };
    const tree = (await res.json()) as Array<{ path?: string; type?: string }>;
    const paths = tree.map(t => (t.path || '').split('/').pop());
    const hasMeta = paths.includes('metadata.jsonl') || paths.includes('train.jsonl');
    return hasMeta
      ? { name, status: 'ok', detail: 'metadata.jsonl/train.jsonl present' }
      : {
          name, status: 'warn',
          detail: 'no metadata.jsonl/train.jsonl at repo root — auto-prep may fail (set prepare:skip if pre-encoded)',
        };
  } catch (e) {
    return { name, status: 'warn', detail: `could not verify (network: ${(e as Error).message})` };
  }
}

/**
 * Run all applicable preflight checks. Pure HTTP + local fs; no GPU spend.
 * @param opts   resolved finetune opts (post project/preset merge)
 * @param env    process-env-like record (HF_TOKEN, B2_ or STORAGE_ creds for R2)
 */
export async function preflightChecks(
  opts: Partial<FinetuneOpts>,
  env: Record<string, string | undefined> = process.env,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const fileExists = deps.fileExists ?? existsSync;
  const token = env.HF_TOKEN || '';
  const checks: PreflightCheck[] = [];
  const preset = loadPreset(opts.type ?? '');

  // 1. HF dataset reachable
  if (opts.dataset?.startsWith('hf://')) {
    checks.push(await checkHfRepo('dataset', opts.dataset, token, doFetch));
  }
  // 2. HF model reachable
  if (opts.model?.startsWith('hf://')) {
    checks.push(await checkHfRepo('model', opts.model, token, doFetch));
  }
  // 3. HF write access when pushing
  if (opts.pushToHf || opts.hfBase) {
    checks.push(await checkHfWriteAccess(token, doFetch));
  }
  // 4. dataset prep input when preset auto-preps
  const prepareDirective = opts.prepare ?? 'auto';
  if (opts.dataset?.startsWith('hf://') && preset?.manifest?.prepareScript && prepareDirective === 'auto') {
    checks.push(await checkDatasetPrepInput(opts.dataset, token, doFetch));
  }
  // 5. R2 creds present when r2Bucket/resumeFromR2 set — FAIL (silent data loss)
  if (opts.r2Bucket || opts.resumeFromR2) {
    const { hasCreds } = resolveR2Creds(env);
    checks.push(hasCreds
      ? { name: 'R2 credentials', status: 'ok', detail: 'present (B2_*/STORAGE_*)' }
      : {
          name: 'R2 credentials', status: 'fail',
          detail: 'r2Bucket/resumeFromR2 set but no R2 creds (B2_ACCOUNT_ID/B2_APPLICATION_KEY/B2_ENDPOINT) — backup would silently no-op',
        });
  }
  // 6. Trainer script exists locally (custom runs / explicit script, no preset)
  if (opts.scriptPath && !preset) {
    checks.push(fileExists(opts.scriptPath)
      ? { name: 'trainer script', status: 'ok', detail: opts.scriptPath }
      : { name: 'trainer script', status: 'fail', detail: `not found: ${opts.scriptPath}` });
  }

  return { ok: !checks.some(c => c.status === 'fail'), checks };
}
