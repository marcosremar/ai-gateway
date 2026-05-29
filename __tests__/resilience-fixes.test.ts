/**
 * Resilience fixes — integration tests (real API where read-only/free).
 *
 * Cada bloco verifica UM fix de resiliência do deploy. Onde dá, exercita a API
 * real (Vast read-only) com fallback p/ mock fetch quando não há VAST_API_KEY
 * (mesmo padrão de vast-real-api.test.ts). NENHUM teste cria GPU (custo).
 *
 * Run: npx vitest run --config vitest.config.ts __tests__/resilience-fixes.test.ts
 *      VAST_API_KEY=... SKIP_LIVE_TESTS=0  (pra bater na API real do Vast)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';
import { loadEnv, requireEnv } from './helpers';
import { installMockFetch } from './mock-fetch';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { evaluateSpeedTest } from '../server/gpu-poll-health';

const hasRealKeys = !!process.env.VAST_API_KEY;
let creds: ProviderCredentials;
let client: VastClient;
let restoreFetch: (() => void) | undefined;

beforeAll(() => {
  if (hasRealKeys) {
    loadEnv();
    creds = { apiKey: requireEnv('VAST_API_KEY') };
  } else {
    creds = { apiKey: 'mock-vast-key' };
    restoreFetch = installMockFetch();
  }
  client = new VastClient();
});
afterAll(() => { restoreFetch?.(); });

// ── Fix #6a: unbound checkBalance perdia `this` → crash em this.log ───────────
describe('fix #6a — checkBalance must stay bound to its client', () => {
  it('crashes when called UNBOUND (reproduz o bug)', async () => {
    const fn = (client as unknown as { checkBalance: (c: ProviderCredentials) => Promise<unknown> }).checkBalance;
    // chamada nua (como o handler fazia) -> this === undefined -> rejeita
    await expect((async () => fn(creds))()).rejects.toBeTruthy();
  });

  it('funciona quando chamado via .call(client) (o fix)', async () => {
    const fn = (client as unknown as { checkBalance: (c: ProviderCredentials) => Promise<{ balance: number } | null> }).checkBalance;
    const r = await fn.call(client, creds);
    // API real -> {balance:number}; mock/sem-saldo -> null. Nunca deve lançar.
    expect(r === null || typeof r.balance === 'number').toBe(true);
  });
});

// ── Fix #6b: row.id em null quando roda sem DB (prisma no-op) ─────────────────
describe('fix #6b — deploy-session create tolerates no-DB', () => {
  it('prisma no-op resolve null e o acesso guardado não lança', async () => {
    const { prisma } = await import('../server/state');
    const row = (await prisma.gpuDeploySession.create({
      data: { provider: 'vast', dockerImage: 'x', gpuType: 'RTX 4090', status: 'deploying' },
    })) as { id: number } | null;
    // sem DATABASE_URL, o proxy no-op resolve null
    expect(row === null || typeof row.id === 'number').toBe(true);
    // padrão do fix: `if (row) ...` — não lança em null
    expect(() => { if (row) void row.id; }).not.toThrow();
  });

  it('startDeploySession não lança nem gera rejection sem DB', async () => {
    const { startDeploySession } = await import('../server/metrics');
    expect(() => startDeploySession('vast', 'img', 'RTX 4090')).not.toThrow();
    await new Promise((r) => setTimeout(r, 50)); // deixa o .then/.catch resolver
  });
});

// ── Fix #3: erro real em vez de "No GPUs available in region: unknown" ────────
describe('fix #3 — 0-offers error carries real filter detail, not fake region', () => {
  const raw =
    'No GPUs available on Vast.ai (0 offers matched). GPU filter: [RTX 4090], ' +
    'constraints: disk>=100GB, strictFastBoot(reliability>=0.97,verified,gpu_frac=1), direct_port>=1';

  it('classifica como PRV_NO_GPUS sem inventar região', () => {
    const err = categorizeDeployError(new Error(raw));
    expect(err.code).toBe('PRV_NO_GPUS');
    expect(err.message.toLowerCase()).not.toContain('region');
    expect(err.message.toLowerCase()).not.toContain('unknown');
  });

  it('preserva o detalhe real (gpu + constraints) na mensagem', () => {
    const err = categorizeDeployError(new Error(raw));
    expect(err.message).toContain('RTX 4090');
    expect(err.message).toContain('disk>=100GB');
    expect(err.message).toContain('strictFastBoot');
    expect(err.userMessage).toContain('0 offers'); // mensagem ao usuário explica a causa
  });
});

// ── Fix #1: speed-test não mata mais host lento-mas-usável (caso real do log) ──
describe('fix #1 — speed test keeps usable-but-slow pods by default', () => {
  it('CASO REAL DO LOG: 759 Mbps actual vs 6705 advertised → degraded (não destrói)', () => {
    const { decision } = evaluateSpeedTest(759, 6705, {});
    expect(decision).toBe('degraded');
  });
  it('rápido o bastante → accept', () => {
    expect(evaluateSpeedTest(4000, 6705, {}).decision).toBe('accept');
  });
  it('lixo de verdade (< piso absoluto 200) → destroy', () => {
    expect(evaluateSpeedTest(80, 6705, {}).decision).toBe('destroy');
  });
  it('SPEED_TEST_ALLOW_DEGRADED=0 restaura o destroy estrito', () => {
    expect(evaluateSpeedTest(759, 6705, { SPEED_TEST_ALLOW_DEGRADED: '0' }).decision).toBe('destroy');
  });
});

// ── Fix #2: exclusão "recently used" não pode zerar o resultado ───────────────
describe('fix #2 — recently-used offers are re-admitted instead of dropping to 0', () => {
  it('única oferta recently-used é re-admitida (não vira 0 unique hosts)', async () => {
    const c = new VastClient();
    const IP = '203.0.113.5';
    const offer = {
      id: 1, public_ipaddr: IP, dph_total: 0.3, cuda_max_good: 12.8, inet_down: 1000,
      reliability2: 0.99, gpu_name: 'RTX 4090', disk_space: 200, direct_port_count: 2,
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ offers: [offer] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      (c as unknown as { _recentlyUsedIps: Set<string> })._recentlyUsedIps.add(IP); // marca como usado
      (c as unknown as { _offerCache: unknown })._offerCache = null;
      const res = await (c as unknown as {
        _searchOffers: (b: unknown, h: unknown, d: boolean) => Promise<Array<{ public_ipaddr: string }>>;
      })._searchOffers({ q: {} }, { Authorization: 'Bearer x' }, true);
      // sem o fix isto seria 0 ("1 offers → 0 unique hosts (1 recently used)")
      expect(res.length).toBe(1);
      expect(String(res[0].public_ipaddr)).toBe(IP);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
