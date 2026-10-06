/**
 * Turns a request body (+ optional profile) into a validated `DeploymentSpec`. Throws `SpecError` with a
 * caller-facing message on bad input; the HTTP layer maps it to 400.
 */

import type { DeploymentSpec, ExposedPort, Placement, Profile, ProfileSpec } from './types';

export class SpecError extends Error {}

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;
const ZONE_RE = /^[a-z]{2}-[a-z]{3}-\d$/;
const TYPE_RE = /^[A-Z0-9][A-Z0-9-]{1,40}$/i;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GPU commercial types on Scaleway start with the GPU family (L4, L40S, H100, GPU-3070, RENDER…). */
export function isGpuMachineType(type: string): boolean {
  return /^(L4|L40S|H100|H200|B300|GPU|RENDER)/i.test(type);
}

export const SPEC_DEFAULTS = {
  provider: 'scaleway',
  args: [],
  env: {},
  healthPath: '/health',
  machineType: 'L4-1-24G',
  zone: 'fr-par-2',
  minReplicas: 0,
  maxReplicas: 1,
  minActiveReplicas: 1,
  targetInflightPerReplica: 4,
  idleMinutes: 15,
  bootTimeoutMinutes: 30,
  scaleDownDelaySeconds: 300,
  // Under Railway's 5-minute "no data transferred" cut-off, so the caller gets a clean 503 + Retry-After.
  coldStartWaitSeconds: 240,
  maxEurPerHour: 1,
  maxHours: 12,
  paused: false,
} as const satisfies Partial<DeploymentSpec>;

/** Hard ceiling regardless of what a caller asks (protects the bill from a typo). */
export const MAX_REPLICAS_PER_DEPLOYMENT = 10;
/**
 * Scaleway refuses a user_data value above 127 998 bytes ("Data too large"; the Scaleway Terraform provider validates
 * `cloud_init` with StringLenBetween(0, 127998)). Applies to every file key and to the generated cloud-init.
 */
export const USER_DATA_KEY_MAX_BYTES = 127_998;
export const MAX_BOOT_SCRIPT = 90 * 1024; // base64 inside the cloud-init (+33 %) must stay under USER_DATA_KEY_MAX_BYTES
/** Files are packed into ≤ 14 user_data keys of 120 000 bytes (`file-pack.ts`). */
export const MAX_FILES_BYTES = 14 * 120_000;

