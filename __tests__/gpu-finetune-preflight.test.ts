import { describe, it, expect } from 'vitest';
import { preflightChecks } from '../src/modules/gpu-finetune/preflight';
import { setPresetsRoot } from '../src/modules/gpu-finetune/spec';

// ─── fetch mock helpers ──────────────────────────────────────────────────────

type Route = { status: number; json?: unknown };

/** Build a fake fetch that maps URL substrings → responses. */
function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (url: string) => {
    for (const [needle, r] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          status: r.status,
          json: async () => r.json ?? {},
        } as Response;
      }
    }
    return { status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

const ok = (json?: unknown): Route => ({ status: 200, json });
const notFound: Route = { status: 404 };

const checkByName = (r: { checks: { name: string; status: string; detail: string }[] }, prefix: string) =>
  r.checks.find(c => c.name.startsWith(prefix));

describe('preflight: HF dataset reachability', () => {
  it('passes when dataset exists (200)', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://owner/ds' },
      {},
      { fetch: fakeFetch({ '/datasets/owner/ds': ok() }), fileExists: () => true },
    );
    expect(checkByName(r, 'HF dataset')?.status).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('fails when dataset is 404', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://owner/missing' },
      {},
      { fetch: fakeFetch({}), fileExists: () => true },
    );
    expect(checkByName(r, 'HF dataset')?.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails private dataset (401) with no token', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://owner/private' },
      {},
      { fetch: fakeFetch({ '/datasets/owner/private': { status: 401 } }), fileExists: () => true },
    );
    expect(checkByName(r, 'HF dataset')?.status).toBe('fail');
  });

  it('warns (does not fail) on network error', async () => {
    const throwing = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://owner/ds' },
      {},
      { fetch: throwing, fileExists: () => true },
    );
    expect(checkByName(r, 'HF dataset')?.status).toBe('warn');
    expect(r.ok).toBe(true);
  });

  it('skips dataset check for non-hf:// path', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: '/local/data' },
      {},
      { fetch: fakeFetch({}), fileExists: () => true },
    );
    expect(checkByName(r, 'HF dataset')).toBeUndefined();
  });
});

describe('preflight: HF write access', () => {
  it('fails when pushToHf set but no token', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', pushToHf: 'o/weights' },
      {},
      { fetch: fakeFetch({ '/datasets/o/d': ok() }), fileExists: () => true },
    );
    expect(checkByName(r, 'HF write access')?.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails on read-only token', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', hfBase: 'o/model' },
      { HF_TOKEN: 'hf_xxx' },
      {
        fetch: fakeFetch({
          '/datasets/o/d': ok(),
          'whoami-v2': ok({ auth: { accessToken: { role: 'read' } } }),
        }),
        fileExists: () => true,
      },
    );
    expect(checkByName(r, 'HF write access')?.status).toBe('fail');
  });

  it('passes on write token', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', pushToHf: 'o/weights' },
      { HF_TOKEN: 'hf_xxx' },
      {
        fetch: fakeFetch({
          '/datasets/o/d': ok(),
          'whoami-v2': ok({ auth: { accessToken: { role: 'write' } } }),
        }),
        fileExists: () => true,
      },
    );
    expect(checkByName(r, 'HF write access')?.status).toBe('ok');
    expect(r.ok).toBe(true);
  });
});

describe('preflight: R2 credentials', () => {
  it('fails when r2Bucket set but no creds (silent-data-loss guard)', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', r2Bucket: 'my-bucket' },
      {},
      { fetch: fakeFetch({ '/datasets/o/d': ok() }), fileExists: () => true },
    );
    expect(checkByName(r, 'R2 credentials')?.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('passes when r2Bucket set with full creds', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', r2Bucket: 'my-bucket' },
      {
        B2_ACCOUNT_ID: 'ak',
        B2_APPLICATION_KEY: 'sk',
        B2_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
      },
      { fetch: fakeFetch({ '/datasets/o/d': ok() }), fileExists: () => true },
    );
    expect(checkByName(r, 'R2 credentials')?.status).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('accepts STORAGE_* alias creds', async () => {
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', resumeFromR2: true },
      { STORAGE_ACCESS_KEY: 'ak', STORAGE_SECRET_KEY: 'sk', STORAGE_ENDPOINT: 'https://s3' },
      { fetch: fakeFetch({ '/datasets/o/d': ok() }), fileExists: () => true },
    );
    expect(checkByName(r, 'R2 credentials')?.status).toBe('ok');
  });
});

describe('preflight: trainer script (custom, no preset)', () => {
  it('fails when script missing', async () => {
    const r = await preflightChecks(
      { type: 'custom', scriptPath: '/nope/trainer.py' },
      {},
      { fetch: fakeFetch({}), fileExists: () => false },
    );
    expect(checkByName(r, 'trainer script')?.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('passes when script exists', async () => {
    const r = await preflightChecks(
      { type: 'custom', scriptPath: '/exists/trainer.py' },
      {},
      { fetch: fakeFetch({}), fileExists: () => true },
    );
    expect(checkByName(r, 'trainer script')?.status).toBe('ok');
  });
});

describe('preflight: happy path', () => {
  it('all ok → ok=true', async () => {
    setPresetsRoot(null); // ensure no preset matches 'audio'
    const r = await preflightChecks(
      { type: 'audio', dataset: 'hf://o/d', model: 'hf://o/m' },
      {},
      {
        fetch: fakeFetch({ '/datasets/o/d': ok(), '/models/o/m': ok() }),
        fileExists: () => true,
      },
    );
    expect(r.ok).toBe(true);
    expect(r.checks.every(c => c.status === 'ok')).toBe(true);
  });
});
