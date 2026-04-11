// ── BabelCast Gateway — Vast.ai Template & Serverless Handlers ───────────────
// Routes for Vast.ai-specific features: template CRUD and serverless endpoints.
//
// Template CRUD:
//   GET    /v1/gpu/vast/templates              — list templates
//   POST   /v1/gpu/vast/templates              — create template
//   PUT    /v1/gpu/vast/templates              — update template (body: {hashId, ...updates})
//   DELETE /v1/gpu/vast/templates/:id          — delete template by numeric ID
//   POST   /v1/gpu/vast/templates/find-or-create — idempotent create
//
// Serverless endpoints:
//   GET    /v1/gpu/vast/endpoints              — list endpoints
//   POST   /v1/gpu/vast/endpoints              — create endpoint
//   DELETE /v1/gpu/vast/endpoints/:id          — delete endpoint
//   POST   /v1/gpu/vast/endpoints/logs         — get endpoint logs (body: {endpointName, endpointApiKey, lines?})
//   POST   /v1/gpu/vast/endpoints/route        — route request (body: {endpointName, endpointApiKey, cost?})
//
// Worker groups:
//   GET    /v1/gpu/vast/workergroups           — list worker groups
//   POST   /v1/gpu/vast/workergroups           — create worker group
//   PUT    /v1/gpu/vast/workergroups/:id        — update worker group
//   DELETE /v1/gpu/vast/workergroups/:id        — delete worker group

import type { IncomingMessage, ServerResponse } from 'http';
import type { VastClient } from '../src/gpu-providers/vast-client';
import { vast } from './providers';
import { deployVastApiKey } from './state';
import { readJsonBody, getOrCreateRequestId, setRequestIdHeader } from './http-utils';

function vastCreds() {
  const apiKey = (deployVastApiKey as string) || process.env.VAST_API_KEY || '';
  return { apiKey };
}

