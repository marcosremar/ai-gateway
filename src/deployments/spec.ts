/**
 * Turns a request body (+ optional profile) into a validated `DeploymentSpec`. Throws `SpecError` with a
 * caller-facing message on bad input; the HTTP layer maps it to 400.
 */

import { autoscaleOf, warmScheduleOf } from './autoscale-spec';
import { VAST_MAX_PORTS, vastPortCount, vastUdpRange } from './realtime-ports';
import { scalingOf } from './scaling-spec';
import { SpecError } from './spec-error';
import type { DeploymentProvider, DeploymentSpec, ExposedPort, FileUrl, Placement, PlacementCandidate, Profile, ProfileSpec, RealtimeSpec } from './types';

export { SpecError };

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;
const ZONE_RE = /^[a-z]{2}-[a-z]{3}-\d$/;
const TYPE_RE = /^[A-Z0-9][A-Z0-9-]{1,40}$/i;
/** Vast GPU names carry spaces (`RTX 5090`, `RTX A6000`); Scaleway types never do (checked per provider in buildSpec). */
const MACHINE_RE = /^[A-Z0-9][A-Z0-9 _-]{1,40}$/i;
const COUNTRY_RE = /^[A-Z]{2}$/;
const PROVIDERS: readonly DeploymentProvider[] = ['scaleway', 'vast'];
/** Placement ladder length: enough for every zone × a few types, small enough to walk in one create. */
export const MAX_CANDIDATES = 20;
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
  'idleAction', 'placements', 'candidates', 'near', 'allowFar', 'maxRttMs', 'minCuda', 'autoscale', 'warmSchedule', 'realtime',
  'scaling', 'fileUrls',
]);
const CANDIDATE_FIELDS = new Set(['provider', 'zone', 'machineType', 'maxEurPerHour']);

function providerOf(value: unknown, field: string): DeploymentProvider {
  if (!PROVIDERS.includes(value as DeploymentProvider)) throw new SpecError(`${field} must be 'scaleway' or 'vast'`);
  return value as DeploymentProvider;
}

