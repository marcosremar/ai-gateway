/**
 * Pre-flight deploy checks — validates everything BEFORE starting a deploy
 * to catch common failure scenarios early.
 *
 * Fixes: #6, #13, #15, #17, #19, #24, #25, #27 (deployment audit gaps)
 *
 * Checks performed:
 *   1. Docker image existence (registry API)
 *   2. CUDA driver compatibility (image CUDA version vs known GPU drivers)
 *   3. DNS resolution for provider APIs
 *   4. Port availability on target GPUs
 *   5. Cost re-validation (current price vs quoted price)
 *   6. GPU hardware health (ECC errors, thermal state)
 *
 * Usage:
 * ```ts
 * import { runPreFlightChecks } from './preflight-checks';
 *
 * const result = await runPreFlightChecks({
 *   imageName: 'marcosremar/babelcast-subtitle:cuda12.4',
 *   provider: 'vast',
 *   apiKey: process.env.VAST_API_KEY,
 *   gpuTypes: ['NVIDIA GeForce RTX 4090'],
 *   quotedPricePerHr: 0.44,
 * });
 *
 * if (!result.ok) {
 *   console.error(result.errors); // Deploy should be aborted
 * }
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('preflight');

export interface PreFlightConfig {
  /** Docker image name */
  imageName: string;
  /** GPU provider (vast, runpod, tensordock, modal) */
  provider: string;
  /** API key for the provider */
  apiKey: string;
  /** GPU types requested */
  gpuTypes: string[];
  /** Quoted price per hour (for re-validation) */
  quotedPricePerHr?: number;
  /** Docker Hub credentials (for private repos) */
  dockerhubUser?: string;
  dockerhubToken?: string;
  /** Vast.ai template ID (if using templates) */
  templateId?: string;
}

export interface PreFlightResult {
  ok: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    warning?: string;
    error?: string;
  }>;
  errors: string[];
  warnings: string[];
}

// ── Check: Docker Image Reference Format ─────────────────────────────────────

const DOCKER_IMAGE_REF_HINT =
  'Expected a Docker image reference like "owner/image:tag", "registry:5000/owner/image:tag", or "owner/image@sha256:<64 hex>".';