function int(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    throw new SpecError(`${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function num(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SpecError(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

function str(value: unknown, field: string, re: RegExp): string {
  if (typeof value !== 'string' || !re.test(value)) throw new SpecError(`${field} is invalid`);
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.length > 1024 || v.includes('\n'))) {
    throw new SpecError(`${field} must be an array of single-line strings`);
  }
  if (value.length > 64) throw new SpecError(`${field} has too many entries`);
  return value as string[];
}

function envMap(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new SpecError('env must be an object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!ENV_KEY_RE.test(k)) throw new SpecError(`env key '${k}' is invalid`);
    if (typeof v !== 'string' || v.includes('\n') || v.length > 8192) throw new SpecError(`env ${k} must be a single-line string`);
    out[k] = v;
  }
  return out;
}

const KNOWN_FIELDS = new Set<string>([
  'profile', 'provider', 'image', 'port', 'entrypoint', 'args', 'env', 'envByMachineType', 'registryAuth',
  'healthPath', 'machineType', 'zone', 'osImageId', 'volumeGb', 'gpu', 'minReplicas', 'maxReplicas',
  'targetInflightPerReplica', 'idleMinutes', 'bootTimeoutMinutes', 'scaleDownDelaySeconds', 'coldStartWaitSeconds',
  'maxEurPerHour', 'maxHours', 'paused', 'description', 'bootScript', 'files', 'minActiveReplicas', 'exposure',
  'idleAction', 'placements',
]);

/** Most alternative placements a spec may list. */
export const MAX_PLACEMENTS = 6;

/** The gateway's own probe port on an exposed replica (80/443 stay with the app). */
export const PROBE_PORT = 8089;

/**
 * Validates the fields present in `input` (all optional) — used for profiles and as the merge step for specs.
 */
export function parsePartialSpec(input: Record<string, unknown>): ProfileSpec {
  for (const key of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(key)) throw new SpecError(`unknown field '${key}'`);
  }
  const out: ProfileSpec = {};
  if (input.provider !== undefined) {
    if (input.provider !== 'scaleway') throw new SpecError("provider must be 'scaleway' (the only one supported for now)");
    out.provider = 'scaleway';
  }
  if (input.image !== undefined) out.image = str(input.image, 'image', IMAGE_RE);
  if (input.port !== undefined) out.port = int(input.port, 'port', 1, 65535);
  if (input.entrypoint !== undefined) {
    if (typeof input.entrypoint !== 'string' || !/^[A-Za-z0-9._\-/]{1,200}$/.test(input.entrypoint)) {
      throw new SpecError('entrypoint is invalid');
    }
    out.entrypoint = input.entrypoint;
  }
  if (input.args !== undefined) out.args = strings(input.args, 'args');
  if (input.env !== undefined) out.env = envMap(input.env);
  if (input.envByMachineType !== undefined) {
    const raw = input.envByMachineType as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpecError('envByMachineType must be an object');
    const out2: Record<string, Record<string, string>> = {};
    for (const [type, env] of Object.entries(raw)) {
      str(type, 'envByMachineType key', TYPE_RE);
      out2[type] = envMap(env);
    }
    out.envByMachineType = out2;
  }
  if (input.registryAuth !== undefined) {
    const auth = input.registryAuth as Record<string, unknown> | null;
    if (!auth || typeof auth.username !== 'string' || typeof auth.password !== 'string' || !auth.username || !auth.password) {
      throw new SpecError('registryAuth needs username and password');
    }
    if (auth.server !== undefined) str(auth.server, 'registryAuth.server', /^[a-z0-9.\-:]{1,200}$/i);
    out.registryAuth = { username: auth.username, password: auth.password, ...(auth.server ? { server: auth.server as string } : {}) };
  }
  if (input.bootScript !== undefined) {
    if (typeof input.bootScript !== 'string' || !input.bootScript.trim() || input.bootScript.length > MAX_BOOT_SCRIPT) {
      throw new SpecError(`bootScript must be a non-empty string up to ${MAX_BOOT_SCRIPT / 1024} KB`);
    }
    out.bootScript = input.bootScript;
  }
  if (input.files !== undefined) {
    const files = input.files as Record<string, unknown> | null;
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new SpecError('files must be an object of base64 strings');
    let total = 0;
    const out2: Record<string, string> = {};
    for (const [key, value] of Object.entries(files)) {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(key) || key === 'cloud-init') throw new SpecError(`files key '${key}' is invalid`);
      if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(value)) throw new SpecError(`files.${key} must be base64`);
      total += Math.floor(value.length * 3 / 4);
      out2[key] = value;
    }
    if (total > MAX_FILES_BYTES) throw new SpecError(`files total ${total} bytes; at most ${MAX_FILES_BYTES} fit in Scaleway user_data`);
    out.files = out2;
  }
  if (input.minActiveReplicas !== undefined) {
    out.minActiveReplicas = int(input.minActiveReplicas, 'minActiveReplicas', 1, MAX_REPLICAS_PER_DEPLOYMENT);
  }
  if (input.healthPath !== undefined) out.healthPath = str(input.healthPath, 'healthPath', PATH_RE);
  if (input.machineType !== undefined) out.machineType = str(input.machineType, 'machineType', TYPE_RE);
  if (input.zone !== undefined) out.zone = str(input.zone, 'zone', ZONE_RE);
  if (input.osImageId !== undefined) out.osImageId = str(input.osImageId, 'osImageId', UUID_RE);
  if (input.volumeGb !== undefined) out.volumeGb = int(input.volumeGb, 'volumeGb', 10, 2000);
  if (input.gpu !== undefined) {
    if (typeof input.gpu !== 'boolean') throw new SpecError('gpu must be a boolean');
    out.gpu = input.gpu;
  }
  if (input.minReplicas !== undefined) out.minReplicas = int(input.minReplicas, 'minReplicas', 0, MAX_REPLICAS_PER_DEPLOYMENT);
  if (input.maxReplicas !== undefined) out.maxReplicas = int(input.maxReplicas, 'maxReplicas', 1, MAX_REPLICAS_PER_DEPLOYMENT);
  if (input.targetInflightPerReplica !== undefined) {
    out.targetInflightPerReplica = int(input.targetInflightPerReplica, 'targetInflightPerReplica', 1, 1000);
  }
  if (input.idleMinutes !== undefined) out.idleMinutes = int(input.idleMinutes, 'idleMinutes', 1, 24 * 60);
  if (input.bootTimeoutMinutes !== undefined) out.bootTimeoutMinutes = int(input.bootTimeoutMinutes, 'bootTimeoutMinutes', 2, 180);
  if (input.scaleDownDelaySeconds !== undefined) {
    out.scaleDownDelaySeconds = int(input.scaleDownDelaySeconds, 'scaleDownDelaySeconds', 0, 3600);
  }
  if (input.coldStartWaitSeconds !== undefined) {
    out.coldStartWaitSeconds = int(input.coldStartWaitSeconds, 'coldStartWaitSeconds', 0, 840);
  }
  if (input.maxEurPerHour !== undefined) out.maxEurPerHour = num(input.maxEurPerHour, 'maxEurPerHour', 0.001, 50);
  if (input.maxHours !== undefined) out.maxHours = num(input.maxHours, 'maxHours', 0.25, 24 * 7);
  if (input.paused !== undefined) {
    if (typeof input.paused !== 'boolean') throw new SpecError('paused must be a boolean');
    out.paused = input.paused;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.length > 500) throw new SpecError('description is invalid');
    out.description = input.description;
  }
  if (input.exposure !== undefined) out.exposure = exposureOf(input.exposure);
  if (input.placements !== undefined) out.placements = placementsOf(input.placements);
  if (input.idleAction !== undefined) {
    if (input.idleAction !== 'delete' && input.idleAction !== 'stop') throw new SpecError("idleAction must be 'delete' or 'stop'");
    out.idleAction = input.idleAction;
  }
  return out;
}

function placementsOf(raw: unknown): Placement[] {
  if (!Array.isArray(raw) || raw.length > MAX_PLACEMENTS) throw new SpecError(`placements must list at most ${MAX_PLACEMENTS} entries`);
  return raw.map((p, i) => {
    const entry = p as { zone?: unknown; machineType?: unknown } | null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SpecError(`placements[${i}] must be an object`);
    for (const key of Object.keys(entry)) {
      if (key !== 'zone' && key !== 'machineType') throw new SpecError(`placements[${i}]: unknown field '${key}'`);
    }
    if (entry.zone === undefined && entry.machineType === undefined) throw new SpecError(`placements[${i}] needs zone or machineType`);
    return {
      ...(entry.zone !== undefined ? { zone: str(entry.zone, `placements[${i}].zone`, ZONE_RE) } : {}),
      ...(entry.machineType !== undefined ? { machineType: str(entry.machineType, `placements[${i}].machineType`, TYPE_RE) } : {}),
    };
  });
}

function exposureOf(raw: unknown): { ports: ExposedPort[] } {
  const ports = (raw as { ports?: unknown } | null)?.ports;
  if (!Array.isArray(ports) || ports.length === 0 || ports.length > 20) throw new SpecError('exposure.ports must list 1–20 ports');
  return {
    ports: ports.map((p, i) => {
      const port = p as { protocol?: unknown; port?: unknown };
      if (port.protocol !== 'tcp' && port.protocol !== 'udp') throw new SpecError(`exposure.ports[${i}].protocol must be 'tcp' or 'udp'`);
      const n = int(port.port, `exposure.ports[${i}].port`, 1, 65535);
      if (n === PROBE_PORT) throw new SpecError(`exposure.ports[${i}]: ${PROBE_PORT} is the gateway's probe port`);
      return { protocol: port.protocol, port: n };
    }),
  };
}