function candidatesOf(raw: unknown): PlacementCandidate[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CANDIDATES) {
    throw new SpecError(`candidates must list 1–${MAX_CANDIDATES} entries`);
  }
  return raw.map((entry, i) => {
    const f = `candidates[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SpecError(`${f} must be an object`);
    const c = entry as Record<string, unknown>;
    for (const key of Object.keys(c)) if (!CANDIDATE_FIELDS.has(key)) throw new SpecError(`${f}: unknown field '${key}'`);
    return {
      ...(c.provider !== undefined ? { provider: providerOf(c.provider, `${f}.provider`) } : {}),
      ...(c.zone !== undefined ? { zone: str(c.zone, `${f}.zone`, ZONE_RE) } : {}),
      machineType: str(c.machineType, `${f}.machineType`, MACHINE_RE),
      maxEurPerHour: num(c.maxEurPerHour, `${f}.maxEurPerHour`, 0.001, 50),
    };
  });
}

/** Most alternative placements a spec may list. */
export const MAX_PLACEMENTS = 6;

/** The gateway's own probe port on an exposed replica (80/443 stay with the app). */
export const PROBE_PORT = Number(process.env.DEPLOYMENTS_PROBE_PORT) || 8089;

/**
 * Validates the fields present in `input` (all optional) — used for profiles and as the merge step for specs.
 */
export function parsePartialSpec(input: Record<string, unknown>): ProfileSpec {
  for (const key of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(key)) throw new SpecError(`unknown field '${key}'`);
  }
  const out: ProfileSpec = {};
  if (input.provider !== undefined) out.provider = providerOf(input.provider, 'provider');
  if (input.candidates !== undefined) out.candidates = candidatesOf(input.candidates);
  if (input.near !== undefined) out.near = str(input.near, 'near', COUNTRY_RE);
  if (input.maxRttMs !== undefined) out.maxRttMs = int(input.maxRttMs, 'maxRttMs', 5, 500);
  if (input.minCuda !== undefined) out.minCuda = num(input.minCuda, 'minCuda', 11, 14);
  if (input.allowFar !== undefined) {
    if (typeof input.allowFar !== 'boolean') throw new SpecError('allowFar must be a boolean');
    out.allowFar = input.allowFar;
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
      str(type, 'envByMachineType key', MACHINE_RE);
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
      if (!FILE_KEY_RE.test(key) || key === 'cloud-init') throw new SpecError(`files key '${key}' is invalid`);
      if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(value)) throw new SpecError(`files.${key} must be base64`);
      total += Math.floor(value.length * 3 / 4);
      out2[key] = value;
    }
    if (total > MAX_FILES_BYTES) throw new SpecError(`files total ${total} bytes; at most ${MAX_FILES_BYTES} fit in Scaleway user_data`);
    out.files = out2;
  }
  if (input.fileUrls !== undefined) out.fileUrls = fileUrlsOf(input.fileUrls);
  if (input.minActiveReplicas !== undefined) {
    out.minActiveReplicas = int(input.minActiveReplicas, 'minActiveReplicas', 1, MAX_REPLICAS_PER_DEPLOYMENT);
  }
  if (input.healthPath !== undefined) out.healthPath = str(input.healthPath, 'healthPath', PATH_RE);
  if (input.machineType !== undefined) out.machineType = str(input.machineType, 'machineType', MACHINE_RE);
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
  if (input.realtime !== undefined) out.realtime = realtimeOf(input.realtime);
  if (input.placements !== undefined) out.placements = placementsOf(input.placements);
  if (input.idleAction !== undefined) {
    if (input.idleAction !== 'delete' && input.idleAction !== 'stop') throw new SpecError("idleAction must be 'delete' or 'stop'");
    out.idleAction = input.idleAction;
  }
  if (input.autoscale !== undefined) out.autoscale = autoscaleOf(input.autoscale);
  if (input.warmSchedule !== undefined) out.warmSchedule = warmScheduleOf(input.warmSchedule, MAX_REPLICAS_PER_DEPLOYMENT);
  if (input.scaling !== undefined) out.scaling = input.scaling === null ? undefined : scalingOf(input.scaling);
  return out;
}

export const MAX_FILE_URLS = 64;
const FILE_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const FILE_URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]{1,2000}$/;

function fileUrlsOf(raw: unknown): Record<string, FileUrl> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpecError('fileUrls must be an object of { url, sha256 }');
  const entries = Object.entries(raw);
  if (entries.length > MAX_FILE_URLS) throw new SpecError(`fileUrls lists at most ${MAX_FILE_URLS} files`);
  const out: Record<string, FileUrl> = {};
  for (const [key, value] of entries) {
    if (!FILE_KEY_RE.test(key)) throw new SpecError(`fileUrls key '${key}' is invalid`);
    const file = value as Record<string, unknown> | null;
    if (!file || typeof file !== 'object' || Object.keys(file).some(k => k !== 'url' && k !== 'sha256')) {
      throw new SpecError(`fileUrls.${key} must be { url, sha256 }`);
    }
    out[key] = {
      url: str(file.url, `fileUrls.${key}.url (an https URL)`, FILE_URL_RE),
      sha256: str(file.sha256, `fileUrls.${key}.sha256 (64 hex chars)`, /^[0-9a-f]{64}$/),
    };
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
      const to = (port as { to?: unknown }).to === undefined ? undefined
        : int((port as { to?: unknown }).to, `exposure.ports[${i}].to`, n, Math.min(65535, n + MAX_PORT_RANGE - 1));
      if (n === PROBE_PORT || (to !== undefined && n <= PROBE_PORT && PROBE_PORT <= to)) {
        throw new SpecError(`exposure.ports[${i}]: ${PROBE_PORT} is the gateway's probe port`);
      }
      return { protocol: port.protocol, port: n, ...(to !== undefined && to !== n ? { to } : {}) };
    }),
  };
}

/** Widest port range one rule may open (a TURN relay range, a WebRTC media range). */
export const MAX_PORT_RANGE = 1000;

/**
 * `realtime` (the edge sidecar, docs/realtime-edge.md). The UDP range stays above the well-known and ephemeral-free
 * area (≥ 10000) and below 65535; its size bounds the firewall hole (≤ MAX_PORT_RANGE ports).
 */
