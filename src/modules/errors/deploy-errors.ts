/**
 * Deploy Error Categories — comprehensive error type system for GPU deployments.
 *
 * Based on real-world error patterns from:
 *   - Vast.ai (scheduling, host reclaim, SSH, verification)
 *   - RunPod (container exit, image pull, deploy failures)
 *   - Docker Hub (rate limits, manifest unknown, unauthorized)
 *   - NVIDIA/CUDA (driver mismatch, OOM, ECC, thermal)
 *   - LLM deployment (model loading, KV cache, quantization)
 *
 * 10 Categories, 60+ error codes with retryability, severity, and user actions.
 *
 * Usage:
 * ```ts
 * import { categorizeDeployError, DeployError, ErrorCategory } from './deploy-errors';
 *
 * try {
 *   await deployGpu(config);
 * } catch (err) {
 *   const deployErr = categorizeDeployError(err);
 *   console.log(deployErr.category);    // 'CONTAINER'
 *   console.log(deployErr.code);        // 'CNT_IMAGE_NOT_FOUND'
 *   console.log(deployErr.retryable);   // false
 *   console.log(deployErr.userMessage); // Full message with action
 * }
 * ```
 */

// ── Error Categories ──────────────────────────────────────────────────────────

export type ErrorCategory =
  /** Input/config/validation errors */
  | 'VALIDATION'
  /** OOM, disk full, VRAM, swap */
  | 'RESOURCE'
  /** DNS, timeout, rate limit, connection */
  | 'NETWORK'
  /** Provider API, auth, offers, templates */
  | 'PROVIDER'
  /** Docker image, pull, runtime, healthcheck */
  | 'CONTAINER'
  /** CUDA, driver, ECC, thermal, hardware */
  | 'GPU_HARDWARE'
  /** Auth, credentials, TLS, permissions */
  | 'SECURITY'
  /** Race, stuck, orphan, ghost, duplicate */
  | 'STATE'
  /** Budget, price change, runaway spending */
  | 'COST'
  /** Host power, reclaim, runtime crash, zombie */
  | 'INFRASTRUCTURE';

// ── Error Codes — Based on Real-World Patterns ────────────────────────────────

export type ErrorCode =
  // ─── VALIDATION (VLD-*) ───
  /** Invalid JSON or malformed request body */
  | 'VLD_INVALID_INPUT'
  /** Required field missing (gpuTypes, dockerImage, apiKey) */
  | 'VLD_MISSING_FIELD'
  /** Invalid format (bad GPU type name, invalid image format) */
  | 'VLD_INVALID_FORMAT'
  /** Pre-flight checks failed (image, CUDA, DNS, cost) */
  | 'VLD_PREFLIGHT_FAILED'
  /** GPU incompatible with image (CUDA version, VRAM, architecture) */
  | 'VLD_GPU_INCOMPATIBLE'
  /** Docker image unavailable before deploy starts */
  | 'VLD_IMAGE_UNAVAILABLE'
  /** spend_rate_limit — Vast.ai account restriction */
  | 'VLD_SPEND_RATE_LIMIT'

  // ─── RESOURCE (RES-*) ───
  /** CUDA out of memory during model load */
  | 'RES_CUDA_OOM'
  /** Host RAM out of memory (OOM killer) */
  | 'RES_HOST_OOM'
  /** Disk full (no space left on device) */
  | 'RES_DISK_FULL'
  /** VRAM insufficient for model size */
  | 'RES_VRAM_INSUFFICIENT'
  /** Host swap thrashing — performance degraded */
  | 'RES_SWAP_THRASHING'
  /** CPU limit reached on host */
  | 'RES_CPU_LIMIT'

  // ─── NETWORK (NET-*) ───
  /** DNS resolution failed (ENOTFOUND, EAI_AGAIN) */
  | 'NET_DNS_FAILURE'
  /** Request timed out (ETIMEDOUT, AbortError) */
  | 'NET_TIMEOUT'
  /** Docker Hub rate limit (429 toomanyrequests) */
  | 'NET_DOCKER_HUB_RATE_LIMIT'
  /** Provider API rate limit (429) */
  | 'NET_PROVIDER_RATE_LIMIT'
  /** Connection refused (ECONNREFUSED) */
  | 'NET_CONNECTION_REFUSED'
  /** Insufficient bandwidth for image pull */
  | 'NET_BANDWIDTH_LOW'

  // ─── PROVIDER (PRV-*) ───
  /** Generic provider API error (5xx) */
  | 'PRV_API_ERROR'
  /** Auth failed (401, invalid API key) */
  | 'PRV_AUTH_FAILED'
  /** GPU offer disappeared mid-deploy */
  | 'PRV_OFFER_UNAVAILABLE'
  /** Template creation/list failed (Vast.ai) */
  | 'PRV_TEMPLATE_FAILED'
  /** No GPUs available in requested region */
  | 'PRV_NO_GPUS'
  /** API key expired or revoked mid-deploy */
  | 'PRV_API_KEY_EXPIRED'
  /** Instance stuck in "scheduling" state (Vast.ai) */
  | 'PRV_SCHEDULING_STUCK'

  // ─── CONTAINER (CNT-*) ───
  /** Docker image not found (manifest unknown, 404) */
  | 'CNT_IMAGE_NOT_FOUND'
  /** Port conflict on host (EADDRINUSE) */
  | 'CNT_PORT_CONFLICT'
  /** Container runtime crashed (Docker/containerd) */
  | 'CNT_RUNTIME_CRASH'
  /** Health check failed (Vast.ai auto-destroy risk) */
  | 'CNT_HEALTHCHECK_FAIL'
  /** Docker pull failed (network, auth, manifest) */
  | 'CNT_PULL_FAILED'
  /** Container failed to start (exited immediately) */
  | 'CNT_START_FAILED'
  /** ImagePullBackOff / ErrImagePull (Kubernetes-style) */
  | 'CNT_PULL_BACKOFF'
  /** "could not select device driver" — nvidia-container-toolkit missing */
  | 'CNT_GPU_DRIVER_MISSING'

  // ─── GPU_HARDWARE (GPU-*) ───
  /** CUDA version mismatch (container vs host) */
  | 'GPU_CUDA_MISMATCH'
  /** NVIDIA driver mismatch (driver/library version mismatch) */
  | 'GPU_DRIVER_MISMATCH'
  /** GPU ECC memory error (Xid errors) */
  | 'GPU_ECC_ERROR'
  /** GPU thermal throttling (>85°C) */
  | 'GPU_THERMAL_THROTTLE'
  /** GPU hardware fault (PCIe error, device vanished) */
  | 'GPU_HARDWARE_FAULT'
  /** nvidia-smi failed inside container */
  | 'GPU_NVML_FAILURE'

  // ─── SECURITY (SEC-*) ───
  /** Authentication bypass detected */
  | 'SEC_AUTH_BYPASS'
  /** Credential leaked in logs or response */
  | 'SEC_CREDENTIAL_LEAK'
  /** TLS/SSL verification failed */
  | 'SEC_TLS_FAILURE'
  /** Unauthorized (401, 403) */
  | 'SEC_UNAUTHORIZED'
  /** SSH key permission denied */
  | 'SEC_SSH_KEY_DENIED'

  // ─── STATE (ST-*) ───
  /** Race condition (concurrent deploys) */
  | 'ST_RACE_CONDITION'
  /** Deployment stuck with no progress */
  | 'ST_STUCK_DEPLOY'
  /** Orphaned instance detected */
  | 'ST_ORPHANED_INSTANCE'
  /** Duplicate deploy request (idempotency) */
  | 'ST_DUPLICATE_REQUEST'
  /** Ghost machine (no container started) */
  | 'ST_GHOST_MACHINE'
  /** Instance exited unexpectedly */
  | 'ST_INSTANCE_EXITED'

  // ─── COST (CST-*) ───
  /** Budget exceeded */
  | 'CST_BUDGET_EXCEEDED'
  /** Price changed from quoted price */
  | 'CST_PRICE_CHANGE'
  /** Runaway spending detected */
  | 'CST_RUNAWAY_SPENDING'
  /** Unreasonable price (above threshold) */
  | 'CST_UNREASONABLE_PRICE'

  // ─── INFRASTRUCTURE (INF-*) ───
  /** Host lost power or became unreachable */
  | 'INF_HOST_POWER_LOSS'
  /** Host reclaimed instance (Vast.ai host behavior) */
  | 'INF_HOST_RECLAIM'
  /** Instance stuck in "creating" state */
  | 'INF_INSTANCE_STUCK'
  /** Container runtime crashed on host */
  | 'INF_CONTAINER_RUNTIME_CRASH'
  /** Zombie processes from previous deployment */
  | 'INF_ZOMBIE_PROCESS'
  /** Account credit balance zero (Vast.ai auto-stop) */
  | 'INF_CREDIT_ZERO';

