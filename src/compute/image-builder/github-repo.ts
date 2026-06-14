/**
 * GitHub Repository Manager
 *
 * Creates/updates a GitHub repo from a local directory and pushes files via the
 * Git Data API (no git binary required). Then triggers a GitHub Actions workflow
 * to build and push the Docker image to GHCR.
 *
 * Uses only the GitHub REST API — no octokit dependency.
 */

import { lstatSync, readdirSync, readFileSync } from 'fs';
import { basename, extname, join, relative } from 'path';

const GH_API = 'https://api.github.com';
const WORKFLOW_FILENAME = 'docker-build.yml';

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function ghFetch(
  token: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${GH_API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ── Repo management ───────────────────────────────────────────────────────────

export async function ensureRepo(
  token: string,
  owner: string,
  repoName: string,
  isPublic: boolean,
): Promise<{ cloneUrl: string; htmlUrl: string; defaultBranch: string }> {
  // Check if repo already exists
  const existing = await ghFetch(token, `/repos/${owner}/${repoName}`);
  if (existing.ok) {
    const r = existing.data as { clone_url: string; html_url: string; default_branch: string };
    return { cloneUrl: r.clone_url, htmlUrl: r.html_url, defaultBranch: r.default_branch };
  }

  // Create it
  const create = await ghFetch(token, '/user/repos', {
    method: 'POST',
    body: {
      name: repoName,
      private: !isPublic,
      description: 'Docker image built by AI Gateway',
      auto_init: true, // creates initial commit with README so branch exists
    },
  });

  if (!create.ok) {
    throw new Error(`Failed to create repo: ${JSON.stringify(create.data)}`);
  }

  const r = create.data as { clone_url: string; html_url: string; default_branch: string };
  // Wait a moment for GitHub to finish initializing the repo
  await new Promise(res => setTimeout(res, 1500));
  return { cloneUrl: r.clone_url, htmlUrl: r.html_url, defaultBranch: r.default_branch };
}

// ── Git Tree API — bulk push files without git binary ────────────────────────

interface TreeEntry {
  path: string;
  mode: '100644' | '100755';
  type: 'blob';
  content: string; // UTF-8 or base64 (use base64 for binary)
  encoding?: 'utf-8' | 'base64';
}

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.pypirc',
  'github_token.json',
  'provider-config.json',
  'active_deploy.json',
  'cooldowns.json',
  'daily_spend.json',
]);

const SENSITIVE_DIRECTORIES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.babelcast',
  '.ai-gateway',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
]);

export function isSensitiveBuildPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => SENSITIVE_DIRECTORIES.has(part))) return true;

  const fileName = parts.length > 0 ? parts[parts.length - 1] : normalized;
  const lowerName = fileName.toLowerCase();
  if (SENSITIVE_BASENAMES.has(lowerName)) return true;
  if (SENSITIVE_EXTENSIONS.has(extname(lowerName))) return true;
  return false;
}

/**
 * Max total build-context size (bytes) pushed to GitHub. The Git Data API
 * base64-encodes every file into memory, so a stray model weight (.gguf,
 * .safetensors, etc.) silently produces a multi-GB commit. Cap it with a clear
 * error and point operators at pre-baking models at build time instead.
 *
 * Fix #972. Override via AI_GATEWAY_MAX_BUILD_CONTEXT_MB.
 */
export const DEFAULT_MAX_BUILD_CONTEXT_BYTES = 25 * 1024 * 1024; // 25 MB

export function maxBuildContextBytes(): number {
  const raw = process.env.AI_GATEWAY_MAX_BUILD_CONTEXT_MB;
  if (raw) {
    const mb = Number(raw);
    if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  }
  return DEFAULT_MAX_BUILD_CONTEXT_BYTES;
}

/**
 * Pure: sum the byte sizes and throw if the total exceeds `limitBytes`.
 * Returns the total byte count when within budget. Exported for tests.
 */