function realtimeOf(raw: unknown): RealtimeSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpecError('realtime must be an object');
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!['maxSessions', 'edgeImage', 'udpPorts', 'env'].includes(key)) throw new SpecError(`realtime: unknown field '${key}'`);
  }
  const out: RealtimeSpec = {};
  if (r.maxSessions !== undefined) out.maxSessions = int(r.maxSessions, 'realtime.maxSessions', 1, 256);
  if (r.edgeImage !== undefined) out.edgeImage = str(r.edgeImage, 'realtime.edgeImage', IMAGE_RE);
  if (r.udpPorts !== undefined) {
    if (!Array.isArray(r.udpPorts) || r.udpPorts.length !== 2) throw new SpecError('realtime.udpPorts must be [lo, hi]');
    const lo = int(r.udpPorts[0], 'realtime.udpPorts[0]', 10000, 65535);
    const hi = int(r.udpPorts[1], 'realtime.udpPorts[1]', lo + 1, Math.min(65535, lo + MAX_PORT_RANGE - 1));
    out.udpPorts = [lo, hi];
  }
  if (r.env !== undefined) out.env = edgeTuningOf(r.env);
  return out;
}

/** The edge settings a spec may set (`realtime.env`): what `docker/aigw-edge/aigw_edge` reads and the gateway does not own. */
export const EDGE_TUNING_KEYS = [
  'RT_VAD_SILENCE_MS', 'RT_SILERO_ONNX', 'RT_MAX_SESSION_SECONDS', 'RT_MAX_TURN_SECONDS', 'RT_IDLE_SECONDS',
  'RT_SESSIONS_PER_WORKER', 'RT_RTC_WORKERS', 'EDGE_UPSTREAM_MODE', 'EDGE_UPSTREAM_HEALTH', 'EDGE_STT_PARTIALS',
  'EDGE_SPECULATE_MS', 'EDGE_LLM_MODEL', 'EDGE_TTS_MODEL', 'EDGE_TTS_RATE', 'EDGE_TTS_PARALLEL', 'EDGE_REF_BASE',
  'EDGE_TELEMETRY_STDOUT', 'FIRST_MIN_WORDS', 'MAX_CHUNK_CHARS',
];
const EDGE_TUNING_VALUE_RE = /^[\x20-\x7e]{0,256}$/;

function edgeTuningOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpecError('realtime.env must be an object');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EDGE_TUNING_KEYS.includes(key)) throw new SpecError(`realtime.env: '${key}' is not an edge setting`);
    out[key] = str(value, `realtime.env.${key}`, EDGE_TUNING_VALUE_RE);
  }
  return out;
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
  // Vast rents GPU hosts only.
  if (merged.gpu === undefined) merged.gpu = merged.provider === 'vast' || isGpuMachineType(merged.machineType!);
  const spec = merged as DeploymentSpec;
  if (spec.minReplicas > spec.maxReplicas) throw new SpecError('minReplicas cannot exceed maxReplicas');
  if (spec.provider === 'scaleway') {
    if (!TYPE_RE.test(spec.machineType)) throw new SpecError('machineType is invalid');
    if (spec.gpu && !isGpuMachineType(spec.machineType)) throw new SpecError(`gpu: true needs a GPU machineType (got ${spec.machineType})`);
  }
  // Two ways to say "elsewhere": `placements` (Scaleway, in the given order, at the spec's cap) and `candidates`
  // (ranked, any provider, a cap each). Both at once would leave which one wins to the reader: pick one.
  if (spec.placements?.length && spec.candidates?.length) {
    throw new SpecError('placements and candidates cannot be combined: pick one (send "placements": [] to drop a profile\'s placements)');
  }
  if (spec.placements?.length && spec.provider !== 'scaleway') throw new SpecError('placements are Scaleway only (use candidates for vast)');
  for (const [i, p] of (spec.placements ?? []).entries()) {
    if (p.machineType && isGpuMachineType(p.machineType) !== spec.gpu) {
      throw new SpecError(`placements[${i}].machineType ${p.machineType} must be a ${spec.gpu ? 'GPU' : 'CPU'} type like machineType`);
    }
    if (spec.exposure && p.zone && p.zone !== spec.zone) {
      throw new SpecError(`placements[${i}].zone: an exposed deployment stays in ${spec.zone} (its reserved IP lives there)`);
    }
  }
  for (const [i, c] of (spec.candidates ?? []).entries()) {
    if ((c.provider ?? spec.provider) === 'scaleway' && !TYPE_RE.test(c.machineType)) {
      throw new SpecError(`candidates[${i}].machineType is not a Scaleway type`);
    }
  }
  // A reserved IP and firewall are zonal: an exposed deployment stays in its one zone.
  if (spec.exposure && spec.candidates?.length) throw new SpecError('candidates cannot be combined with exposure (the reserved IP is zonal)');
  const twice = Object.keys(spec.fileUrls ?? {}).find(key => spec.files && key in spec.files);
  if (twice) throw new SpecError(`'${twice}' is in both files and fileUrls`);
  if (usesVast(spec)) checkVastSpec(spec);
  return spec;
}

