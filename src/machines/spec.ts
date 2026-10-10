import type { ExposedPort } from '../deployments/types';
import type { JobInput, MachineLimits, MachineProvider, MachineRequest } from './types';

export class MachineError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const bad = (message: string) => new MachineError(400, message);
const PROVIDERS: ReadonlyArray<MachineProvider | 'cheapest'> = ['scaleway', 'vast', 'runpod', 'cheapest'];
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{40,4096}( [\w.@+-]{0,100})?$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HOLDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const JOB_PATH_RE = /^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/;
const MAX_PORT_KEYS = 64;

function num(raw: unknown, name: string, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number between ${min} and ${max}`);
  return n;
}

function str(raw: unknown, name: string, re: RegExp, required = true): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw bad(`${name} is required`);
    return undefined;
  }
  if (typeof raw !== 'string' || !re.test(raw)) throw bad(`${name} is not valid`);
  return raw;
}

function portsOf(raw: unknown): ExposedPort[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw bad('ports must list at most 20 entries');
  const ports = raw.map((p: { protocol?: unknown; port?: unknown; to?: unknown }, i) => {
    if (p?.protocol !== 'tcp' && p?.protocol !== 'udp') throw bad(`ports[${i}].protocol must be 'tcp' or 'udp'`);
    const port = num(p.port, `ports[${i}].port`, 1, 65535);
    const to = p.to === undefined ? undefined : num(p.to, `ports[${i}].to`, port, 65535);
    return { protocol: p.protocol, port, ...(to !== undefined ? { to } : {}) } as ExposedPort;
  });
  const count = ports.reduce((n, p) => n + (p.to ?? p.port) - p.port + 1, 0);
  if (count > MAX_PORT_KEYS) throw bad(`ports open ${count} ports; at most ${MAX_PORT_KEYS}`);
  return ports;
}

function envOf(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('env must be an object of strings');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 64) throw bad('env takes at most 64 keys');
  for (const [k, v] of entries) {
    if (!ENV_KEY_RE.test(k) || typeof v !== 'string' || v.length > 8192 || v.includes('\n')) throw bad(`env.${k} is not valid`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export interface MachineInput {
  request: MachineRequest;
  maxHours: number;
  idleMinutes: number;
  holder: string | null;
}

export function parseMachineInput(body: Record<string, unknown>, limits: MachineLimits): MachineInput {
  const provider = body.provider ?? 'cheapest';
  if (!PROVIDERS.includes(provider as MachineProvider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
  if (body.maxHours === undefined) throw bad('maxHours is required: every machine has a hard deadline');
  const onstart = body.onstart;
  if (onstart !== undefined && (typeof onstart !== 'string' || onstart.length > 64 * 1024)) throw bad('onstart must be a string up to 64 KB');
  const request: MachineRequest = {
    provider: provider as MachineRequest['provider'],
    machineType: str(body.machineType, 'machineType', /^[\w .-]{1,64}$/)!,
    maxUsdPerHour: num(body.maxUsdPerHour, 'maxUsdPerHour', 0.001, limits.maxUsdPerHour),
    image: str(body.image, 'image', IMAGE_RE, false) ?? '',
    diskGb: body.diskGb === undefined ? 40 : num(body.diskGb, 'diskGb', 10, 2000),
    ports: portsOf(body.ports),
    env: envOf(body.env),
    ...(onstart ? { onstart: onstart as string } : {}),
  };
  const ssh = str(body.sshPublicKey, 'sshPublicKey', SSH_KEY_RE, false);
  if (ssh) request.sshPublicKey = ssh;
  const zone = str(body.zone, 'zone', /^[a-z]{2}-[a-z]{3}-\d$/, false);
  if (zone) request.zone = zone;
  const near = str(body.near, 'near', /^[A-Z]{2}$/, false);
  if (near) request.near = near;
  if (request.provider !== 'scaleway' && !request.image) throw bad('image is required on vast and runpod (the container the machine runs)');
  return {
    request,
    maxHours: num(body.maxHours, 'maxHours', 0.05, limits.maxHours),
    idleMinutes: body.idleMinutes === undefined ? limits.defaultIdleMinutes : num(body.idleMinutes, 'idleMinutes', 5, limits.maxHours * 60),
    holder: str(body.holder, 'holder', HOLDER_RE, false) ?? null,
  };
}

export interface JobInputSpec {
  command: string;
  inputs: JobInput[];
  output: { url: string; path: string } | null;
}

function httpsUrl(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || raw.length > 4096) throw bad(`${name} must be an https URL`);
  let url: URL;
  try { url = new URL(raw); } catch { throw bad(`${name} must be an https URL`); }
  if (url.protocol !== 'https:' || /['\s]/.test(raw)) throw bad(`${name} must be an https URL`);
  return raw;
}

export function parseJobInput(body: Record<string, unknown>): JobInputSpec {
  const command = body.command;
  if (typeof command !== 'string' || !command.trim() || command.length > 64 * 1024) throw bad('command must be a non-empty string up to 64 KB');
  if (body.onstart !== undefined) throw bad('a job runs `command`; onstart is for machines');
  const rawInputs = body.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > 50) throw bad('inputs must list at most 50 files');
  const inputs = rawInputs.map((f: { url?: unknown; path?: unknown }, i) => ({
    url: httpsUrl(f?.url, `inputs[${i}].url`), path: str(f?.path, `inputs[${i}].path`, JOB_PATH_RE)!,
  }));
  const out = body.output as { url?: unknown; path?: unknown } | undefined;
  const output = out === undefined ? null : { url: httpsUrl(out?.url, 'output.url'), path: str(out?.path, 'output.path', JOB_PATH_RE)! };
  return { command, inputs, output };
}