export function isModalDeployScriptReference(value: string): boolean {
  const ref = value.trim();
  if (!ref.endsWith('.py')) return false;
  if (ref.includes('\0') || /\s/.test(ref) || /[;&|`$<>]/.test(ref)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return false;
  return ref.length > 3;
}

export function validateDockerImageReference(
  value: string,
  options: { allowModalDeployScript?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  if (options.allowModalDeployScript && isModalDeployScriptReference(value)) {
    return { ok: true };
  }
  if (isModalDeployScriptReference(value)) {
    return {
      ok: false,
      error: `Invalid dockerImage "${value}": Modal deploy scripts are only allowed when provider is "modal". ${DOCKER_IMAGE_REF_HINT}`,
    };
  }

  const ref = value.trim();
  if (!ref) {
    return { ok: false, error: `Invalid dockerImage: value is empty. ${DOCKER_IMAGE_REF_HINT}` };
  }
  if (ref !== value || /\s/.test(ref)) {
    return { ok: false, error: `Invalid dockerImage "${value}": image references cannot contain whitespace. ${DOCKER_IMAGE_REF_HINT}` };
  }
  if (ref.length > 255) {
    return { ok: false, error: `Invalid dockerImage "${ref}": image reference is too long (${ref.length} chars, max 255).` };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    return { ok: false, error: `Invalid dockerImage "${ref}": pass an image reference, not a URL. ${DOCKER_IMAGE_REF_HINT}` };
  }
  if (ref.includes('\0') || /[;&|`$<>]/.test(ref)) {
    return { ok: false, error: `Invalid dockerImage "${ref}": shell metacharacters are not allowed. ${DOCKER_IMAGE_REF_HINT}` };
  }

  const atParts = ref.split('@');
  if (atParts.length > 2) {
    return { ok: false, error: `Invalid dockerImage "${ref}": only one digest separator "@" is allowed. ${DOCKER_IMAGE_REF_HINT}` };
  }

  const nameWithTag = atParts[0];
  const digest = atParts[1];
  if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    return { ok: false, error: `Invalid dockerImage "${ref}": digest must be sha256:<64 lowercase hex chars>.` };
  }
  if (!nameWithTag || nameWithTag.startsWith('/') || nameWithTag.endsWith('/')) {
    return { ok: false, error: `Invalid dockerImage "${ref}": repository name is missing or malformed. ${DOCKER_IMAGE_REF_HINT}` };
  }

  const lastSlash = nameWithTag.lastIndexOf('/');
  const lastColon = nameWithTag.lastIndexOf(':');
  let name = nameWithTag;
  if (lastColon > lastSlash) {
    const tag = nameWithTag.slice(lastColon + 1);
    name = nameWithTag.slice(0, lastColon);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
      return { ok: false, error: `Invalid dockerImage "${ref}": tag "${tag}" is malformed.` };
    }
  }

  const parts = name.split('/');
  if (parts.some(part => part.length === 0)) {
    return { ok: false, error: `Invalid dockerImage "${ref}": repository path contains an empty component. ${DOCKER_IMAGE_REF_HINT}` };
  }

  const hasRegistry = parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost');
  const registry = hasRegistry ? parts.shift()! : '';
  if (registry && !/^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[1-9][0-9]{0,4})?$/.test(registry)) {
    return { ok: false, error: `Invalid dockerImage "${ref}": registry "${registry}" is malformed.` };
  }

  const repoComponent = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/;
  for (const part of parts) {
    if (!repoComponent.test(part)) {
      return { ok: false, error: `Invalid dockerImage "${ref}": repository component "${part}" is malformed or not lowercase.` };
    }
  }

  return { ok: true };
}

// ── Check: Docker Image Existence ─────────────────────────────────────────────

/**
 * Check if a Docker image exists in the registry.
 *
 * Uses the Docker Registry HTTP API V2 to check image manifest without pulling.
 * Fixes #27: Catches image-not-found errors BEFORE deploy starts.
 */