function jsonOk(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonErr(res: ServerResponse, msg: string, status = 400) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function getVast(): VastClient {
  return vast as VastClient;
}

// ── Templates ────────────────────────────────────────────────────────────────

export async function handleVastTemplates(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  try {
    const templates = await getVast().listTemplates(creds);
    jsonOk(res, { templates });
  } catch (e: unknown) {
    jsonErr(res, `listTemplates failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastTemplateCreate(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { name, image, tag, envVars, exposePorts, onstartCmd, diskSpaceGb } = body;
  if (!name || !image) return jsonErr(res, 'name and image are required');

  try {
    const result = await getVast().createTemplate({
      name: String(name),
      image: String(image),
      tag: tag ? String(tag) : undefined,
      envVars: envVars as Record<string, string> | undefined,
      exposePorts: Array.isArray(exposePorts) ? (exposePorts as unknown[]).map(Number) : undefined,
      onstartCmd: onstartCmd ? String(onstartCmd) : undefined,
      diskSpaceGb: diskSpaceGb ? Number(diskSpaceGb) : undefined,
    }, creds);
    jsonOk(res, result);
  } catch (e: unknown) {
    jsonErr(res, `createTemplate failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastTemplateUpdate(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { hashId, name, image, tag, diskSpaceGb, desc } = body;
  if (!hashId) return jsonErr(res, 'hashId is required');

  try {
    const result = await getVast().updateTemplate(String(hashId), {
      name: name ? String(name) : undefined,
      image: image ? String(image) : undefined,
      tag: tag ? String(tag) : undefined,
      diskSpaceGb: diskSpaceGb ? Number(diskSpaceGb) : undefined,
      desc: desc ? String(desc) : undefined,
    }, creds);
    jsonOk(res, result);
  } catch (e: unknown) {
    jsonErr(res, `updateTemplate failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastTemplateDelete(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  // Template ID from query string: DELETE /v1/gpu/vast/templates?id=123
  const url = new URL(req.url || '/', `http://localhost`);
  const idStr = url.searchParams.get('id') || url.searchParams.get('templateId');
  if (!idStr) return jsonErr(res, 'id query param is required');
  const templateId = Number(idStr);
  if (!Number.isFinite(templateId) || templateId <= 0) return jsonErr(res, 'id must be a positive integer');

  try {
    await getVast().deleteTemplate(templateId, creds);
    jsonOk(res, { success: true, templateId });
  } catch (e: unknown) {
    jsonErr(res, `deleteTemplate failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastTemplateFindOrCreate(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { name, image, tag, envVars, exposePorts, onstartCmd, diskSpaceGb } = body;
  if (!name || !image) return jsonErr(res, 'name and image are required');

  try {
    const result = await getVast().findOrCreateTemplate({
      name: String(name),
      image: String(image),
      tag: tag ? String(tag) : undefined,
      envVars: envVars as Record<string, string> | undefined,
      exposePorts: Array.isArray(exposePorts) ? (exposePorts as unknown[]).map(Number) : undefined,
      onstartCmd: onstartCmd ? String(onstartCmd) : undefined,
      diskSpaceGb: diskSpaceGb ? Number(diskSpaceGb) : undefined,
    }, creds);
    jsonOk(res, result);
  } catch (e: unknown) {
    jsonErr(res, `findOrCreateTemplate failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

// ── Serverless Endpoints ─────────────────────────────────────────────────────

export async function handleVastEndpoints(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  try {
    const endpoints = await getVast().listEndpoints(creds);
    jsonOk(res, { endpoints });
  } catch (e: unknown) {
    jsonErr(res, `listEndpoints failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastEndpointCreate(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { name, minLoad, targetUtil, coldMult, coldWorkers, maxWorkers } = body;
  if (!name) return jsonErr(res, 'name is required');

  try {
    const result = await getVast().createEndpoint({
      name: String(name),
      minLoad: minLoad !== undefined ? Number(minLoad) : undefined,
      targetUtil: targetUtil !== undefined ? Number(targetUtil) : undefined,
      coldMult: coldMult !== undefined ? Number(coldMult) : undefined,
      coldWorkers: coldWorkers !== undefined ? Number(coldWorkers) : undefined,
      maxWorkers: maxWorkers !== undefined ? Number(maxWorkers) : undefined,
    }, creds);
    jsonOk(res, result);
  } catch (e: unknown) {
    jsonErr(res, `createEndpoint failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastEndpointDelete(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  const url = new URL(req.url || '/', `http://localhost`);
  const idStr = url.searchParams.get('id') || url.searchParams.get('endpointId');
  if (!idStr) return jsonErr(res, 'id query param is required');
  const endpointId = Number(idStr);
  if (!Number.isFinite(endpointId) || endpointId <= 0) return jsonErr(res, 'id must be a positive integer');

  try {
    const result = await getVast().deleteEndpoint(endpointId, creds);
    jsonOk(res, { success: true, endpointId, ...result });
  } catch (e: unknown) {
    jsonErr(res, `deleteEndpoint failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastEndpointLogs(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { endpointName, endpointApiKey, lines } = body;
  if (!endpointName || !endpointApiKey) return jsonErr(res, 'endpointName and endpointApiKey are required');

  try {
    const logs = await getVast().getEndpointLogs(String(endpointName), String(endpointApiKey), lines ? Number(lines) : 100);
    jsonOk(res, { logs });
  } catch (e: unknown) {
    jsonErr(res, `getEndpointLogs failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastEndpointRoute(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { endpointName, endpointApiKey, cost } = body;
  if (!endpointName || !endpointApiKey) return jsonErr(res, 'endpointName and endpointApiKey are required');

  try {
    const result = await getVast().routeRequest(String(endpointName), String(endpointApiKey), cost ? Number(cost) : 100);
    if (!result) return jsonOk(res, { available: false });
    jsonOk(res, { available: true, ...result });
  } catch (e: unknown) {
    jsonErr(res, `routeRequest failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

// ── Worker Groups ────────────────────────────────────────────────────────────

export async function handleVastWorkerGroups(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  try {
    const workerGroups = await getVast().listWorkerGroups(creds);
    jsonOk(res, { workerGroups });
  } catch (e: unknown) {
    jsonErr(res, `listWorkerGroups failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastWorkerGroupCreate(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { endpointId, endpointName, templateHash, templateId, searchParams, launchArgs, gpuRamGb, minLoad, targetUtil, coldMult, coldWorkers, maxWorkers, testWorkers, image, tag } = body;
  if (!endpointId && !endpointName) return jsonErr(res, 'endpointId or endpointName is required');

  // Auto find-or-create template when image is provided and no templateHash given
  let resolvedTemplateHash = templateHash ? String(templateHash) : undefined;
  if (image && !resolvedTemplateHash) {
    try {
      const tplName = `${String(image).replace(/[^a-z0-9-]/gi, '-')}${tag ? `-${String(tag)}` : ''}`;
      const tpl = await getVast().findOrCreateTemplate({
        name: tplName,
        image: String(image),
        tag: tag ? String(tag) : undefined,
        exposePorts: [8000],
      }, vastCreds());
      resolvedTemplateHash = tpl.hashId;
    } catch (e: unknown) {
      return jsonErr(res, `findOrCreateTemplate failed: ${e instanceof Error ? e.message : e}`, 500);
    }
  }

  try {
    const result = await getVast().createWorkerGroup({
      endpointId: endpointId ? Number(endpointId) : undefined,
      endpointName: endpointName ? String(endpointName) : undefined,
      templateHash: resolvedTemplateHash,
      templateId: templateId ? Number(templateId) : undefined,
      searchParams: searchParams ? String(searchParams) : undefined,
      launchArgs: launchArgs ? String(launchArgs) : undefined,
      gpuRamGb: gpuRamGb ? Number(gpuRamGb) : undefined,
      minLoad: minLoad !== undefined ? Number(minLoad) : undefined,
      targetUtil: targetUtil !== undefined ? Number(targetUtil) : undefined,
      coldMult: coldMult !== undefined ? Number(coldMult) : undefined,
      coldWorkers: coldWorkers !== undefined ? Number(coldWorkers) : undefined,
      maxWorkers: maxWorkers !== undefined ? Number(maxWorkers) : undefined,
      testWorkers: testWorkers !== undefined ? Number(testWorkers) : undefined,
    }, creds);
    jsonOk(res, result);
  } catch (e: unknown) {
    jsonErr(res, `createWorkerGroup failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastWorkerGroupUpdate(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonErr(res, 'Invalid JSON body'); }

  const { id, ...updates } = body;
  if (!id) return jsonErr(res, 'id is required');

  try {
    await getVast().updateWorkerGroup(Number(id), {
      minLoad: updates.minLoad !== undefined ? Number(updates.minLoad) : undefined,
      targetUtil: updates.targetUtil !== undefined ? Number(updates.targetUtil) : undefined,
      coldMult: updates.coldMult !== undefined ? Number(updates.coldMult) : undefined,
      testWorkers: updates.testWorkers !== undefined ? Number(updates.testWorkers) : undefined,
      templateHash: updates.templateHash ? String(updates.templateHash) : undefined,
      templateId: updates.templateId ? Number(updates.templateId) : undefined,
      searchParams: updates.searchParams ? String(updates.searchParams) : undefined,
      launchArgs: updates.launchArgs ? String(updates.launchArgs) : undefined,
      gpuRamGb: updates.gpuRamGb ? Number(updates.gpuRamGb) : undefined,
      endpointName: updates.endpointName ? String(updates.endpointName) : undefined,
      endpointId: updates.endpointId ? Number(updates.endpointId) : undefined,
    }, creds);
    jsonOk(res, { success: true, id: Number(id) });
  } catch (e: unknown) {
    jsonErr(res, `updateWorkerGroup failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}

export async function handleVastWorkerGroupDelete(req: IncomingMessage, res: ServerResponse) {
  setRequestIdHeader(res, getOrCreateRequestId(req));
  const creds = vastCreds();
  if (!creds.apiKey) return jsonErr(res, 'VAST_API_KEY not configured', 401);

  const url = new URL(req.url || '/', `http://localhost`);
  const idStr = url.searchParams.get('id');
  if (!idStr) return jsonErr(res, 'id query param is required');
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return jsonErr(res, 'id must be a positive integer');

  try {
    const result = await getVast().deleteWorkerGroup(id, creds);
    jsonOk(res, { success: true, id, ...result });
  } catch (e: unknown) {
    jsonErr(res, `deleteWorkerGroup failed: ${e instanceof Error ? e.message : e}`, 500);
  }
}
