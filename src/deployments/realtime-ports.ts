import type { DeploymentSpec } from './types';

/** WebRTC media range when the spec does not set `realtime.udpPorts` (≈ 2 ports per session per worker slice). */
export const DEFAULT_RT_UDP_PORTS: [number, number] = [50000, 50100];
/** Sessions per replica when neither `realtime.maxSessions` nor the machine type's RT_MAX_SESSIONS says. */
export const DEFAULT_RT_MAX_SESSIONS = 8;
export const EDGE_SESSIONS_PER_WORKER = 6;
export const VAST_MAX_PORTS = 64;
export const VAST_TCP_PORTS = 2;

type RtSpec = Pick<DeploymentSpec, 'realtime' | 'env' | 'envByMachineType' | 'machineType'>;

export function rtMachineEnv(spec: RtSpec): Record<string, string> {
  return { ...(spec.envByMachineType?.[spec.machineType] ?? {}), ...spec.env };
}

export function rtMaxSessions(spec: RtSpec): number {
  return spec.realtime?.maxSessions ?? (Number(rtMachineEnv(spec).RT_MAX_SESSIONS) || DEFAULT_RT_MAX_SESSIONS);
}

export function vastUdpRange(spec: RtSpec): [number, number] | null {
  if (!spec.realtime) return null;
  if (spec.realtime.udpPorts) return spec.realtime.udpPorts;
  const tuning = { ...rtMachineEnv(spec), ...spec.realtime.env };
  const sessions = rtMaxSessions(spec);
  const perWorker = Math.max(1, Number(tuning.RT_SESSIONS_PER_WORKER) || EDGE_SESSIONS_PER_WORKER);
  const workers = Math.max(1, Number(spec.realtime.env?.RT_RTC_WORKERS) || Math.ceil(sessions / perWorker));
  const media = 2 * workers * Math.ceil(sessions / workers);
  return [DEFAULT_RT_UDP_PORTS[0], DEFAULT_RT_UDP_PORTS[0] + media];
}

export function vastPortCount(spec: RtSpec): number {
  const range = vastUdpRange(spec);
  return range ? range[1] - range[0] + 1 + VAST_TCP_PORTS : 1;
}