/** The spec may land on Vast (its provider, or one of its candidates). */
export function usesVast(spec: Pick<DeploymentSpec, 'provider' | 'candidates'>): boolean {
  return spec.provider === 'vast' || (spec.candidates ?? []).some(c => (c.provider ?? spec.provider) === 'vast');
}

/** The spec may land on Scaleway. */
export function usesScaleway(spec: Pick<DeploymentSpec, 'provider' | 'candidates'>): boolean {
  return spec.candidates?.length
    ? spec.candidates.some(c => (c.provider ?? spec.provider) === 'scaleway')
    : spec.provider === 'scaleway';
}

/**
 * Vast runs ONE container per host (no systemd, no Docker-in-Docker): the replica is `image` as the container with
 * `bootScript` as its onstart, the app on `127.0.0.1:<port>`. No user_data metadata service (no `files`: `fileUrls`
 * are downloaded at boot instead), no reserved
 * IP/firewall (no `exposure`), no power-off parking (no `idleAction: 'stop'`). `realtime` runs the edge inside that
 * container, one mapped port per UDP media port (`realtime-ports.ts`). Vast refuses a create whose env passes
 * 32 KB in total (`invalid env arguments, total length > 32KB`, live 2026-10-08), and the init script travels there.
 */
export const VAST_ENV_MAX_BYTES = 32_000;
const VAST_INIT_OVERHEAD_BYTES = 3_000;
const VAST_RT_INIT_OVERHEAD_BYTES = 2_000;
const VAST_PORT_ENV_BYTES = 24;

const VAST_FILE_URL_INIT_BYTES = 40;

export function vastEnvBytes(spec: Pick<DeploymentSpec, 'bootScript' | 'env' | 'envByMachineType' | 'machineType' | 'realtime' | 'fileUrls'>): number {
  const b64 = (n: number) => Math.ceil(n / 3) * 4;
  const sizeOf = (map: Record<string, string> = {}, perEntry = 2) =>
    Object.entries(map).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + perEntry, 0);
  const env = sizeOf({ ...(spec.envByMachineType?.[spec.machineType] ?? {}), ...spec.env });
  const edge = spec.realtime ? VAST_RT_INIT_OVERHEAD_BYTES + b64(sizeOf(spec.realtime.env, 16)) : 0;
  const [lo, hi] = vastUdpRange(spec) ?? [1, 0];
  const urls = Object.entries(spec.fileUrls ?? {}).reduce((n, [key, f]) => n + key.length + f.url.length + f.sha256.length + VAST_FILE_URL_INIT_BYTES, 0);
  return b64(VAST_INIT_OVERHEAD_BYTES + edge + urls + b64(Buffer.byteLength(spec.bootScript ?? '')) + b64(env)) + env
    + (hi - lo + 1) * VAST_PORT_ENV_BYTES;
}

function checkVastSpec(spec: DeploymentSpec): void {
  if (!spec.bootScript || !spec.image) {
    throw new SpecError('vast replicas need bootScript and image (the base container image the script runs in)');
  }
  if (spec.files && Object.keys(spec.files).length) throw new SpecError('files are not supported on vast (no user_data service)');
  if (spec.exposure) throw new SpecError('exposure is not supported on vast');
  if (spec.realtime && vastPortCount(spec) > VAST_MAX_PORTS) {
    throw new SpecError(`realtime on vast maps one port per UDP media port and this spec needs ${vastPortCount(spec)} `
      + `(2 per session per worker + the probe port + 2 TCP); a host gives at most ${VAST_MAX_PORTS}: lower realtime.maxSessions or narrow realtime.udpPorts`);
  }
  if (spec.idleAction === 'stop') throw new SpecError("idleAction 'stop' is not supported on vast");
  const bytes = vastEnvBytes(spec);
  if (bytes > VAST_ENV_MAX_BYTES) {
    throw new SpecError(`vast accepts ${VAST_ENV_MAX_BYTES / 1000} KB of env per instance and this bootScript + env needs about ${Math.ceil(bytes / 1000)} KB `
      + '(the script travels base64 twice): keep bootScript under ~14 KB and download large payloads at boot');
  }
}
