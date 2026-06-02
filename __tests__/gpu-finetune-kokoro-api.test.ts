import { readFileSync } from 'fs';
import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';

import { handleKokoroDatasetAgentAction } from '../server/gpu-finetune-handlers.js';

describe('Kokoro dataset API action', () => {
  it('is registered as Gateway GPU routes', () => {
    const routes = readFileSync('server/routes/gateway/gpu.ts', 'utf-8');

    expect(routes).toContain("'POST /v1/gpu/finetune/plan'");
    expect(routes).toContain("'POST /v1/gpu/finetune/kokoro-dataset'");
    expect(routes).toContain("'POST /v1/gpu/finetune/kokoro-dataset/plan'");
    expect(routes).toContain("'POST /v1/gpu/finetune/kokoro-dataset/run'");
  });

  it('plans through the agent-callable HTTP handler', async () => {
    const res = await callHandler('/v1/gpu/finetune/kokoro-dataset', {
      action: 'auto',
      phrases: 100,
      workers: 20,
      voice: 'pf_dora',
      r2Uri: 'r2://kokoro-datasets/pf_dora/pt-br-smoke',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('planned');
    expect(res.body.plan).toMatchObject({
      voice: 'pf_dora',
      phraseCount: 100,
      workerCount: 20,
      gpuRequired: false,
      trainingEnabled: false,
    });
    expect(res.body.runEndpoint).toBe('/v1/gpu/finetune/kokoro-dataset/run');
  });

  it('launches only when the request explicitly asks to run and is approved', async () => {
    const res = await callHandler('/v1/gpu/finetune/kokoro-dataset/run', {
      phrases: 4,
      workers: 2,
      voice: 'pf_dora',
      r2Uri: 'r2://bucket/kokoro',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('returns a structured failure when approved but R2/Daytona env is missing', async () => {
    const res = await callHandler('/v1/gpu/finetune/kokoro-dataset/run', {
      phrases: 4,
      workers: 2,
      voice: 'pf_dora',
      r2Uri: 'r2://bucket/kokoro',
      approved: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('KOKORO_DATASET_RUN_FAILED');
    expect(res.body.error.message).toContain('missing R2 env vars');
  });
});

async function callHandler(url: string, body: Record<string, unknown>) {
  const req = new PassThrough() as any;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  const res = makeResponse();
  queueMicrotask(() => {
    req.end(JSON.stringify(body));
  });
  await handleKokoroDatasetAgentAction(req, res as any);
  return res.result();
}

function makeResponse() {
  let status = 0;
  const chunks: Buffer[] = [];
  return {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    result() {
      const text = Buffer.concat(chunks).toString();
      return { status, body: JSON.parse(text) };
    },
  };
}
