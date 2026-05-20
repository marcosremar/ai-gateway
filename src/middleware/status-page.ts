/**
 * Status page — human-readable endpoint showing system health,
 * provider status, GPU availability, and recent incidents.
 *
 * Accessible at `GET /status` or `GET /v1/status`.
 *
 * Returns HTML for browser viewing or JSON for API consumers.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export interface SystemStatus {
  /** Gateway version */
  version: string;
  /** Uptime in seconds */
  uptimeSec: number;
  /** Current time ISO */
  timestamp: string;
  /** Overall health */
  healthy: boolean;
  /** Provider statuses */
  providers: ProviderStatus[];
  /** GPU status */
  gpu: GpuStatus;
  /** Recent request stats */
  requests: RequestStats;
  /** Budget info */
  budget?: BudgetInfo;
}

export interface ProviderStatus {
  id: string;
  type: 'stt' | 'llm' | 'tts' | 'image';
  healthy: boolean;
  latencyMs?: number;
  lastChecked: string;
  cooldown?: boolean;
}

export interface GpuStatus {
  available: boolean;
  tier?: number;
  status?: string;
  podId?: string;
  gpuType?: string;
  idleSec?: number;
}

export interface RequestStats {
  total: number;
  lastMinute: number;
  avgLatencyMs?: number;
  errorRate?: number;
}

export interface BudgetInfo {
  limit: number;
  spent: number;
  remaining: number;
  percentageUsed: number;
}

/**
 * Build the system status object from gateway state.
 */
export function buildStatusReport(options: {
  version: string;
  uptimeSec: number;
  providers: ProviderStatus[];
  gpu: GpuStatus;
  requests: RequestStats;
  budget?: BudgetInfo;
}): SystemStatus {
  const healthyProviders = options.providers.filter((p) => p.healthy);

  return {
    version: options.version,
    uptimeSec: options.uptimeSec,
    timestamp: new Date().toISOString(),
    healthy: healthyProviders.length > 0,
    providers: options.providers,
    gpu: options.gpu,
    requests: options.requests,
    budget: options.budget,
  };
}

/** HTML-escape a value so it's safe to interpolate as text or in single attribute contexts. */
function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Render status as HTML for browser viewing.
 */
export function renderStatusHtml(status: SystemStatus): string {
  const healthEmoji = status.healthy ? '🟢' : '🔴';
  const uptime = formatUptime(status.uptimeSec);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Gateway — Status</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .healthy { background: #dcfce7; color: #166534; }
    .unhealthy { background: #fee2e2; color: #991b1b; }
    .cooldown { background: #fef3c7; color: #92400e; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; }
    .metric { display: flex; justify-content: space-between; padding: 4px 0; }
    .metric-label { color: #666; }
    .metric-value { font-weight: 600; }
    .budget-bar { height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-top: 8px; }
    .budget-fill { height: 100%; background: linear-gradient(90deg, #22c55e, #eab308, #ef4444); }
  </style>
</head>
<body>
  <h1>${healthEmoji} AI Gateway</h1>
  <p class="subtitle">v${esc(status.version)} · ${esc(uptime)} · ${esc(status.timestamp)}</p>

  <div class="card">
    <h2>Providers</h2>
    <table>
      <thead><tr><th>Provider</th><th>Type</th><th>Status</th><th>Latency</th></tr></thead>
      <tbody>
        ${status.providers
          .map(
            (p) => `
          <tr>
            <td>${esc(p.id)}</td>
            <td>${esc(p.type)}</td>
            <td><span class="status ${p.cooldown ? 'cooldown' : p.healthy ? 'healthy' : 'unhealthy'}">${p.cooldown ? 'COOLDOWN' : p.healthy ? 'HEALTHY' : 'UNHEALTHY'}</span></td>
            <td>${p.latencyMs ? `${esc(p.latencyMs)}ms` : '—'}</td>
          </tr>
        `,
          )
          .join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>GPU</h2>
    <div class="metric"><span class="metric-label">Status</span><span class="metric-value">${esc(status.gpu.status ?? 'N/A')}</span></div>
    ${status.gpu.gpuType ? `<div class="metric"><span class="metric-label">Type</span><span class="metric-value">${esc(status.gpu.gpuType)}</span></div>` : ''}
    ${status.gpu.idleSec !== undefined ? `<div class="metric"><span class="metric-label">Idle</span><span class="metric-value">${esc(status.gpu.idleSec)}s</span></div>` : ''}
    ${status.gpu.podId ? `<div class="metric"><span class="metric-label">Pod</span><span class="metric-value">${esc(status.gpu.podId)}</span></div>` : ''}
  </div>

  <div class="card">
    <h2>Requests</h2>
    <div class="metric"><span class="metric-label">Total</span><span class="metric-value">${Number(status.requests.total) || 0}</span></div>
    <div class="metric"><span class="metric-label">Last minute</span><span class="metric-value">${Number(status.requests.lastMinute) || 0}</span></div>
    ${status.requests.avgLatencyMs ? `<div class="metric"><span class="metric-label">Avg latency</span><span class="metric-value">${Number(status.requests.avgLatencyMs) || 0}ms</span></div>` : ''}
    ${status.requests.errorRate !== undefined ? `<div class="metric"><span class="metric-label">Error rate</span><span class="metric-value">${(Number(status.requests.errorRate) * 100).toFixed(1)}%</span></div>` : ''}
  </div>

  ${
    status.budget
      ? `
    <div class="card">
      <h2>Budget</h2>
      <div class="metric"><span class="metric-label">Spent</span><span class="metric-value">$${(Number(status.budget.spent) || 0).toFixed(2)}</span></div>
      <div class="metric"><span class="metric-label">Limit</span><span class="metric-value">$${(Number(status.budget.limit) || 0).toFixed(2)}</span></div>
      <div class="metric"><span class="metric-label">Remaining</span><span class="metric-value">$${(Number(status.budget.remaining) || 0).toFixed(2)}</span></div>
      <div class="budget-bar"><div class="budget-fill" style="width: ${Math.max(0, Math.min(100, Number(status.budget.percentageUsed) || 0))}%"></div></div>
    </div>
  `
      : ''
  }
</body>
</html>`;
}

/**
 * Handle status requests — returns HTML or JSON based on Accept header.
 */
export function handleStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  buildStatus: () => SystemStatus,
): void {
  const accept = req.headers.accept ?? '';
  const status = buildStatus();

  if (accept.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderStatusHtml(status));
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