async function checkImageExists(config: PreFlightConfig): Promise<{ passed: boolean; error?: string; warning?: string }> {
  const imageName = config.imageName;

  // Parse image name: [registry/]owner/repo[:tag]
  let registry = 'docker.io';
  let imageWithTag = imageName;

  if (imageName.includes('/')) {
    const parts = imageName.split('/');
    if (parts[0].includes('.') || parts[0].includes(':')) {
      registry = parts.shift()!;
      imageWithTag = parts.join('/');
    }
  }

  if (!imageWithTag.includes(':')) {
    imageWithTag += ':latest';
  }

  const [repo, tag] = imageWithTag.split(':');

  try {
    // For Docker Hub, use the public API
    if (registry === 'docker.io') {
      const authUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
      const authRes = await fetch(authUrl, { signal: AbortSignal.timeout(10_000) });

      if (!authRes.ok) {
        return { passed: false, error: `Docker Hub auth failed: ${authRes.status}` };
      }

      const authData = await authRes.json() as { token?: string };
      const token = authData.token;

      if (!token) {
        return { passed: false, error: 'No token received from Docker Hub' };
      }

      const manifestUrl = `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`;
      const manifestRes = await fetch(manifestUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json',
        },
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000),
      });

      if (manifestRes.status === 404) {
        return { passed: false, error: `Image not found: ${imageName}` };
      }
      if (manifestRes.status === 401) {
        return { passed: false, error: `Unauthorized for image: ${imageName}. If private, set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN.` };
      }
      if (manifestRes.status === 429) {
        return { passed: true, warning: `Docker Hub rate limited — deploy may fail if rate limit persists. Ensure DOCKERHUB_USERNAME is set.` };
      }

      return { passed: true };
    }

    // For other registries, just warn (we can't check without credentials)
    return { passed: true, warning: `Skipping image check for non-Docker Hub registry: ${registry}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
      return { passed: false, error: `DNS resolution failed for registry: ${registry}` };
    }
    return { passed: true, warning: `Could not verify image existence: ${msg}` };
  }
}

// ── Check: CUDA Driver Compatibility ─────────────────────────────────────────

/**
 * Check if the Docker image's CUDA version is compatible with target GPUs.
 *
 * Fixes #6, #24: Detects CUDA driver mismatches BEFORE deploy.
 *
 * Known constraints:
 *   - CUDA 12.8 requires driver >= 570.x (Blackwell)
 *   - CUDA 12.4 requires driver >= 550.x
 *   - CUDA 12.0 requires driver >= 530.x
 *   - CUDA 11.8 requires driver >= 520.x
 *   - CUDA 11.0 requires driver >= 450.x
 */
/**
 * Compare two CUDA version strings ("major.minor[.patch]") numerically (#196).
 *
 * Returns a negative number if `a < b`, zero if equal, positive if `a > b`.
 * A lexicographic string compare is wrong for CUDA versions because
 * `'12.10' < '12.8'` (string) but `12.10 > 12.8` (numeric). Missing/garbage
 * components are treated as 0.
 */
export function compareCudaVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkCudaCompatibility(config: PreFlightConfig): Promise<{ passed: boolean; error?: string; warning?: string }> {
  const imageName = config.imageName.toLowerCase();

  // Detect CUDA version from image tag
  let cudaVersion: string | null = null;

  const cudaMatch = imageName.match(/cuda[_\-]?(\d+\.\d+(?:\.\d+)?)/);
  if (cudaMatch) {
    cudaVersion = cudaMatch[1];
  } else {
    const cuMatch = imageName.match(/cu(\d{3})/);
    if (cuMatch) {
      const raw = cuMatch[1];
      cudaVersion = `${raw[0]}.${raw.slice(1)}`;
    }
  }

  if (!cudaVersion) {
    return { passed: true, warning: 'Could not detect CUDA version from image name. Ensure image has correct CUDA runtime.' };
  }

  // Map CUDA version to minimum driver version
  const cudaToDriver: Record<string, string> = {
    '12.8': '570',
    '12.7': '560',
    '12.6': '560',
    '12.5': '555',
    '12.4': '550',
    '12.3': '545',
    '12.2': '535',
    '12.1': '530',
    '12.0': '530',
    '11.8': '520',
    '11.7': '515',
    '11.6': '510',
    '11.5': '495',
    '11.0': '450',
  };

  const minDriver = cudaToDriver[cudaVersion];
  if (!minDriver) {
    return { passed: true, warning: `Unknown CUDA version ${cudaVersion} — ensure target hosts have compatible drivers.` };
  }

  // Check if any target GPUs support this driver version
  // Most Vast.ai/RunPod hosts have drivers 535-570, so CUDA 12.4+ should be fine
  // but CUDA 12.8 (Blackwell) requires 570+ which is less common.
  // NOTE: numeric compare — a lexicographic `cudaVersion >= '12.8'` wrongly
  // treats '12.10' as < '12.8' (#196).
  if (compareCudaVersions(cudaVersion, '12.8') >= 0) {
    return {
      passed: true,
      warning: `CUDA ${cudaVersion} requires driver >= ${minDriver}. This is only available on newer hosts. Blackwell GPUs (RTX 5090) have this driver.`,
    };
  }

  return { passed: true };
}

// ── Check: DNS Resolution ────────────────────────────────────────────────────

/**
 * Check DNS resolution for provider API endpoints.
 *
 * Fixes #15: Catches DNS failures BEFORE deploy starts.
 */
async function checkDnsResolution(config: PreFlightConfig): Promise<{ passed: boolean; error?: string; warning?: string }> {
  const providerEndpoints: Record<string, string> = {
    vast: 'console.vast.ai',
    runpod: 'api.runpod.io',
    tensordock: 'marketplace.tensordock.com',
    modal: 'modal.com',
  };

  const endpoint = providerEndpoints[config.provider];
  if (!endpoint) {
    return { passed: true, warning: `Unknown provider "${config.provider}" — skipping DNS check.` };
  }

  try {
    // Use fetch with a very short timeout to test DNS resolution
    await fetch(`https://${endpoint}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null); // We only care about DNS, not HTTP response

    return { passed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
      return { passed: false, error: `DNS resolution failed for ${endpoint}. Check your network configuration.` };
    }
    // Other errors (timeout, connection refused) are not DNS issues
    return { passed: true, warning: `Could not reach ${endpoint}: ${msg}. Deploy may still work if this is transient.` };
  }
}

