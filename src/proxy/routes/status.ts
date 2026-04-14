/**
 * New routes for AI Gateway — status page, health detail, metrics summary.
 *
 * These are wired into the proxy server to provide observability endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  buildStatusReport,
  renderStatusHtml,
  type SystemStatus,
  type ProviderStatus,
  type GpuStatus,
  type RequestStats,
} from '../../middleware/status-page';

// ── In-memory request tracker (lightweight ring buffer) ──────────────────────

interface RequestEntry {
  timestamp: number;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}

const requestLog: RequestEntry[] = [];
const MAX_REQUEST_LOG = 1000;

export function logRequest(entry: Omit<RequestEntry, 'timestamp'>): void {
  requestLog.push({ ...entry, timestamp: Date.now() });
  if (requestLog.length > MAX_REQUEST_LOG) {
    requestLog.shift();
  }
}

/**
 * Handle GET /status — human-readable status page.
 */
export function handleStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  providers: ProviderStatus[] = [],
  gpu: GpuStatus = { available: false },
): void {
  const now = Date.now();
  const lastMinute = requestLog.filter((r) => now - r.timestamp < 60_000).length;
  const recent = requestLog.slice(-100);
  const avgLatency =
    recent.length > 0
      ? Math.round(recent.reduce((sum, r) => sum + r.latencyMs, 0) / recent.length)
      : undefined;
  const errorRate =
    recent.length > 0 ? recent.filter((r) => r.status >= 400).length / recent.length : undefined;

  const requests: RequestStats = {
    total: requestLog.length,
    lastMinute,
    avgLatencyMs: avgLatency,
    errorRate,
  };

  const status = buildStatusReport({
    version: process.env.npm_package_version ?? '0.1.0',
    uptimeSec: Math.round(process.uptime()),
    providers,
    gpu,
    requests,
  });

  const accept = _req.headers.accept ?? '';
  if (accept.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderStatusHtml(status));
  }
}

/**
 * Handle GET /v1/status — JSON-only status endpoint for API consumers.
 */
export function handleV1Status(
  _req: IncomingMessage,
  res: ServerResponse,
  providers: ProviderStatus[] = [],
  gpu: GpuStatus = { available: false },
): void {
  const now = Date.now();
  const lastMinute = requestLog.filter((r) => now - r.timestamp < 60_000).length;
  const recent = requestLog.slice(-100);
  const avgLatency =
    recent.length > 0
      ? Math.round(recent.reduce((sum, r) => sum + r.latencyMs, 0) / recent.length)
      : undefined;

  const status: SystemStatus = buildStatusReport({
    version: process.env.npm_package_version ?? '0.1.0',
    uptimeSec: Math.round(process.uptime()),
    providers,
    gpu,
    requests: {
      total: requestLog.length,
      lastMinute,
      avgLatencyMs: avgLatency,
    },
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status, null, 2));
}