// ── Category Metadata ─────────────────────────────────────────────────────────

interface CategoryMetadata {
  name: string;
  description: string;
  icon: string;
  defaultRetryable: boolean;
  suggestedAction: string;
}

export const CATEGORY_METADATA: Record<ErrorCategory, CategoryMetadata> = {
  VALIDATION: {
    name: 'Validation Error',
    description: 'Input or configuration is invalid',
    icon: '⚠️',
    defaultRetryable: false,
    suggestedAction: 'Fix the input/configuration and retry.',
  },
  RESOURCE: {
    name: 'Resource Error',
    description: 'Insufficient resources (GPU memory, disk, RAM, swap)',
    icon: '📦',
    defaultRetryable: false,
    suggestedAction: 'Use a larger GPU, reduce model size, or add quantization.',
  },
  NETWORK: {
    name: 'Network Error',
    description: 'Network connectivity, DNS, rate limiting, or timeout',
    icon: '🌐',
    defaultRetryable: true,
    suggestedAction: 'Check network connection, authenticate for Docker Hub, and retry.',
  },
  PROVIDER: {
    name: 'Provider Error',
    description: 'GPU provider API failure, auth, or offer issue',
    icon: '☁️',
    defaultRetryable: true,
    suggestedAction: 'Check provider status, credentials, and GPU availability.',
  },
  CONTAINER: {
    name: 'Container Error',
    description: 'Docker image, pull, runtime, or GPU passthrough issue',
    icon: '🐳',
    defaultRetryable: false,
    suggestedAction: 'Verify Docker image exists, nvidia-container-toolkit is installed, and configuration is correct.',
  },
  GPU_HARDWARE: {
    name: 'GPU Hardware Error',
    description: 'CUDA, driver, ECC, thermal, or hardware fault',
    icon: '🎮',
    defaultRetryable: false,
    suggestedAction: 'Try a different GPU or host. Check driver compatibility.',
  },
  SECURITY: {
    name: 'Security Error',
    description: 'Authentication, credential leak, TLS, or SSH issue',
    icon: '🔒',
    defaultRetryable: false,
    suggestedAction: 'Check API credentials, SSH keys, and TLS configuration.',
  },
  STATE: {
    name: 'State Error',
    description: 'Deployment state inconsistency, stuck deploy, or orphan',
    icon: '🔄',
    defaultRetryable: true,
    suggestedAction: 'Clean up orphaned resources and retry.',
  },
  COST: {
    name: 'Cost Error',
    description: 'Budget exceeded, price change, or runaway spending',
    icon: '💰',
    defaultRetryable: false,
    suggestedAction: 'Review budget settings, pricing, and spending limits.',
  },
  INFRASTRUCTURE: {
    name: 'Infrastructure Error',
    description: 'Host power loss, reclaim, runtime crash, or zombie process',
    icon: '🏗️',
    defaultRetryable: true,
    suggestedAction: 'Try a different host or provider. Check account credits.',
  },
};