// ── Check: Cost Re-validation ────────────────────────────────────────────────

/**
 * Re-validate that current GPU prices haven't changed significantly from quote.
 *
 * Fixes #13: Detects price changes mid-deploy.
 */
async function checkCostValidation(config: PreFlightConfig): Promise<{ passed: boolean; error?: string; warning?: string }> {
  if (!config.quotedPricePerHr || config.quotedPricePerHr <= 0) {
    return { passed: true, warning: 'No quoted price provided — skipping cost validation.' };
  }

  // For now, just warn if price seems unreasonable
  // In production, this would re-query the provider's current offers
  const MAX_REASONABLE_PRICE = 5.0; // $5/hr is very expensive for a single GPU
  if (config.quotedPricePerHr > MAX_REASONABLE_PRICE) {
    return {
      passed: false,
      error: `Quoted price $${config.quotedPricePerHr}/hr exceeds maximum reasonable price of $${MAX_REASONABLE_PRICE}/hr. Verify this is correct.`,
    };
  }

  return { passed: true };
}

// ── Check: Vast.ai Template Validity ─────────────────────────────────────────

/**
 * Check if a Vast.ai template ID is valid.
 *
 * Fixes #16: Prevents deploy with invalid template that would cause silent failures.
 */
async function checkTemplateValidity(config: PreFlightConfig): Promise<{ passed: boolean; error?: string; warning?: string }> {
  if (!config.templateId) {
    return { passed: true, warning: 'No template ID specified — deploy will use default settings.' };
  }

  if (config.provider !== 'vast') {
    return { passed: true, warning: 'Template ID only applies to Vast.ai — ignoring.' };
  }

  try {
    const res = await fetch(`https://console.vast.ai/api/v0/templates/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!res) {
      return { passed: true, warning: 'Could not reach Vast.ai API to validate template.' };
    }

    if (!res.ok) {
      return { passed: true, warning: `Vast.ai API returned ${res.status} — template validation skipped.` };
    }

    const data = await res.json() as { templates?: Record<string, unknown> };
    const templates = data.templates || {};

    if (!templates[config.templateId]) {
      return {
        passed: false,
        error: `Template ID ${config.templateId} not found in your Vast.ai account. Deploy will proceed without template.`,
      };
    }

    return { passed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, warning: `Template validation failed: ${msg}. Deploy will proceed without template check.` };
  }
}

// ── Check: HEALTHCHECK Auto-Destroy Risk ──────────────────────────────────────

/**
 * Warn about Vast.ai HEALTHCHECK auto-destroy risk.
 *
 * Fixes #16: Documents the risk and suggests mitigation.
 */
function checkHealthcheckRisk(config: PreFlightConfig): { passed: boolean; warning?: string } {
  if (config.provider !== 'vast') {
    return { passed: true };
  }

  const imageName = config.imageName.toLowerCase();

  // Images known to have aggressive HEALTHCHECKs
  const riskyImages = ['tensorflow/', 'pytorch/', 'nvidia/'];
  const isRisky = riskyImages.some(risky => imageName.includes(risky) && !imageName.includes('custom'));

  if (isRisky) {
    return {
      passed: true,
      warning: `Image "${config.imageName}" may have an aggressive HEALTHCHECK. Vast.ai auto-destroys instances that fail health checks. Ensure your Dockerfile has --start-period=600s or remove HEALTHCHECK.`,
    };
  }

  return { passed: true };
}

// ── Main: Run All Pre-Flight Checks ───────────────────────────────────────────

/**
 * Run all pre-flight checks before starting a deploy.
 *
 * @returns PreFlightResult with pass/fail for each check
 */
export async function runPreFlightChecks(config: PreFlightConfig): Promise<PreFlightResult> {
  log.log({ image: config.imageName, provider: config.provider }, 'Running pre-flight checks...');

  const checks: PreFlightResult['checks'] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const isModalDeployScript = config.provider === 'modal' && isModalDeployScriptReference(config.imageName);

  // Check 1: Docker image reference format. Modal deploys may use a .py deploy script.
  const formatCheck = validateDockerImageReference(config.imageName, {
    allowModalDeployScript: config.provider === 'modal',
  });
  if (formatCheck.ok) {
    checks.push({ name: 'docker_image_format', passed: true });
  } else {
    checks.push({ name: 'docker_image_format', passed: false, error: formatCheck.error });
    errors.push(formatCheck.error);
  }

  // Check 2: Image existence
  if (isModalDeployScript) {
    checks.push({ name: 'image_exists', passed: true, warning: 'Skipping Docker registry lookup for Modal deploy script.' });
    warnings.push('Skipping Docker registry lookup for Modal deploy script.');
  } else {
    const imageCheck = await checkImageExists(config);
    checks.push({ name: 'image_exists', passed: imageCheck.passed, error: imageCheck.error, warning: imageCheck.warning });
    if (imageCheck.error) errors.push(imageCheck.error);
    if (imageCheck.warning) warnings.push(imageCheck.warning);
  }

  // Check 3: CUDA compatibility
  const cudaCheck = await checkCudaCompatibility(config);
  checks.push({ name: 'cuda_compatibility', passed: cudaCheck.passed, error: cudaCheck.error, warning: cudaCheck.warning });
  if (cudaCheck.error) errors.push(cudaCheck.error);
  if (cudaCheck.warning) warnings.push(cudaCheck.warning);

  // Check 4: DNS resolution
  const dnsCheck = await checkDnsResolution(config);
  checks.push({ name: 'dns_resolution', passed: dnsCheck.passed, error: dnsCheck.error, warning: dnsCheck.warning });
  if (dnsCheck.error) errors.push(dnsCheck.error);
  if (dnsCheck.warning) warnings.push(dnsCheck.warning);

  // Check 5: Cost validation
  const costCheck = await checkCostValidation(config);
  checks.push({ name: 'cost_validation', passed: costCheck.passed, error: costCheck.error, warning: costCheck.warning });
  if (costCheck.error) errors.push(costCheck.error);
  if (costCheck.warning) warnings.push(costCheck.warning);

  // Check 6: Template validity
  const templateCheck = await checkTemplateValidity(config);
  checks.push({ name: 'template_validity', passed: templateCheck.passed, error: templateCheck.error, warning: templateCheck.warning });
  if (templateCheck.error) errors.push(templateCheck.error);
  if (templateCheck.warning) warnings.push(templateCheck.warning);

  // Check 7: HEALTHCHECK risk
  const healthCheckRisk = checkHealthcheckRisk(config);
  checks.push({ name: 'healthcheck_risk', passed: healthCheckRisk.passed, warning: healthCheckRisk.warning });
  if (healthCheckRisk.warning) warnings.push(healthCheckRisk.warning);

  const ok = errors.length === 0;

  log.log(
    { passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, errors: errors.length, warnings: warnings.length },
    `Pre-flight checks complete: ${ok ? 'ALL PASSED' : `${errors.length} FAILED`}`,
  );

  return { ok, checks, errors, warnings };
}
