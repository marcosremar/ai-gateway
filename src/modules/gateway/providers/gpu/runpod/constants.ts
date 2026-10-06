/**
 * RunPod Client Constants
 */

/** GPU types to try in order of preference.
 *  Must match RunPod's REST API enum values exactly.
 *  Tries RTX 5090 first, then falls back to GPUs with spot availability. */
export const RUNPOD_GPU_FALLBACK = [
  'NVIDIA GeForce RTX 5090',
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A6000',
  'NVIDIA L40S',
  'NVIDIA RTX A5000',
  'NVIDIA A40',
];

/** Full RunPod GPU type names keyed by short display name */
export const RUNPOD_GPU_TYPE_MAP: Record<string, string> = {
  'RTX 3090': 'NVIDIA GeForce RTX 3090',
  RTX3090: 'NVIDIA GeForce RTX 3090',
  'RTX 4090': 'NVIDIA GeForce RTX 4090',
  RTX4090: 'NVIDIA GeForce RTX 4090',
  'RTX 5090': 'NVIDIA GeForce RTX 5090',
  RTX5090: 'NVIDIA GeForce RTX 5090',
  'RTX A5000': 'NVIDIA RTX A5000',
  RTXA5000: 'NVIDIA RTX A5000',
  'RTX A6000': 'NVIDIA RTX A6000',
  RTXA6000: 'NVIDIA RTX A6000',
  A40: 'NVIDIA A40',
  L40S: 'NVIDIA L40S',
  L40: 'NVIDIA L40',
  L4: 'NVIDIA L4',
  H200: 'NVIDIA H200',
  B200: 'NVIDIA B200',
  A100: 'NVIDIA A100 80GB PCIe',
  'A100 80GB SXM': 'NVIDIA A100-SXM4-80GB',
  'A100 80GB PCIe': 'NVIDIA A100 80GB PCIe',
  'A100-SXM4-80GB': 'NVIDIA A100-SXM4-80GB',
  H100: 'NVIDIA H100 80GB HBM3',
  // Legacy mappings (GPUs no longer on RunPod — map to cheapest alternative)
  'RTX 4080': 'NVIDIA GeForce RTX 4090',
  RTX4080: 'NVIDIA GeForce RTX 4090',
  'RTX A4000': 'NVIDIA RTX A5000',
  RTXA4000: 'NVIDIA RTX A5000',
};

/**
 * Map generic region codes → RunPod-specific datacenter IDs.
 * RunPod REST API now requires exact datacenter IDs (e.g. 'EU-RO-1') in
 * dataCenterIds[] — generic codes like 'EU' or 'US' are no longer accepted.
 */
export const RUNPOD_DATACENTER_MAP: Record<string, string[]> = {
  EU: [
    'EU-RO-1',
    'EU-SE-1',
    'EU-CZ-1',
    'EU-NL-1',
    'EU-FR-1',
    'EUR-IS-1',
    'EUR-IS-2',
    'EUR-IS-3',
    'EUR-NO-1',
  ],
  US: [
    'US-TX-3',
    'US-TX-1',
    'US-TX-4',
    'US-IL-1',
    'US-KS-2',
    'US-KS-3',
    'US-GA-1',
    'US-GA-2',
    'US-WA-1',
    'US-CA-2',
    'US-NC-1',
    'US-DE-1',
  ],
  CA: ['CA-MTL-1', 'CA-MTL-2', 'CA-MTL-3'],
  AP: ['AP-JP-1'],
  OC: ['OC-AU-1'],
};

/** API Base URL */
export const RUNPOD_API_BASE = process.env.RUNPOD_API_BASE || 'https://rest.runpod.io/v1';

/** Default boot time in seconds */
export const RUNPOD_BOOT_TIME_SECS = parseInt(process.env.RUNPOD_BOOT_TIME_SECS || '1200', 10);

/** Retry delay in milliseconds */
export const RUNPOD_RETRY_DELAY_MS = parseInt(process.env.RUNPOD_RETRY_DELAY_MS || '2000', 10);

/** Max retries for API calls */
export const RUNPOD_MAX_RETRIES = 2;

/** Timeout for API calls in milliseconds */
export const RUNPOD_TIMEOUT_MS = 30000;

/**
 * Country code → RunPod Secure Cloud datacenter IDs. Lets one `region` string
 * (e.g. 'FR,CH,DE') mean the same thing for RunPod as it does for Vast.ai,
 * which filters by the host's country code.
 */
export const RUNPOD_COUNTRY_DATACENTERS: Record<string, string[]> = {
  FR: ['EU-FR-1'],
  NL: ['EU-NL-1'],
  CZ: ['EU-CZ-1'],
  RO: ['EU-RO-1'],
  SE: ['EU-SE-1'],
  NO: ['EUR-NO-1'],
  IS: ['EUR-IS-1', 'EUR-IS-2', 'EUR-IS-3'],
  US: RUNPOD_DATACENTER_MAP.US,
  CA: RUNPOD_DATACENTER_MAP.CA,
  JP: ['AP-JP-1'],
  AU: ['OC-AU-1'],
};

const RUNPOD_COUNTRY_NAMES: Record<string, string> = {
  FRANCE: 'FR', NETHERLANDS: 'NL', CZECHIA: 'CZ', CZECHREPUBLIC: 'CZ', ROMANIA: 'RO',
  SWEDEN: 'SE', NORWAY: 'NO', ICELAND: 'IS', UNITEDSTATES: 'US', USA: 'US',
  CANADA: 'CA', JAPAN: 'JP', AUSTRALIA: 'AU', EUROPE: 'EU',
};

/**
 * Resolve a region string to RunPod datacenter IDs.
 * 'EU-RO-1'   → ['EU-RO-1']                 (specific datacenter)
 * 'EU'        → ['EU-RO-1', 'EU-SE-1', ...]  (generic region code)
 * 'FR'        → ['EU-FR-1']                 (country code / name)
 * 'FR,CH,DE'  → ['EU-FR-1']                 (list — tokens RunPod has no DC for are skipped)
 * ''          → undefined                   (any datacenter)
 * Returns undefined when nothing resolves, so the pod falls back to any datacenter.
 */
export function resolveDatacenterIds(region: string | undefined): string[] | undefined {
  if (!region) return undefined;
  const ids = new Set<string>();
  for (const raw of region.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    // Already a specific datacenter ID (e.g. 'EU-RO-1', 'US-TX-3')
    if (token.includes('-')) { ids.add(token); continue; }
    const upper = token.toUpperCase().replace(/\s+/g, '');
    const code = RUNPOD_COUNTRY_NAMES[upper] ?? upper;
    for (const id of RUNPOD_DATACENTER_MAP[code] ?? RUNPOD_COUNTRY_DATACENTERS[code] ?? []) ids.add(id);
  }
  return ids.size > 0 ? [...ids] : undefined;
}