// ── Error Code Metadata ───────────────────────────────────────────────────────

interface ErrorCodeMetadata {
  message: string;
  retryable: boolean;
  httpStatus: number;
  severity: 'info' | 'warn' | 'error' | 'critical';
  /** Which real-world error pattern this maps to */
  realWorldPattern: string;
}

export const ERROR_CODE_METADATA: Record<ErrorCode, ErrorCodeMetadata> = {
  // ─── VALIDATION ───
  VLD_INVALID_INPUT: {
    message: 'Invalid input: {detail}',
    retryable: false, httpStatus: 400, severity: 'warn',
    realWorldPattern: 'Generic validation failure',
  },
  VLD_MISSING_FIELD: {
    message: 'Missing required field: {field}',
    retryable: false, httpStatus: 400, severity: 'warn',
    realWorldPattern: 'Missing gpuTypes, dockerImage, or apiKey',
  },
  VLD_INVALID_FORMAT: {
    message: 'Invalid format for {field}: {detail}',
    retryable: false, httpStatus: 422, severity: 'warn',
    realWorldPattern: 'Bad GPU type name or Docker image format',
  },
  VLD_PREFLIGHT_FAILED: {
    message: 'Pre-flight checks failed: {errors}',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: 'Image, CUDA, DNS, or cost pre-flight failure',
  },
  VLD_GPU_INCOMPATIBLE: {
    message: 'GPU incompatible: {detail}',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: 'CUDA version or VRAM mismatch for target GPU',
  },
  VLD_IMAGE_UNAVAILABLE: {
    message: 'Docker image unavailable: {image}',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: 'Image does not exist or is private without auth',
  },
  VLD_SPEND_RATE_LIMIT: {
    message: 'Vast.ai spend rate limit exceeded — verify email or wait',
    retryable: true, httpStatus: 429, severity: 'warn',
    realWorldPattern: 'Vast.ai "spend_rate_limit" on new/unverified accounts',
  },

  // ─── RESOURCE ───
  RES_CUDA_OOM: {
    message: 'CUDA out of memory: {used}GB/{total}GB — {model} needs more VRAM',
    retryable: false, httpStatus: 507, severity: 'critical',
    realWorldPattern: 'PyTorch "CUDA out of memory" during model load',
  },
  RES_HOST_OOM: {
    message: 'Host OOM killer terminated process: {detail}',
    retryable: true, httpStatus: 507, severity: 'critical',
    realWorldPattern: 'Linux OOM killer during model loading',
  },
  RES_DISK_FULL: {
    message: 'Disk full: {used}GB/{total}GB — no space left on device',
    retryable: false, httpStatus: 507, severity: 'critical',
    realWorldPattern: 'ENOSPC during model download or Docker pull',
  },
  RES_VRAM_INSUFFICIENT: {
    message: 'Insufficient VRAM: {required}GB needed, {available}GB available on {gpu}',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: '70B model on 24GB GPU without quantization',
  },
  RES_SWAP_THRASHING: {
    message: 'Host swap thrashing detected — performance severely degraded',
    retryable: true, httpStatus: 503, severity: 'error',
    realWorldPattern: 'Host using swap during model load, extreme slowness',
  },
  RES_CPU_LIMIT: {
    message: 'CPU limit reached on host',
    retryable: true, httpStatus: 503, severity: 'warn',
    realWorldPattern: 'All CPU cores saturated during preprocessing',
  },

  // ─── NETWORK ───
  NET_DNS_FAILURE: {
    message: 'DNS resolution failed for {host}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'ENOTFOUND/EAI_AGAIN for provider API or Docker Hub',
  },
  NET_TIMEOUT: {
    message: 'Request timed out after {timeout}ms',
    retryable: true, httpStatus: 504, severity: 'warn',
    realWorldPattern: 'ETIMEDOUT or AbortError during API call or pull',
  },
  NET_DOCKER_HUB_RATE_LIMIT: {
    message: 'Docker Hub rate limit: 100 pulls/6h (anonymous) or 200 pulls/6h (authenticated). Set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN.',
    retryable: true, httpStatus: 429, severity: 'error',
    realWorldPattern: 'Docker Hub 429 "toomanyrequests" — unauthenticated limit is 100/6h, authenticated is 200/6h',
  },
  NET_PROVIDER_RATE_LIMIT: {
    message: 'Provider API rate limited: {detail}',
    retryable: true, httpStatus: 429, severity: 'warn',
    realWorldPattern: 'Vast.ai/RunPod API 429 response',
  },
  NET_CONNECTION_REFUSED: {
    message: 'Connection refused: {host}:{port}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'ECONNREFUSED — host not listening on port',
  },
  NET_BANDWIDTH_LOW: {
    message: 'Insufficient bandwidth: {mbps} Mbps (minimum {min} Mbps)',
    retryable: false, httpStatus: 400, severity: 'warn',
    realWorldPattern: 'Host internet <500 Mbps — image pull too slow',
  },

  // ─── PROVIDER ───
  PRV_API_ERROR: {
    message: 'Provider API error: {detail}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'Generic 5xx from Vast.ai/RunPod API',
  },
  PRV_AUTH_FAILED: {
    message: 'Provider authentication failed: {detail}',
    retryable: false, httpStatus: 401, severity: 'critical',
    realWorldPattern: 'Invalid API key, 401/403 from provider',
  },
  PRV_OFFER_UNAVAILABLE: {
    message: 'GPU offer no longer available: {offer}',
    retryable: true, httpStatus: 404, severity: 'warn',
    realWorldPattern: 'Offer disappeared between listOffers and createInstance',
  },
  PRV_TEMPLATE_FAILED: {
    message: 'Template operation failed: {detail}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'Vast.ai template list/create API failure',
  },
  PRV_NO_GPUS: {
    message: 'No GPUs available in region: {region}',
    retryable: false, httpStatus: 404, severity: 'warn',
    realWorldPattern: '0 offers matched after filters',
  },
  PRV_API_KEY_EXPIRED: {
    message: 'API key expired or revoked',
    retryable: false, httpStatus: 401, severity: 'critical',
    realWorldPattern: 'Key was valid at deploy start but expired during deploy',
  },
  PRV_SCHEDULING_STUCK: {
    message: 'Instance stuck in "scheduling" — conflicting high-priority jobs using same GPUs',
    retryable: true, httpStatus: 504, severity: 'warn',
    realWorldPattern: 'Vast.ai instance stuck in "scheduling" phase',
  },

  // ─── CONTAINER ───
  CNT_IMAGE_NOT_FOUND: {
    message: 'Docker image not found: {image}',
    retryable: false, httpStatus: 404, severity: 'error',
    realWorldPattern: '"manifest unknown" or "pull access denied"',
  },
  CNT_PORT_CONFLICT: {
    message: 'Port conflict on host: port {port} already in use',
    retryable: false, httpStatus: 409, severity: 'error',
    realWorldPattern: 'EADDRINUSE — another container bound to port',
  },
  CNT_RUNTIME_CRASH: {
    message: 'Container runtime crashed: {detail}',
    retryable: true, httpStatus: 500, severity: 'critical',
    realWorldPattern: 'Docker daemon or containerd crash on host',
  },
  CNT_HEALTHCHECK_FAIL: {
    message: 'Container health check failed: {detail} — Vast.ai may auto-destroy',
    retryable: true, httpStatus: 503, severity: 'error',
    realWorldPattern: 'HEALTHCHECK fails during model loading → Vast.ai auto-destroy',
  },
  CNT_PULL_FAILED: {
    message: 'Docker pull failed: {detail}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'Image pull timeout, auth failure, or manifest error',
  },
  CNT_START_FAILED: {
    message: 'Container failed to start: {detail}',
    retryable: true, httpStatus: 500, severity: 'error',
    realWorldPattern: 'Container exits immediately after start',
  },
  CNT_PULL_BACKOFF: {
    message: 'ImagePullBackOff: {detail}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'Kubernetes-style ImagePullBackOff / ErrImagePull',
  },
  CNT_GPU_DRIVER_MISSING: {
    message: 'GPU passthrough failed: "could not select device driver" — nvidia-container-toolkit not installed on host',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: '"could not select device driver with capabilities: [[gpu]]"',
  },

  // ─── GPU_HARDWARE ───
  GPU_CUDA_MISMATCH: {
    message: 'CUDA version mismatch: image requires CUDA {required}, host driver supports {available}',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: 'Container built with CUDA 12.8 but host driver only supports 12.4',
  },
  GPU_DRIVER_MISMATCH: {
    message: 'NVIDIA driver mismatch: "Failed to initialize NVML: Driver/library version mismatch"',
    retryable: false, httpStatus: 400, severity: 'error',
    realWorldPattern: 'Host driver updated but container runtime not restarted',
  },
  GPU_ECC_ERROR: {
    message: 'GPU ECC memory error detected: Xid {xid}',
    retryable: false, httpStatus: 500, severity: 'critical',
    realWorldPattern: 'NVIDIA Xid errors (31, 43, 48, 79) — memory corruption',
  },
  GPU_THERMAL_THROTTLE: {
    message: 'GPU thermal throttling: {temp}°C (threshold {threshold}°C)',
    retryable: true, httpStatus: 503, severity: 'warn',
    realWorldPattern: 'GPU >85°C on consumer hosts with poor cooling',
  },
  GPU_HARDWARE_FAULT: {
    message: 'GPU hardware fault: {detail}',
    retryable: false, httpStatus: 500, severity: 'critical',
    realWorldPattern: 'PCIe error, device vanished, or IOMMU fault',
  },
  GPU_NVML_FAILURE: {
    message: 'nvidia-smi failed inside container: {detail}',
    retryable: false, httpStatus: 500, severity: 'error',
    realWorldPattern: '"NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver"',
  },

  // ─── SECURITY ───
  SEC_AUTH_BYPASS: {
    message: 'Authentication bypass detected',
    retryable: false, httpStatus: 403, severity: 'critical',
    realWorldPattern: 'Deploy endpoint called without valid auth',
  },
  SEC_CREDENTIAL_LEAK: {
    message: 'Credential leak detected in logs or response',
    retryable: false, httpStatus: 500, severity: 'critical',
    realWorldPattern: 'API key or Docker Hub token in error output',
  },
  SEC_TLS_FAILURE: {
    message: 'TLS verification failed: {detail}',
    retryable: false, httpStatus: 502, severity: 'critical',
    realWorldPattern: 'Certificate expired, wrong hostname, or self-signed',
  },
  SEC_UNAUTHORIZED: {
    message: 'Unauthorized: {detail}',
    retryable: false, httpStatus: 401, severity: 'error',
    realWorldPattern: '401/403 from any protected endpoint',
  },
  SEC_SSH_KEY_DENIED: {
    message: 'SSH key permission denied — public key not in host authorized_keys',
    retryable: false, httpStatus: 403, severity: 'error',
    realWorldPattern: 'Vast.ai "Permission denied (publickey)" — key not registered',
  },

  // ─── STATE ───
  ST_RACE_CONDITION: {
    message: 'Race condition detected: {detail}',
    retryable: true, httpStatus: 409, severity: 'warn',
    realWorldPattern: 'Two concurrent deploys for same user',
  },
  ST_STUCK_DEPLOY: {
    message: 'Deployment stuck for {duration}ms with no progress',
    retryable: true, httpStatus: 504, severity: 'error',
    realWorldPattern: 'No status change in 15+ minutes',
  },
  ST_ORPHANED_INSTANCE: {
    message: 'Orphaned instance detected: {instanceId}',
    retryable: true, httpStatus: 409, severity: 'warn',
    realWorldPattern: 'Instance exists but no deploy record',
  },
  ST_DUPLICATE_REQUEST: {
    message: 'Duplicate deploy request — returning existing deploy',
    retryable: false, httpStatus: 200, severity: 'info',
    realWorldPattern: 'User double-clicks deploy button',
  },
  ST_GHOST_MACHINE: {
    message: 'Ghost machine: no container started after {duration}ms',
    retryable: true, httpStatus: 500, severity: 'error',
    realWorldPattern: 'Instance running but container never starts',
  },
  ST_INSTANCE_EXITED: {
    message: 'Instance exited unexpectedly with code {code}',
    retryable: true, httpStatus: 500, severity: 'error',
    realWorldPattern: 'Container exited with non-zero code',
  },

  // ─── COST ───
  CST_BUDGET_EXCEEDED: {
    message: 'Budget exceeded: ${spent} / ${budget}',
    retryable: false, httpStatus: 429, severity: 'error',
    realWorldPattern: 'Total spend exceeds configured budget',
  },
  CST_PRICE_CHANGE: {
    message: 'Price changed: quoted ${quoted}/hr, actual ${actual}/hr',
    retryable: true, httpStatus: 400, severity: 'warn',
    realWorldPattern: 'GPU price changed between quote and instance creation',
  },
  CST_RUNAWAY_SPENDING: {
    message: 'Runaway spending detected: ${rate}/hr',
    retryable: false, httpStatus: 429, severity: 'critical',
    realWorldPattern: 'Spend rate 3x higher than normal',
  },
  CST_UNREASONABLE_PRICE: {
    message: 'Unreasonable price: ${price}/hr exceeds maximum ${max}/hr',
    retryable: false, httpStatus: 400, severity: 'warn',
    realWorldPattern: 'Price > $5/hr — likely misconfiguration',
  },

  // ─── INFRASTRUCTURE ───
  INF_HOST_POWER_LOSS: {
    message: 'Host lost power or became unreachable',
    retryable: true, httpStatus: 502, severity: 'critical',
    realWorldPattern: 'Consumer GPU host on residential power',
  },
  INF_HOST_RECLAIM: {
    message: 'Host reclaimed instance: {reason}',
    retryable: true, httpStatus: 502, severity: 'error',
    realWorldPattern: 'Vast.ai host stopped or disassociated instance',
  },
  INF_INSTANCE_STUCK: {
    message: 'Instance stuck in "creating" state for {duration}ms',
    retryable: true, httpStatus: 504, severity: 'error',
    realWorldPattern: 'Vast.ai instance never gets IP address',
  },
  INF_CONTAINER_RUNTIME_CRASH: {
    message: 'Container runtime (Docker/containerd) crashed on host',
    retryable: true, httpStatus: 500, severity: 'critical',
    realWorldPattern: 'Docker daemon crash — all containers on host affected',
  },
  INF_ZOMBIE_PROCESS: {
    message: 'Zombie processes from previous deployment detected',
    retryable: true, httpStatus: 409, severity: 'warn',
    realWorldPattern: 'Previous deploy left defunct processes',
  },
  INF_CREDIT_ZERO: {
    message: 'Account credit balance is zero — instance auto-stopped',
    retryable: true, httpStatus: 402, severity: 'error',
    realWorldPattern: 'Vast.ai auto-stops instances when credit = 0',
  },
};

