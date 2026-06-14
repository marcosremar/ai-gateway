/**
 * ImageBuildService — main orchestrator
 *
 * 1. Resolve GitHub token
 * 2. Ensure repo exists (create if needed)
 * 3. Push directory + generated workflow via Git Trees API
 * 4. Find the triggered Actions run
 * 5. Poll until complete
 * 6. Update local catalog
 */

import { existsSync, realpathSync } from 'fs';
import { basename, resolve as resolvePath, sep } from 'path';
import type { ImageBuildSpec, ImageBuildRecord, ImageBuildStatus } from './types';
import { loadGitHubToken } from './github-auth';
import { ensureRepo, pushDirectoryAndBuild, findRunForCommit, getRunStatus } from './github-repo';
import {
  generateBuildId,
  addBuildRecord,
  updateBuildRecord,
  getBuildRecord,
} from './image-catalog';

export interface BuildStartResult {
  buildId: string;
  repoUrl: string;
  status: ImageBuildStatus;
  message: string;
}

/**
 * Compute the next build-status poll delay with exponential backoff (#968).
 *
 * A fixed 15s poll over a 45-minute build burns up to ~180 GitHub API calls.
 * After the first few polls we back off geometrically up to a cap, cutting the
 * call count roughly in half for long builds while staying responsive early on.
 *
 * Pure; exported for tests.
 */
export function nextBuildPollDelayMs(
  attempt: number,
  baseMs = 15_000,
  maxMs = 60_000,
): number {
  if (attempt <= 0) return baseMs;
  const delay = baseMs * Math.pow(1.5, attempt);
  return Math.min(Math.round(delay), maxMs);
}

/**
 * Map build platforms → an arch-variant tag suffix (#971).
 *
 * CLAUDE.md mandates the `:blackwell` image (CUDA 12.8.1) for the RTX 5090
 * (Blackwell). `startBuild` previously always tagged `latest` with no variant
 * awareness. When a caller targets a Blackwell-capable build (sm_120 / explicit
 * `linux/amd64+blackwell` marker), surface a `blackwell` suffix so the published
 * image is selectable by the deploy path.
 *
 * Returns `''` for the default (no suffix). Pure; exported for tests.
 */
export function tagSuffixForPlatforms(platforms: string | undefined): string {
  const p = (platforms ?? '').toLowerCase();
  if (p.includes('blackwell') || p.includes('sm_120') || p.includes('sm120')) {
    return 'blackwell';
  }
  return '';
}

/**
 * Resolve the final Docker tag from a requested tag + platforms (#971).
 *
 * - No variant → the requested tag unchanged.
 * - Blackwell variant + `latest` → `blackwell` (the canonical Blackwell tag).
 * - Blackwell variant + custom tag → `<tag>-blackwell` so the variant is
 *   never silently collapsed into a non-variant tag.
 *
 * Pure; exported for tests.
 */
export function resolveImageTag(requestedTag: string | undefined, platforms: string | undefined): string {
  const tag = (requestedTag ?? 'latest').trim() || 'latest';
  const suffix = tagSuffixForPlatforms(platforms);
  if (!suffix) return tag;
  if (tag === 'latest') return suffix;
  if (tag.endsWith(`-${suffix}`) || tag === suffix) return tag;
  return `${tag}-${suffix}`;
}

/**
 * Terminal build statuses — a build in one of these will never change again (#970).
 *
 * Centralizes the `success | failed | cancelled` check that was inlined in the
 * pollers, so the loop-exit condition can't drift from the record updates.
 */
export const TERMINAL_BUILD_STATUSES: ReadonlySet<ImageBuildStatus> = new Set<ImageBuildStatus>([
  'success',
  'failed',
  'cancelled',
]);

/** True when a build status is terminal (no further polling needed). Pure. */
export function isTerminalBuildStatus(status: ImageBuildStatus): boolean {
  return TERMINAL_BUILD_STATUSES.has(status);
}

export function resolveAllowedBuildRoots(): string[] {
  const roots = new Set<string>();
  const addRoot = (input: string | undefined) => {
    const trimmed = input?.trim();
    if (!trimmed) return;
    const resolved = resolvePath(trimmed);
    if (!existsSync(resolved)) return;
    try {
      roots.add(realpathSync(resolved));
    } catch {
      // Ignore invalid roots — the operator can fix the env var without crashing startup.
    }
  };

  addRoot(process.cwd());

  const configuredRoots = process.env.AI_GATEWAY_BUILD_ROOTS;
  if (configuredRoots) {
    for (const entry of configuredRoots.split(/[\n,]+/)) {
      addRoot(entry);
    }
  }

  return Array.from(roots);
}

