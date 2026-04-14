/**
 * Workload HTTP Handlers — unified REST API for GPU, bot, and DB workloads.
 *
 * GET    /v1/workloads           → list all
 * POST   /v1/workloads           → deploy { name, type, config }
 * GET    /v1/workloads/:id       → status
 * POST   /v1/workloads/:id/stop  → stop
 * POST   /v1/workloads/:id/start → start / resume
 * DELETE /v1/workloads/:id       → terminate
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getOrCreateRequestId, setRequestIdHeader, readJsonBody, handleBodyError } from './http-utils';
import { workloadRegistry } from '../src/workloads/registry';
import type { WorkloadConfig, WorkloadType } from '../src/workloads/types';
import { createLogger } from '../src/logger';

const log = createLogger('workload-handlers');

// ── List all workloads ──────────────────────────────────────────────────────

export async function handleWorkloadList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);

  const type = new URL(_req.url || '/', 'http://localhost').searchParams.get('type') as WorkloadType | null;
  const workloads = type ? workloadRegistry.listByType(type) : workloadRegistry.list();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ workloads }));
}

// ── Deploy a new workload ───────────────────────────────────────────────────

export async function handleWorkloadDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const name = body.name as string;
  const type = body.type as WorkloadType;

  if (!name || !type) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'name and type are required' }));
    return;
  }

  if (!['gpu', 'bot', 'db'].includes(type)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid workload type: ${type}. Must be gpu, bot, or db` }));
    return;
  }

  // Build typed config from body
  const config = { ...body.config as Record<string, unknown> || {}, type } as WorkloadConfig;

  try {
    const workload = await workloadRegistry.deploy(name, config);
    log.log(`Workload deployed: ${workload.type}/${workload.name} (${workload.id})`);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Workload deploy failed: ${msg}`);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

// ── Get workload status ─────────────────────────────────────────────────────

export async function handleWorkloadStatus(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const workload = workloadRegistry.get(id);
  if (!workload) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Workload "${id}" not found` }));
    return;
  }

  try {
    const updated = await workloadRegistry.refreshStatus(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workload));
  }
}

// ── Stop workload ───────────────────────────────────────────────────────────

export async function handleWorkloadStop(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const workload = await workloadRegistry.stop(id);
    log.log(`Workload stopped: ${workload.type}/${workload.name}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

// ── Start / Resume workload ─────────────────────────────────────────────────

export async function handleWorkloadStart(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const workload = await workloadRegistry.start(id);
    log.log(`Workload started: ${workload.type}/${workload.name}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

// ── Terminate workload ──────────────────────────────────────────────────────

export async function handleWorkloadTerminate(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    await workloadRegistry.terminate(id);
    log.log(`Workload terminated: ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

// ── Route dispatcher ────────────────────────────────────────────────────────

/**
 * Route a request to the correct workload handler.
 * Returns true if the request was handled, false otherwise.
 *
 * Expects urls like:
 *   /v1/workloads
 *   /v1/workloads/<id>
 *   /v1/workloads/<id>/stop
 *   /v1/workloads/<id>/start
 */
export function routeWorkloadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): boolean {
  // GET/POST /v1/workloads
  if (pathname === '/v1/workloads') {
    if (method === 'GET') { handleWorkloadList(req, res); return true; }
    if (method === 'POST') { handleWorkloadDeploy(req, res); return true; }
    return false;
  }

  // Match /v1/workloads/:id[/action]
  const match = pathname.match(/^\/v1\/workloads\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return false;

  const id = match[1];
  const action = match[2]; // undefined, "stop", "start"

  if (!action) {
    if (method === 'GET') { handleWorkloadStatus(req, res, id); return true; }
    if (method === 'DELETE') { handleWorkloadTerminate(req, res, id); return true; }
    return false;
  }

  if (method === 'POST') {
    if (action === 'stop') { handleWorkloadStop(req, res, id); return true; }
    if (action === 'start') { handleWorkloadStart(req, res, id); return true; }
  }

  return false;
}