// ── DeployError Class ─────────────────────────────────────────────────────────

export interface DeployErrorContext {
  /** Original error that caused this */
  cause?: Error;
  /** Deploy ID */
  deployId?: string;
  /** GPU provider */
  provider?: string;
  /** GPU type */
  gpuType?: string;
  /** Docker image */
  imageName?: string;
  /** Additional detail */
  detail?: string;
  /** Field name (for validation errors) */
  field?: string;
  /** Numeric or string values for message templates */
  [key: string]: unknown;
}

/**
 * Standardized deploy error with category, code, and context.
 * Every error from the deploy pipeline should be wrapped in this.
 */
export class DeployError extends Error {
  public readonly category: ErrorCategory;
  public readonly code: ErrorCode;
  public readonly context: DeployErrorContext;
  public readonly retryable: boolean;
  public readonly httpStatus: number;
  public readonly severity: 'info' | 'warn' | 'error' | 'critical';

  constructor(category: ErrorCategory, code: ErrorCode, context: DeployErrorContext = {}, cause?: Error) {
    const meta = ERROR_CODE_METADATA[code];
    let message = meta.message;

    // Substitute template variables: {key} or {KEY}
    for (const [key, value] of Object.entries(context)) {
      message = message.replace(`{${key}}`, String(value));
      message = message.replace(`{${key.toUpperCase()}}`, String(value));
    }

    super(message);
    this.name = 'DeployError';
    this.category = category;
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.retryable = meta.retryable;
    this.httpStatus = meta.httpStatus;
    this.severity = meta.severity;
    if (cause) {
      this.cause = cause;
    }
  }