export function assertBuildContextSize(
  fileSizes: number[],
  limitBytes = maxBuildContextBytes(),
): number {
  const total = fileSizes.reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
  if (total > limitBytes) {
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    const limitMb = (limitBytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `Build context is ${totalMb}MB, exceeding the ${limitMb}MB limit. ` +
        `Pre-bake large model files at build time (download in the Dockerfile) ` +
        `rather than shipping them in the build context, or raise ` +
        `AI_GATEWAY_MAX_BUILD_CONTEXT_MB.`,
    );
  }
  return total;
}

/** Recursively collect all files in a directory, excluding secrets and rejecting symlinks. */
export function collectFiles(dir: string, base: string = dir): TreeEntry[] {
  const entries = collectFilesInternal(dir, base, { bytes: 0 });
  return entries;
}

function collectFilesInternal(dir: string, base: string, acc: { bytes: number }): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const limit = maxBuildContextBytes();
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '.DS_Store') continue;
    const abs = join(dir, name);
    const rel = relative(base, abs).replace(/\\/g, '/');
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in Docker build contexts: ${rel || basename(abs)}`);
    }
    if (isSensitiveBuildPath(rel)) continue;
    if (st.isDirectory()) {
      entries.push(...collectFilesInternal(abs, base, acc));
    } else if (st.isFile()) {
      // Guard against oversized build contexts before reading the file into memory (#972).
      acc.bytes += st.size;
      assertBuildContextSize([acc.bytes], limit);
      const buf = readFileSync(abs);
      // Use base64 for binary files (non-UTF-8-safe)
      let content: string;
      let encoding: 'utf-8' | 'base64' = 'utf-8';
      try {
        content = buf.toString('utf-8');
        // Quick binary check — if replacement chars appear, treat as binary
        if (content.includes('\uFFFD')) throw new Error('binary');
      } catch {
        content = buf.toString('base64');
        encoding = 'base64';
      }
      const mode: '100644' | '100755' = (st.mode & 0o111) !== 0 ? '100755' : '100644';
      entries.push({ path: rel, mode, type: 'blob', content, encoding });
    }
  }
  return entries;
}

/** Push a tree of files to the repo, return new commit SHA */
async function pushTree(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: TreeEntry[],
  commitMessage: string,
): Promise<string> {
  // 1. Get current HEAD SHA
  const refRes = await ghFetch(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  let parentSha: string | null = null;
  let baseTreeSha: string | null = null;

  if (refRes.ok) {
    const ref = refRes.data as { object: { sha: string } };
    parentSha = ref.object.sha;

    // Get the tree SHA from the commit
    const commitRes = await ghFetch(token, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
    if (commitRes.ok) {
      const commit = commitRes.data as { tree: { sha: string } };
      baseTreeSha = commit.tree.sha;
    }
  }

  // 2. Create blobs for binary files (GitHub tree API wants separate blobs for base64)
  //    For utf-8 content we can inline it directly in the tree.
  const treeItems: Array<{ path: string; mode: string; type: string; content?: string; sha?: string }> = [];

  for (const file of files) {
    if (file.encoding === 'base64') {
      // Create a blob for binary content
      const blobRes = await ghFetch(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: { content: file.content, encoding: 'base64' },
      });
      if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path}`);
      const blob = blobRes.data as { sha: string };
      treeItems.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
    } else {
      treeItems.push({ path: file.path, mode: file.mode, type: 'blob', content: file.content });
    }
  }

  // 3. Create tree
  const treeBody: Record<string, unknown> = { tree: treeItems };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;

  const treeRes = await ghFetch(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: treeBody,
  });
  if (!treeRes.ok) throw new Error(`Failed to create tree: ${JSON.stringify(treeRes.data)}`);
  const tree = treeRes.data as { sha: string };

  // 4. Create commit
  const commitBody: Record<string, unknown> = {
    message: commitMessage,
    tree: tree.sha,
  };
  if (parentSha) commitBody.parents = [parentSha];

  const newCommitRes = await ghFetch(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: commitBody,
  });
  if (!newCommitRes.ok) throw new Error(`Failed to create commit: ${JSON.stringify(newCommitRes.data)}`);
  const newCommit = newCommitRes.data as { sha: string };

  // 5. Update branch ref
  if (refRes.ok) {
    // Update existing ref
    await ghFetch(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: newCommit.sha },
    });
  } else {
    // Create ref
    await ghFetch(token, `/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: newCommit.sha },
    });
  }

  return newCommit.sha;
}

// ── Workflow template ─────────────────────────────────────────────────────────

export function generateWorkflow(imageName: string, platforms: string): string {
  return `name: Build Docker Image

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      tag:
        description: 'Docker tag to build'
        default: 'latest'

# Cancel an in-flight build when a newer commit lands on the same ref so rapid
# rebuilds of the same image don't run in parallel and waste Actions minutes (#975).
concurrency:
  group: image-\${{ github.ref }}
  cancel-in-progress: true

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: \${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up QEMU (multi-arch)
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: \${{ env.REGISTRY }}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: \${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable=\${{ github.ref == format('refs/heads/{0}', 'main') }}
            type=sha,prefix=sha-
            type=raw,value=\${{ github.event.inputs.tag || 'latest' }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          platforms: ${platforms}
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          # Layer cache: GHA cache first, then fall back to the previously pushed
          # :latest image so the first build after a cache eviction stays warm (#966).
          cache-from: |
            type=gha
            type=registry,ref=\${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}:latest
          cache-to: type=gha,mode=max
`;
}

// ── Main push + trigger ───────────────────────────────────────────────────────

export interface PushResult {
  commitSha: string;
  repoUrl: string;
  defaultBranch: string;
}

/**
 * Push a local directory to the GitHub repo and trigger the build workflow.
 * Returns the GitHub Actions workflow run ID so callers can poll for status.
 */
export async function pushDirectoryAndBuild(
  token: string,
  owner: string,
  repoName: string,
  dirPath: string,
  imageName: string,
  platforms: string,
  branch: string,
): Promise<PushResult> {
  // Collect all user files
  const userFiles = collectFiles(dirPath);

  // Inject the build workflow
  const workflowContent = generateWorkflow(imageName, platforms);
  userFiles.push({
    path: `.github/workflows/${WORKFLOW_FILENAME}`,
    mode: '100644',
    type: 'blob',
    content: workflowContent,
    encoding: 'utf-8',
  });

  const commitSha = await pushTree(
    token,
    owner,
    repoName,
    branch,
    userFiles,
    `chore: AI Gateway image build — ${new Date().toISOString()}`,
  );

  return {
    commitSha,
    repoUrl: `https://github.com/${owner}/${repoName}`,
    defaultBranch: branch,
  };
}

// ── Actions run polling ───────────────────────────────────────────────────────

export interface ActionRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | null;
  htmlUrl: string;
  name: string;
}

/** Find the most recent workflow run for a given commit SHA */
export async function findRunForCommit(
  token: string,
  owner: string,
  repo: string,
  commitSha: string,
  maxWaitMs = 30_000,
): Promise<ActionRun | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await ghFetch(
      token,
      `/repos/${owner}/${repo}/actions/runs?head_sha=${commitSha}&per_page=5`,
    );
    if (res.ok) {
      const data = res.data as { workflow_runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string; name: string }> };
      const run = data.workflow_runs[0];
      if (run) {
        return {
          id: run.id,
          status: run.status as ActionRun['status'],
          conclusion: run.conclusion as ActionRun['conclusion'],
          htmlUrl: run.html_url,
          name: run.name,
        };
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

/** Get current status of a workflow run */
export async function getRunStatus(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<ActionRun | null> {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/actions/runs/${runId}`);
  if (!res.ok) return null;
  const run = res.data as { id: number; status: string; conclusion: string | null; html_url: string; name: string };
  return {
    id: run.id,
    status: run.status as ActionRun['status'],
    conclusion: run.conclusion as ActionRun['conclusion'],
    htmlUrl: run.html_url,
    name: run.name,
  };
}