/**
 * Full spec = defaults ← profile ← previous spec (on update) ← body. Validates cross-field rules.
 */
export function buildSpec(
  name: string,
  body: Record<string, unknown>,
  opts: { profiles: Map<string, Profile>; previous?: DeploymentSpec },
): DeploymentSpec {
  if (!NAME_RE.test(name)) throw new SpecError('name must be 2–40 chars of [a-z0-9-], not starting/ending with -');
  const { profile: profileName, ...rest } = body;
  let profileSpec: ProfileSpec = {};
  if (profileName !== undefined) {
    const profile = typeof profileName === 'string' ? opts.profiles.get(profileName) : undefined;
    if (!profile) throw new SpecError(`unknown profile '${String(profileName)}'`);
    profileSpec = profile.spec;
  }
  const patch = parsePartialSpec(rest);
  const { description: _profileDescription, ...profileFields } = profileSpec;
  const { description: _patchDescription, ...patchFields } = patch;
  const merged = { ...SPEC_DEFAULTS, ...profileFields, ...(opts.previous ?? {}), ...patchFields, name } as Partial<DeploymentSpec>;
  // A profile chosen explicitly on update re-applies its fields over the previous spec.
  if (opts.previous && profileName !== undefined) Object.assign(merged, profileFields, patchFields);

  if (merged.bootScript) {
    merged.image = merged.image ?? '';
    merged.port = merged.port ?? 8000;
  }
  if (!merged.image && !merged.bootScript) throw new SpecError('image or bootScript is required (or pass a profile that sets one)');
  if (!merged.port) throw new SpecError('port is required (or pass a profile that sets it)');
  if (merged.gpu === undefined) merged.gpu = isGpuMachineType(merged.machineType!);
  const spec = merged as DeploymentSpec;
  if (spec.minReplicas > spec.maxReplicas) throw new SpecError('minReplicas cannot exceed maxReplicas');
  if (spec.gpu && !isGpuMachineType(spec.machineType)) throw new SpecError(`gpu: true needs a GPU machineType (got ${spec.machineType})`);
  for (const [i, p] of (spec.placements ?? []).entries()) {
    if (p.machineType && isGpuMachineType(p.machineType) !== spec.gpu) {
      throw new SpecError(`placements[${i}].machineType ${p.machineType} must be a ${spec.gpu ? 'GPU' : 'CPU'} type like machineType`);
    }
    if (spec.exposure && p.zone && p.zone !== spec.zone) {
      throw new SpecError(`placements[${i}].zone: an exposed deployment stays in ${spec.zone} (its reserved IP lives there)`);
    }
  }
  return spec;
}