  /** User-friendly message with suggested action */
  get userMessage(): string {
    const meta = CATEGORY_METADATA[this.category];
    return `${meta.icon} ${meta.name}: ${this.message}\n→ ${meta.suggestedAction}`;
  }

  /** JSON representation for API responses */
  toJSON() {
    return {
      error: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      severity: this.severity,
      context: this.context,
      ...(this.cause ? { cause: (this.cause as Error).message } : {}),
    };
  }
}

// ── Error Categorization Engine ───────────────────────────────────────────────

/**
 * Categorize a raw error into a DeployError with proper category and code.
 *
 * Analyzes the error message, type, HTTP status, and context to determine
 * the best category and error code based on real-world patterns.
 */
export function categorizeDeployError(err: unknown, context: DeployErrorContext = {}): DeployError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const cause = err instanceof Error ? err : undefined;

  // Extract HTTP status if available
  const httpStatus = (err as any)?.status ?? (err as any)?.statusCode ?? 0;

  // ─── VALIDATION ───
  if (lower.includes('malformed') || (lower.includes('invalid') && !lower.includes('key'))) {
    return new DeployError('VALIDATION', 'VLD_INVALID_INPUT', { ...context, detail: message }, cause);
  }
  if (lower.includes('missing') && (lower.includes('field') || lower.includes('required'))) {
    return new DeployError('VALIDATION', 'VLD_MISSING_FIELD', { ...context, field: extractField(message) }, cause);
  }
  if (lower.includes('pre-flight') || lower.includes('preflight')) {
    return new DeployError('VALIDATION', 'VLD_PREFLIGHT_FAILED', { ...context, errors: message }, cause);
  }
  if (lower.includes('gpu incompat') || lower.includes('gpu incompat')) {
    return new DeployError('VALIDATION', 'VLD_GPU_INCOMPATIBLE', { ...context, detail: message }, cause);
  }
  if (lower.includes('spend_rate_limit') || lower.includes('spend rate limit')) {
    return new DeployError('VALIDATION', 'VLD_SPEND_RATE_LIMIT', { ...context }, cause);
  }

  // ─── RESOURCE ───
  if (lower.includes('cuda out of memory') || lower.includes('cuda_oom') || (lower.includes('out of memory') && lower.includes('cuda'))) {
    return new DeployError('RESOURCE', 'RES_CUDA_OOM', { ...context, used: extractNumber(message, 'used'), total: extractNumber(message, 'total'), model: extractModel(message) }, cause);
  }
  if (lower.includes('oom') || lower.includes('oom-killer') || lower.includes('killed process')) {
    return new DeployError('RESOURCE', 'RES_HOST_OOM', { ...context }, cause);
  }
  if (lower.includes('no space left') || lower.includes('enospc') || lower.includes('disk full')) {
    return new DeployError('RESOURCE', 'RES_DISK_FULL', { ...context }, cause);
  }
  if (lower.includes('insufficient vram') || lower.includes('not enough vram')) {
    return new DeployError('RESOURCE', 'RES_VRAM_INSUFFICIENT', { ...context, required: extractNumber(message, 'required'), available: extractNumber(message, 'available'), gpu: extractGpuType(message) }, cause);
  }
  if (lower.includes('swap') && (lower.includes('thrash') || lower.includes('pressure'))) {
    return new DeployError('RESOURCE', 'RES_SWAP_THRASHING', { ...context }, cause);
  }

  // ─── NETWORK ───
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('dns')) {
    return new DeployError('NETWORK', 'NET_DNS_FAILURE', { ...context, host: extractHost(message) }, cause);
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout') || lower.includes('aborterror')) {
    return new DeployError('NETWORK', 'NET_TIMEOUT', { ...context, timeout: extractNumber(message, 'timeout') }, cause);
  }
  if (lower.includes('toomanyrequests') || (lower.includes('docker') && lower.includes('rate limit') && httpStatus === 429)) {
    return new DeployError('NETWORK', 'NET_DOCKER_HUB_RATE_LIMIT', { ...context }, cause);
  }
  if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('rate-limited') || lower.includes('too many requests')) {
    return new DeployError('NETWORK', 'NET_PROVIDER_RATE_LIMIT', { ...context }, cause);
  }
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return new DeployError('NETWORK', 'NET_CONNECTION_REFUSED', { ...context, host: extractHost(message), port: extractPort(message) }, cause);
  }
  if (lower.includes('bandwidth') || lower.includes('mbps')) {
    return new DeployError('NETWORK', 'NET_BANDWIDTH_LOW', { ...context, mbps: extractNumber(message, 'mbps'), min: extractNumber(message, 'min') }, cause);
  }

  // ─── PROVIDER ───
  if (lower.includes('unauthorized') && (lower.includes('key') || lower.includes('api'))) {
    return new DeployError('PROVIDER', 'PRV_AUTH_FAILED', { ...context }, cause);
  }
  if (lower.includes('no offers') || lower.includes('no gpus') || lower.includes('0 offer')) {
    return new DeployError('PROVIDER', 'PRV_NO_GPUS', { ...context, region: extractRegion(message) }, cause);
  }
  if (lower.includes('offer') && (lower.includes('unavailable') || lower.includes('disappear') || lower.includes('not found'))) {
    return new DeployError('PROVIDER', 'PRV_OFFER_UNAVAILABLE', { ...context, offer: extractOffer(message) }, cause);
  }
  if (lower.includes('template') && (lower.includes('fail') || lower.includes('error'))) {
    return new DeployError('PROVIDER', 'PRV_TEMPLATE_FAILED', { ...context }, cause);
  }
  if (lower.includes('scheduling') && lower.includes('stuck')) {
    return new DeployError('PROVIDER', 'PRV_SCHEDULING_STUCK', { ...context }, cause);
  }
  if (lower.includes('api key') && (lower.includes('expir') || lower.includes('revok'))) {
    return new DeployError('PROVIDER', 'PRV_API_KEY_EXPIRED', { ...context }, cause);
  }

  // ─── CONTAINER ───
  if (lower.includes('image not found') || lower.includes('manifest unknown') || lower.includes('pull access denied')) {
    return new DeployError('CONTAINER', 'CNT_IMAGE_NOT_FOUND', { ...context, image: extractImage(message) }, cause);
  }
  if (lower.includes('eaddrinuse') || (lower.includes('port') && lower.includes('in use'))) {
    return new DeployError('CONTAINER', 'CNT_PORT_CONFLICT', { ...context, port: extractPort(message) }, cause);
  }
  if (lower.includes('health check') && lower.includes('fail')) {
    return new DeployError('CONTAINER', 'CNT_HEALTHCHECK_FAIL', { ...context }, cause);
  }
  if (lower.includes('docker pull') || lower.includes('image pull') || lower.includes('pull failed')) {
    return new DeployError('CONTAINER', 'CNT_PULL_FAILED', { ...context }, cause);
  }
  if (lower.includes('imagepullbackoff') || lower.includes('errimagepull')) {
    return new DeployError('CONTAINER', 'CNT_PULL_BACKOFF', { ...context }, cause);
  }
  if (lower.includes('could not select device driver') || lower.includes('capabilities') && lower.includes('gpu')) {
    return new DeployError('CONTAINER', 'CNT_GPU_DRIVER_MISSING', { ...context }, cause);
  }
  if (lower.includes('container') && lower.includes('fail') && lower.includes('start')) {
    return new DeployError('CONTAINER', 'CNT_START_FAILED', { ...context }, cause);
  }

  // ─── GPU_HARDWARE ───
  if (lower.includes('cuda') && lower.includes('mismatch')) {
    return new DeployError('GPU_HARDWARE', 'GPU_CUDA_MISMATCH', { ...context }, cause);
  }
  if (lower.includes('driver/library version mismatch') || lower.includes('nvidia-smi has failed')) {
    return new DeployError('GPU_HARDWARE', 'GPU_DRIVER_MISMATCH', { ...context }, cause);
  }
  if (lower.includes('ecc') || lower.includes('xid')) {
    return new DeployError('GPU_HARDWARE', 'GPU_ECC_ERROR', { ...context, xid: extractNumber(message, 'xid') }, cause);
  }
  if (lower.includes('thermal') || (lower.includes('temperature') && lower.includes('high'))) {
    return new DeployError('GPU_HARDWARE', 'GPU_THERMAL_THROTTLE', { ...context, temp: extractNumber(message, 'temp'), threshold: 85 }, cause);
  }
  if (lower.includes('nvidia-smi') && lower.includes('fail')) {
    return new DeployError('GPU_HARDWARE', 'GPU_NVML_FAILURE', { ...context }, cause);
  }
  if (lower.includes('pcie') || lower.includes('device vanish') || lower.includes('iommu')) {
    return new DeployError('GPU_HARDWARE', 'GPU_HARDWARE_FAULT', { ...context }, cause);
  }

  // ─── SECURITY ───
  if (lower.includes('tls') || lower.includes('ssl') || lower.includes('certificate')) {
    return new DeployError('SECURITY', 'SEC_TLS_FAILURE', { ...context }, cause);
  }
  if (lower.includes('permission denied') && lower.includes('publickey')) {
    return new DeployError('SECURITY', 'SEC_SSH_KEY_DENIED', { ...context }, cause);
  }
  if (lower.includes('credential') && lower.includes('leak')) {
    return new DeployError('SECURITY', 'SEC_CREDENTIAL_LEAK', { ...context }, cause);
  }
  if (httpStatus === 403 || (lower.includes('forbidden') && !lower.includes('offer'))) {
    return new DeployError('SECURITY', 'SEC_UNAUTHORIZED', { ...context }, cause);
  }

  // ─── STATE ───
  if (lower.includes('race') || lower.includes('concurrent') || lower.includes('simultaneous')) {
    return new DeployError('STATE', 'ST_RACE_CONDITION', { ...context }, cause);
  }
  if (lower.includes('stuck') || lower.includes('hung') || lower.includes('no progress')) {
    return new DeployError('STATE', 'ST_STUCK_DEPLOY', { ...context, duration: extractNumber(message, 'duration') }, cause);
  }
  if (lower.includes('orphan')) {
    return new DeployError('STATE', 'ST_ORPHANED_INSTANCE', { ...context, instanceId: extractInstanceId(message) }, cause);
  }
  if (lower.includes('duplicate') || lower.includes('idempot')) {
    return new DeployError('STATE', 'ST_DUPLICATE_REQUEST', { ...context }, cause);
  }
  if (lower.includes('ghost')) {
    return new DeployError('STATE', 'ST_GHOST_MACHINE', { ...context, duration: extractNumber(message, 'duration') }, cause);
  }
  if (lower.includes('exited') && !lower.includes('container runtime')) {
    return new DeployError('STATE', 'ST_INSTANCE_EXITED', { ...context, code: extractNumber(message, 'code') }, cause);
  }

  // ─── COST ───
  if (lower.includes('budget') && lower.includes('exceed')) {
    return new DeployError('COST', 'CST_BUDGET_EXCEEDED', { ...context, spent: extractNumber(message, 'spent'), budget: extractNumber(message, 'budget') }, cause);
  }
  if (lower.includes('price') && (lower.includes('change') || lower.includes('different'))) {
    return new DeployError('COST', 'CST_PRICE_CHANGE', { ...context, quoted: extractNumber(message, 'quoted'), actual: extractNumber(message, 'actual') }, cause);
  }
  if (lower.includes('runaway') || lower.includes('spending')) {
    return new DeployError('COST', 'CST_RUNAWAY_SPENDING', { ...context, rate: extractNumber(message, 'rate') }, cause);
  }
  if (lower.includes('unreasonable') && lower.includes('price')) {
    return new DeployError('COST', 'CST_UNREASONABLE_PRICE', { ...context, price: extractNumber(message, 'price'), max: extractNumber(message, 'max') }, cause);
  }

  // ─── INFRASTRUCTURE ───
  if (lower.includes('power') || lower.includes('unreachable') || lower.includes('host down')) {
    return new DeployError('INFRASTRUCTURE', 'INF_HOST_POWER_LOSS', { ...context }, cause);
  }
  if (lower.includes('reclaim') || lower.includes('disassociated') || lower.includes('revoked')) {
    return new DeployError('INFRASTRUCTURE', 'INF_HOST_RECLAIM', { ...context }, cause);
  }
  if (lower.includes('creating') && (lower.includes('stuck') || lower.includes('timeout'))) {
    return new DeployError('INFRASTRUCTURE', 'INF_INSTANCE_STUCK', { ...context, duration: extractNumber(message, 'duration') }, cause);
  }
  if (lower.includes('container runtime') && lower.includes('crash')) {
    return new DeployError('INFRASTRUCTURE', 'INF_CONTAINER_RUNTIME_CRASH', { ...context }, cause);
  }
  if (lower.includes('zombie')) {
    return new DeployError('INFRASTRUCTURE', 'INF_ZOMBIE_PROCESS', { ...context }, cause);
  }
  if (lower.includes('credit') && lower.includes('zero')) {
    return new DeployError('INFRASTRUCTURE', 'INF_CREDIT_ZERO', { ...context }, cause);
  }

  // ─── FALLBACK: Generic provider error ───
  return new DeployError('PROVIDER', 'PRV_API_ERROR', { ...context, detail: message }, cause);
}

