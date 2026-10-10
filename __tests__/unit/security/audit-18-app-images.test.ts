import { describe, expect, it } from 'vitest';
import { AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { createDeploymentRoutes } from '../../../src/deployments/http';

function memoryApps(): AppRegistry {
  return new AppRegistry(new MemoryAppStore());
}

function call(handler: ReturnType<typeof createDeploymentRoutes>, user: string, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; text: string }>((resolve) => {
    let status = 0;
    const res = {
      writeHead(s: number) { status = s; return res; }, setHeader() {}, end(text: string) { resolve({ status, text }); },
    };
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      headers: { 'content-type': 'application/json', 'x-user': user }, url: path, method,
      async *[Symbol.asyncIterator]() { yield* payload; },
    };
    handler(req as never, res as never, path, method);
  });
}

describe('audit 2026-10-09 #18: an app key cannot change what the next admin deploy runs', () => {
  it('PUT/DELETE /v1/apps/:app/images/:name need an admin key; the app key may still read them', async () => {
    const apps = memoryApps();
    await apps.init();
    const handler = createDeploymentRoutes({
      controller: { list: () => [], get: () => null } as never, apps,
      userOf: (req) => String(req.headers['x-user']), isAdmin: (req) => req.headers['x-user'] === 'ops',
    });
    const image = { image: 'ghcr.io/parle/speech:1', port: 8000 };
    expect((await call(handler, 'parle', 'PUT', '/v1/apps/parle/images/speech', image)).status).toBe(403);
    expect((await call(handler, 'ops', 'PUT', '/v1/apps/parle/images/speech', image)).status).toBe(201);
    expect((await call(handler, 'parle', 'PUT', '/v1/apps/parle/images/speech', { image: 'ghcr.io/evil/x:1', port: 8000 })).status).toBe(403);
    expect((await call(handler, 'parle', 'DELETE', '/v1/apps/parle/images/speech')).status).toBe(403);
    const read = await call(handler, 'parle', 'GET', '/v1/apps/parle/images/speech');
    expect(read.status).toBe(200);
    expect(read.text).toContain('ghcr.io/parle/speech:1');
  });
});
