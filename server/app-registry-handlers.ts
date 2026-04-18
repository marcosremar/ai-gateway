// ── HTTP handlers for the app registry ────────────────────────────────────
//
//   GET    /v1/apps            — list all registered apps
//   GET    /v1/apps/:name      — get one
//   POST   /v1/apps            — register (or update) an app
//   DELETE /v1/apps/:name      — unregister
//
// Body for POST:
//   { "name": "musetalk", "image": "marcosremar/musetalk",
//     "bootEstimateS": 300, "tags": ["lipsync","video"], "notes": "..." }
//
// Keeps the registry source-of-truth the JSON file at ~/.ai-gateway/apps.json
// (with optional DB mirror); these handlers are just the remote-mutation API.

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  listImages,
  getImage,
  registerImage,
  unregisterImage,
  type AppRegistryEntry,
} from './app-registry';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}') as T); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

export async function handleAppsList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { apps: listImages() });
}

export async function handleAppsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  const entry = getImage(name);
  if (!entry) { sendJson(res, 404, { error: `app "${name}" not found` }); return; }
  sendJson(res, 200, entry);
}

export async function handleAppsRegister(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Partial<AppRegistryEntry>;
  try {
    body = await readJsonBody<Partial<AppRegistryEntry>>(req);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  if (!body.name || !body.image) {
    sendJson(res, 400, { error: 'name and image are required' });
    return;
  }
  try {
    const entry = await registerImage({
      name: body.name,
      image: body.image,
      bootEstimateS: body.bootEstimateS,
      notes: body.notes,
      tags: body.tags,
    });
    sendJson(res, 200, entry);
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

export async function handleAppsDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  const removed = await unregisterImage(name);
  if (!removed) { sendJson(res, 404, { error: `app "${name}" not found` }); return; }
  sendJson(res, 200, { removed: name });
}
