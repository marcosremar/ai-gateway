/**
 * Image Builder — shared types
 *
 * Orchestrates: local dir → GitHub repo → GitHub Actions → GHCR image → GPU deploy
 */

// ── GitHub OAuth ──────────────────────────────────────────────────────────────

export interface GitHubTokenData {
  accessToken: string;
  tokenType: string;
  scope: string;
  username: string;
  savedAt: number;
}

export interface GitHubDeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;   // seconds
  interval: number;    // poll interval seconds
}

// ── Build spec ────────────────────────────────────────────────────────────────

export interface ImageBuildSpec {
  /** Absolute or relative path to local directory containing a Dockerfile */
  dirPath: string;
  /** Short name for the image (defaults to directory basename) */
  name?: string;
  /** Docker tag (default: 'latest') */
  tag?: string;
  /**
   * GitHub repo name to create/push to.
   * Defaults to `ai-gateway-img-<name>`.
   * Will be created if it does not exist.
   */
  repoName?: string;
  /** Create the repo as public (default: false = private) */
  isPublic?: boolean;
  /**
   * Container registry to push to.
   * 'ghcr' = GitHub Container Registry (free, no extra secrets needed).
   * Default: 'ghcr'
   */
  registry?: 'ghcr';
  /**
   * Comma-separated platform targets (default: 'linux/amd64').
   * Use 'linux/amd64,linux/arm64' for multi-arch.
   */
  platforms?: string;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export type ImageBuildStatus = 'pending' | 'queued' | 'building' | 'success' | 'failed' | 'cancelled';

export interface ImageBuildRecord {
  /** Unique build ID (uuid-like short string) */
  id: string;
  /** Short image name */
  name: string;
  /** Docker tag */
  tag: string;
  /**
   * Full image reference, e.g. ghcr.io/alice/ai-gateway-img-myapp:latest
   * Available only when status === 'success'
   */
  image: string;
  /** GitHub HTTPS repo URL */
  repoUrl: string;
  /** Owner (GitHub username) */
  owner: string;
  /** GitHub repo name */
  repoName: string;
  /** GitHub Actions workflow run URL (once started) */
  workflowRunUrl?: string;
  /** GitHub Actions run ID */
  runId?: number;
  status: ImageBuildStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Platforms built for */
  platforms: string;
}

export interface ImageCatalog {
  version: 1;
  records: ImageBuildRecord[];
}

// ── HTTP API shapes ───────────────────────────────────────────────────────────

export interface StartDeviceFlowResponse {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  /** Opaque token to pass to GET /v1/docker/auth/poll */
  sessionId: string;
}

export interface PollAuthResponse {
  status: 'pending' | 'complete' | 'expired' | 'error';
  username?: string;
  error?: string;
}

export interface StartBuildResponse {
  buildId: string;
  repoUrl: string;
  status: ImageBuildStatus;
  message: string;
}

export interface BuildStatusResponse {
  build: ImageBuildRecord;
}

export interface ListBuildsResponse {
  builds: ImageBuildRecord[];
}