// ── Helper: Extract Values from Error Messages ────────────────────────────────

function extractField(message: string): string {
  const match = message.match(/field['":\s]+(\w+)/i);
  return match ? match[1] : 'unknown';
}

function extractNumber(message: string, hint: string): number | undefined {
  const match = message.match(new RegExp(`${hint}[^\\d]*(\\d+(?:\\.\\d+)?)`, 'i'));
  return match ? parseFloat(match[1]) : undefined;
}

function extractHost(message: string): string {
  const match = message.match(/([a-zA-Z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : 'unknown';
}

function extractPort(message: string): number | undefined {
  const match = message.match(/port[:\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

function extractImage(message: string): string {
  const match = message.match(/(?:image|repository)['":\s]+([^\s'"]+)/i);
  return match ? match[1] : 'unknown';
}

function extractGpuType(message: string): string {
  const match = message.match(/(NVIDIA[^\s,]+)/i);
  return match ? match[1] : 'unknown';
}

function extractModel(message: string): string {
  const match = message.match(/(\d+[bB])\b/i);
  return match ? match[1] : 'unknown';
}

function extractRegion(message: string): string {
  const match = message.match(/region['":\s]+(\w[\w-]*)/i);
  return match ? match[1] : 'unknown';
}

function extractOffer(message: string): string {
  const match = message.match(/offer['":\s]+(\w+)/i);
  return match ? match[1] : 'unknown';
}

function extractInstanceId(message: string): string {
  const match = message.match(/instance['":\s]+([a-zA-Z0-9-]+)/i);
  return match ? match[1] : 'unknown';
}

// ── Error Aggregation ─────────────────────────────────────────────────────────

export interface ErrorSummary {
  byCategory: Record<ErrorCategory, number>;
  bySeverity: Record<string, number>;
  retryableCount: number;
  nonRetryableCount: number;
  totalErrors: number;
  topErrors: Array<{ code: ErrorCode; count: number; message: string }>;
}

/**
 * Summarize a list of DeployErrors by category, severity, and frequency.
 */
export function summarizeErrors(errors: DeployError[]): ErrorSummary {
  const summary: ErrorSummary = {
    byCategory: {} as Record<ErrorCategory, number>,
    bySeverity: {},
    retryableCount: 0,
    nonRetryableCount: 0,
    totalErrors: errors.length,
    topErrors: [],
  };

  const codeCount = new Map<ErrorCode, { count: number; message: string }>();

  for (const err of errors) {
    summary.byCategory[err.category] = (summary.byCategory[err.category] || 0) + 1;
    summary.bySeverity[err.severity] = (summary.bySeverity[err.severity] || 0) + 1;
    if (err.retryable) summary.retryableCount++;
    else summary.nonRetryableCount++;

    const existing = codeCount.get(err.code);
    if (existing) {
      existing.count++;
    } else {
      codeCount.set(err.code, { count: 1, message: err.message });
    }
  }

  summary.topErrors = Array.from(codeCount.entries())
    .map(([code, data]) => ({ code, count: data.count, message: data.message }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return summary;
}

// ── Quick Error Factory Functions ─────────────────────────────────────────────

/** Create a validation error */
export function validationError(code: 'VLD_INVALID_INPUT' | 'VLD_MISSING_FIELD' | 'VLD_INVALID_FORMAT' | 'VLD_PREFLIGHT_FAILED' | 'VLD_GPU_INCOMPATIBLE' | 'VLD_IMAGE_UNAVAILABLE' | 'VLD_SPEND_RATE_LIMIT', context: DeployErrorContext): DeployError {
  return new DeployError('VALIDATION', code, context);
}

/** Create a resource error */
export function resourceError(code: 'RES_CUDA_OOM' | 'RES_HOST_OOM' | 'RES_DISK_FULL' | 'RES_VRAM_INSUFFICIENT' | 'RES_SWAP_THRASHING' | 'RES_CPU_LIMIT', context: DeployErrorContext): DeployError {
  return new DeployError('RESOURCE', code, context);
}

/** Create a network error */
export function networkError(code: 'NET_DNS_FAILURE' | 'NET_TIMEOUT' | 'NET_DOCKER_HUB_RATE_LIMIT' | 'NET_PROVIDER_RATE_LIMIT' | 'NET_CONNECTION_REFUSED' | 'NET_BANDWIDTH_LOW', context: DeployErrorContext): DeployError {
  return new DeployError('NETWORK', code, context);
}

/** Create a container error */
export function containerError(code: 'CNT_IMAGE_NOT_FOUND' | 'CNT_PORT_CONFLICT' | 'CNT_RUNTIME_CRASH' | 'CNT_HEALTHCHECK_FAIL' | 'CNT_PULL_FAILED' | 'CNT_START_FAILED' | 'CNT_PULL_BACKOFF' | 'CNT_GPU_DRIVER_MISSING', context: DeployErrorContext): DeployError {
  return new DeployError('CONTAINER', code, context);
}

/** Create a GPU hardware error */
export function gpuError(code: 'GPU_CUDA_MISMATCH' | 'GPU_DRIVER_MISMATCH' | 'GPU_ECC_ERROR' | 'GPU_THERMAL_THROTTLE' | 'GPU_HARDWARE_FAULT' | 'GPU_NVML_FAILURE', context: DeployErrorContext): DeployError {
  return new DeployError('GPU_HARDWARE', code, context);
}
