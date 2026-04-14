/**
 * Background latency scheduler — discovers GPU hosts and probes them on adaptive intervals.
 *
 * On each cycle (every 30min):
 *   1. If intervalMin has elapsed since last discovery → fetch all offers from Vast.ai,
 *      upsert host metadata into the DB (so new hosts are tracked automatically)
 *   2. Probe any hosts that are stale (based on adaptive intervals)
 *
 * Settings persisted to ~/.babelcast/latency-settings.json via deploy-settings.ts
 */

import { getHostsToProbe, saveProbeResult, upsertHostMeta } from './latency-db';
import { probeHostFull } from './gpu-latency';
import { createLogger } from '../src/logger';

const log = createLogger('latency-scheduler');
import {
  loadDeploySettings, saveDeploySettings, getDeploySettingsSnapshot, setLastRunAt,
  getLatencyIntervalMin, setLatencyIntervalMin,
  getLatencyMaxMs, setLatencyMaxMs,
  getGpuPriorityList, setGpuPriorityList, getDefaultGpuPriority,
  getGpuPriorityForProvider, setGpuPriorityForProvider, getDefaultGpuPriorityByProvider,
  getGpuSortBy, setGpuSortBy,
  getDeployTimeoutMin, setDeployTimeoutMin,
  getDeployRegion, setDeployRegion,
  getMinVramGb, setMinVramGb, getPreferSsd, setPreferSsd,
  type GpuSortBy,
} from '../src/gpu-providers/deploy-settings';

// Re-export settings API for backward compat (gpu-handlers, gpu-deploy import from here)
export type { GpuSortBy };
export {
  getLatencyIntervalMin, setLatencyIntervalMin,
  getLatencyMaxMs, setLatencyMaxMs,
  getGpuPriorityList, setGpuPriorityList, getDefaultGpuPriority,
  getGpuPriorityForProvider, setGpuPriorityForProvider, getDefaultGpuPriorityByProvider,
  getGpuSortBy, setGpuSortBy,
  getDeployTimeoutMin, setDeployTimeoutMin,
  getDeployRegion, setDeployRegion,
  getMinVramGb, setMinVramGb, getPreferSsd, setPreferSsd,
};

const CHECK_INTERVAL_MS = 30 * 60_000; // check every 30min; probe based on per-host intervals

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

export function getLatencySchedulerStatus(): {
  intervalMin:           number;
  lastRunAt:             number;
  nextRunAt:             number;
  running:               boolean;
  maxLatencyMs:          number;
  gpuPriorityList:       string[];
  gpuPriorityByProvider: Record<string, string[]>;
  gpuSortBy:             GpuSortBy;
  deployTimeoutMin:      number;
  deployRegion:          string;
  deployDockerImage:     string;
  minVramGb:             number;
  preferSsd:             boolean;
} {
  const s = getDeploySettingsSnapshot();
  return {
    intervalMin:           s.intervalMin,
    lastRunAt:             s.lastRunAt,
    nextRunAt:             s.lastRunAt + s.intervalMin * 60_000,
    running:               _running,
    maxLatencyMs:          s.maxLatencyMs,
    gpuPriorityList:       s.gpuPriorityList,
    gpuPriorityByProvider: s.gpuPriorityByProvider,
    gpuSortBy:             s.gpuSortBy,
    deployTimeoutMin:      s.deployTimeoutMin,
    deployRegion:          s.deployRegion,
    deployDockerImage:     s.deployDockerImage,
    minVramGb:             s.minVramGb,
    preferSsd:             s.preferSsd,
  };
}

export async function startLatencyScheduler(): Promise<void> {
  if (_timer) return;
  await loadDeploySettings();
  const intervalMin = getLatencyIntervalMin();
  const gpuList = getGpuPriorityList();
  log.log(`Scheduler started (check every 30min, discovery every ${intervalMin}min)`);
  log.log(`GPU priority: ${gpuList.map(g => g.replace('NVIDIA ', '').replace('GeForce ', '')).join(' → ')}`);
  setTimeout(() => void runCycle(), 10_000); // short delay on startup
  _timer = setInterval(() => void runCycle(), CHECK_INTERVAL_MS);
}

export function stopLatencyScheduler(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Trigger an immediate probe cycle (from the UI "Run Now" button). */
export async function triggerLatencyRun(): Promise<void> {
  if (_running) return;
  void runCycle(true);
}

/** Is a run currently in progress? */
export function isLatencyRunning(): boolean { return _running; }

async function runCycle(forceDiscovery = false): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    const now = Date.now();
    const s = getDeploySettingsSnapshot();
    const sinceLastRun = now - s.lastRunAt;
    const shouldDiscover = forceDiscovery || sinceLastRun >= s.intervalMin * 60_000;

    if (shouldDiscover) {
      await discoverHosts();
      setLastRunAt(now); // persists automatically
    }

    const stableIntervalMs = s.intervalMin * 60_000;
    const hosts = await getHostsToProbe(Date.now(), stableIntervalMs);
    if (hosts.length === 0) return;

    log.log(`Probing ${hosts.length} stale host(s)`);
    const t = Date.now();
    await Promise.all(hosts.map(async host => {
      try {
        const extraPorts = host.direct_port ? [host.direct_port] : [];
        const result = await probeHostFull(host.host_ip, extraPorts);
        await saveProbeResult(host.host_id, result);
      } catch { /* ignore individual probe failures */ }
    }));
    log.log(`Probed ${hosts.length} host(s) in ${Date.now() - t}ms`);
  } finally {
    _running = false;
  }
}

async function discoverHosts(): Promise<void> {
  const vastApiKey = process.env.VAST_API_KEY || '';
  if (!vastApiKey) return;

  try {
    // Lazy import to avoid circular deps at module load time
    const { vast } = await import('./providers');
    // Use user-configured priority list for discovery (includes all GPU types they care about)
    const gpuTypes = getGpuPriorityList();

    // Fetch all offers (no region filter) to get all hosts globally
    const offers = await vast.listOffers!({ gpuTypes, limit: 500 }, { apiKey: vastApiKey });

    let count = 0;
    for (const offer of offers) {
      if (!offer.hostId || !offer.hostIp) continue;
      await upsertHostMeta(offer.hostId, {
        hostIp:      offer.hostIp,
        provider:    offer.provider    ?? '',
        gpuName:     offer.gpuName     ?? '',
        geolocation: offer.geolocation ?? '',
        priceUsd:    offer.pricePerHr  ?? 0,
        directPort:  offer.hostDirectPort,
      }).catch(() => {});
      count++;
    }
    log.log(`Discovery: ${count} hosts with IPs from ${offers.length} offers`);
  } catch (err) {
    log.warn('Discovery failed:', err instanceof Error ? err.message : String(err));
  }
}