export function validateBuildContextPath(dirPath: string, allowedRoots = resolveAllowedBuildRoots()): string {
  const requestedPath = resolvePath(dirPath);
  if (!existsSync(requestedPath)) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const realDirPath = realpathSync(requestedPath);
  const isAllowed = allowedRoots.some((root) => {
    if (realDirPath === root) return true;
    return realDirPath.startsWith(`${root}${sep}`);
  });

  if (!isAllowed) {
    throw new Error(
      `Build directory must be inside an allowed build root. Allowed roots: ${allowedRoots.join(', ') || process.cwd()}`,
    );
  }

  return realDirPath;
}

/**
 * Start an image build asynchronously.
 * Returns immediately with a build ID — call pollBuild() to track progress.
 */
export async function startBuild(spec: ImageBuildSpec): Promise<BuildStartResult> {
  const tokenData = loadGitHubToken();
  if (!tokenData) {
    throw new Error(
      'Not authenticated with GitHub. Run: ai-gateway docker auth',
    );
  }

  const absDir = validateBuildContextPath(spec.dirPath);
  if (!existsSync(`${absDir}/Dockerfile`) && !existsSync(`${absDir}/dockerfile`)) {
    throw new Error(`No Dockerfile found in ${absDir}`);
  }

  const name = spec.name ?? basename(absDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const platforms = spec.platforms ?? 'linux/amd64';
  // Apply the Blackwell arch-variant suffix when targeting a Blackwell build (#971).
  const tag = resolveImageTag(spec.tag, platforms);
  const repoName = spec.repoName ?? `ai-gateway-img-${name}`;
  const isPublic = spec.isPublic ?? false;

  const buildId = generateBuildId();
  const owner = tokenData.username;

  // Reserve catalog slot immediately
  const record: ImageBuildRecord = {
    id: buildId,
    name,
    tag,
    image: '',
    repoUrl: `https://github.com/${owner}/${repoName}`,
    owner,
    repoName,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platforms,
  };
  addBuildRecord(record);

  // Run build in background (don't await)
  _runBuild(buildId, tokenData.accessToken, owner, repoName, absDir, name, tag, platforms, isPublic).catch(
    (err: Error) => {
      updateBuildRecord(buildId, {
        status: 'failed',
        error: err.message,
        completedAt: Date.now(),
      });
    },
  );

  return {
    buildId,
    repoUrl: record.repoUrl,
    status: 'pending',
    message: `Build started. Repo: https://github.com/${owner}/${repoName}`,
  };
}

/** Internal: runs the full build pipeline, updates catalog at each step */
async function _runBuild(
  buildId: string,
  token: string,
  owner: string,
  repoName: string,
  dirPath: string,
  imageName: string,
  tag: string,
  platforms: string,
  isPublic: boolean,
): Promise<void> {
  updateBuildRecord(buildId, { status: 'queued' });

  // 1. Ensure repo
  const repo = await ensureRepo(token, owner, repoName, isPublic);

  // 2. Push directory + workflow
  const { commitSha } = await pushDirectoryAndBuild(
    token,
    owner,
    repoName,
    dirPath,
    imageName,
    platforms,
    repo.defaultBranch,
  );

  updateBuildRecord(buildId, { status: 'building' });

  // 3. Find the Actions run (GitHub queues it ~5s after push)
  const run = await findRunForCommit(token, owner, repoName, commitSha, 60_000);
  if (!run) {
    throw new Error('GitHub Actions run not found after 60s — check repo Actions tab');
  }

  const workflowRunUrl = run.htmlUrl;
  updateBuildRecord(buildId, {
    runId: run.id,
    workflowRunUrl,
    status: 'building',
  });

  // 4. Poll until complete (max 45 min), with exponential backoff (#968)
  const deadline = Date.now() + 45 * 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, nextBuildPollDelayMs(attempt)));
    attempt++;
    const current = await getRunStatus(token, owner, repoName, run.id);
    if (!current) continue;

    if (current.status === 'completed') {
      if (current.conclusion === 'success') {
        const image = `ghcr.io/${owner}/${repoName}:${tag}`;
        updateBuildRecord(buildId, {
          status: 'success',
          image,
          completedAt: Date.now(),
        });
        return;
      } else {
        throw new Error(
          `Build ${current.conclusion ?? 'failed'} — see ${workflowRunUrl}`,
        );
      }
    }
    // still queued/in_progress → keep polling
  }

  throw new Error('Build timed out after 45 minutes');
}

/** Get current build status from catalog */
export function getBuildStatus(buildId: string): ImageBuildRecord | null {
  return getBuildRecord(buildId);
}

/**
 * Poll a build until it reaches a terminal state.
 * Yields status objects so callers can update UI/logs.
 */
export async function* pollBuildStatus(
  buildId: string,
  intervalMs = 5_000,
  timeoutMs = 50 * 60_000,
): AsyncGenerator<ImageBuildRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = getBuildRecord(buildId);
    if (!record) throw new Error(`Build ${buildId} not found`);
    yield record;
    if (isTerminalBuildStatus(record.status)) {
      return;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Build ${buildId} did not complete within timeout`);
}
