/**
 * Vast.ai Template + SSH Tunnel — Integration Tests
 *
 * Tests the new template management API and the forceSshTunnel option.
 *
 *   1. listTemplates() — read-only, hits real API if VAST_API_KEY set
 *   2. createTemplate() — creates a uniquely-named test template (cleaned up)
 *   3. findOrCreateTemplate() — idempotent reuse
 *   4. _probeEndpoint() — verifies the new two-stage TCP+HTTP probe rejects
 *      sockets that accept the SYN but don't have an L7 listener
 *
 * Requires: VAST_API_KEY (skipped otherwise)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VastClient } from '../../src/gpu-providers/vast-client';
import type { ProviderCredentials } from '../../src/gpu-providers/types';
import { loadEnv } from '../helpers';
import { createServer, type Server } from 'net';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';

const hasRealKeys = !!process.env.VAST_API_KEY;

let creds: ProviderCredentials;
let client: VastClient;
const createdTemplateIds: number[] = [];

beforeAll(() => {
  if (!hasRealKeys) return;
  loadEnv();
  creds = { apiKey: process.env.VAST_API_KEY! };
  client = new VastClient();
});

afterAll(async () => {
  if (!hasRealKeys) return;
  // Clean up any test templates we created
  // Note: Vast.ai doesn't expose a deleteTemplate API in their public docs;
  // templates persist. The unique names ('test-trellis2-...') prevent
  // collisions across runs.
  for (const id of createdTemplateIds) {
    console.log(`[cleanup] Test template ${id} left in account (no delete API)`);
  }
});

describe.skipIf(!hasRealKeys)('VastClient — Templates (real API)', () => {
  it('listTemplates() returns the user templates', async () => {
    const templates = await client.listTemplates(creds);
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.hashId).toBeTruthy();
      expect(typeof t.id).toBe('number');
      expect(typeof t.name).toBe('string');
      expect(typeof t.image).toBe('string');
    }
  }, 15_000);

  it('createTemplate() creates a new template and returns hash_id', async () => {
    const uniqueName = `test-trellis2-${Date.now()}`;
    const result = await client.createTemplate(
      {
        name: uniqueName,
        image: 'marcosremar/trellis2',
        tag: 'latest',
        envVars: { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
        exposePorts: [8000],
        onstartCmd: 'python /app/server.py',
        diskSpaceGb: 50,
        useSsh: true,
      },
      creds,
    );
    expect(result.hashId).toMatch(/^[a-f0-9]{32}$/);
    expect(result.id).toBeGreaterThan(0);
    createdTemplateIds.push(result.id);

    // Verify it appears in the list
    const all = await client.listTemplates(creds);
    const found = all.find((t) => t.hashId === result.hashId);
    expect(found).toBeTruthy();
    expect(found?.name).toBe(uniqueName);
    expect(found?.image).toBe('marcosremar/trellis2');
  }, 30_000);

  it('findOrCreateTemplate() reuses an existing template', async () => {
    const uniqueName = `test-trellis2-reuse-${Date.now()}`;
    const spec = {
      name: uniqueName,
      image: 'marcosremar/trellis2',
      tag: 'latest',
      envVars: {},
      exposePorts: [8000],
      diskSpaceGb: 50,
    };

    // First call: should create
    const first = await client.findOrCreateTemplate(spec, creds);
    expect(first.created).toBe(true);
    expect(first.hashId).toMatch(/^[a-f0-9]{32}$/);
    createdTemplateIds.push(first.id);

    // Second call with same spec: should reuse
    const second = await client.findOrCreateTemplate(spec, creds);
    expect(second.created).toBe(false);
    expect(second.hashId).toBe(first.hashId);
    expect(second.id).toBe(first.id);
  }, 30_000);
});

describe('VastClient — _probeEndpoint two-stage probe', () => {
  let tcpOnlyServer: Server | undefined;
  let httpServer: HttpServer | undefined;
  let tcpPort = 0;
  let httpPort = 0;
  // Access the private method via cast for testing
  const probe = (endpoint: string, timeout = 3_000) =>
    (
      new VastClient() as unknown as { _probeEndpoint: (e: string, t: number) => Promise<boolean> }
    )._probeEndpoint(endpoint, timeout);

  beforeAll(async () => {
    // Server 1: TCP-only — accepts the connect but never sends HTTP. This
    // simulates the Vast.ai residential-host failure mode.
    tcpOnlyServer = createServer((sock) => {
      // Immediately close — TCP handshake completes but no L7 response
      setTimeout(() => sock.destroy(), 100);
    });
    await new Promise<void>((resolve) => {
      tcpOnlyServer!.listen(0, '127.0.0.1', () => {
        const addr = tcpOnlyServer!.address();
        if (addr && typeof addr === 'object') tcpPort = addr.port;
        resolve();
      });
    });

    // Server 2: Real HTTP server (responds to GET /health and /).
    httpServer = createHttpServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', path: req.url }));
    });
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => {
        const addr = httpServer!.address();
        if (addr && typeof addr === 'object') httpPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    tcpOnlyServer?.close();
    httpServer?.close();
  });

  it('rejects a TCP-only listener (the Vast residential-host bug)', async () => {
    const result = await probe(`http://127.0.0.1:${tcpPort}`, 3_000);
    expect(result).toBe(false);
  }, 10_000);

  it('accepts a real HTTP server', async () => {
    const result = await probe(`http://127.0.0.1:${httpPort}`, 3_000);
    expect(result).toBe(true);
  }, 10_000);

  it('rejects a closed port (no listener at all)', async () => {
    // Use a port we know nothing is listening on (4 is usually empty)
    const result = await probe('http://127.0.0.1:4', 2_000);
    expect(result).toBe(false);
  }, 10_000);
});
