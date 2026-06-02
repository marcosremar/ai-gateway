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
import { buildSshArgs, resolveSshIdentity, tcpProbe } from '../src/gateway/providers/gpu/ssh-tunnel';
import { createServer } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createDeploySlot, deployState } from '../src/gateway/state/deploy-state';
import { setDeployState } from '../server/state';
import { gpuOfferMatchesTypes, parseGpuTypesQuery } from '../server/gpu-handlers-offers';
import { computeBackoffCooldownMs, deprioritizeUnavailable, isProviderHardBlock, ProviderCooldownTracker, ownerFromLabel } from '../src/gpu-providers/deploy-orchestrator';
import { RunawayDetector } from '../src/autoscaler/runaway-detector';

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

// ── Fix #5: SSH tunnel — identity file, args, forward validation ──────────────
describe('fix #5 — ssh tunnel resilience primitives', () => {
  it('buildSshArgs passa -i + IdentitiesOnly quando há identity', () => {
    const args = buildSshArgs({ localPort: 19000, remotePort: 8000, sshPort: 222, sshHost: 'ssh6.vast.ai', identityFile: '/k/id' });
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/k/id');
    expect(args).toContain('IdentitiesOnly=yes');
    expect(args).toContain('19000:localhost:8000');
    expect(args[args.length - 1]).toBe('root@ssh6.vast.ai');
  });
  it('buildSshArgs sem identity → sem -i', () => {
    const args = buildSshArgs({ localPort: 1, remotePort: 2, sshPort: 3, sshHost: 'h' });
    expect(args).not.toContain('-i');
  });
  it('resolveSshIdentity honra env quando o arquivo existe', () => {
    // process.execPath sempre existe — usado como "identity" só p/ testar a resolução
    expect(resolveSshIdentity({ VAST_SSH_KEY: process.execPath } as NodeJS.ProcessEnv)).toBe(process.execPath);
    // caminho inexistente não é retornado
    expect(resolveSshIdentity({ VAST_SSH_KEY: '/no/such/key' } as NodeJS.ProcessEnv)).not.toBe('/no/such/key');
  });
  it('tcpProbe valida forward: true em porta aberta, false em fechada', async () => {
    const srv = createServer();
    const port: number = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port)));
    try {
      expect(await tcpProbe(port, 1500)).toBe(true);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    // porta agora fechada → forward inválido
    expect(await tcpProbe(port, 800)).toBe(false);
  });
});

// ── Fix #4a: cooldown exponencial com jitter ─────────────────────────────────
describe('fix #4a — cooldown backoff has ±20% jitter, capped', () => {
  it('exponencial sem jitter (rand=0.5): 60s, 120s, 240s', () => {
    expect(computeBackoffCooldownMs(60_000, 900_000, 1, () => 0.5)).toBe(60_000);
    expect(computeBackoffCooldownMs(60_000, 900_000, 2, () => 0.5)).toBe(120_000);
    expect(computeBackoffCooldownMs(60_000, 900_000, 3, () => 0.5)).toBe(240_000);
  });
  it('jitter fica em ±20%', () => {
    expect(computeBackoffCooldownMs(60_000, 900_000, 2, () => 0)).toBe(96_000);   // -20%
    expect(computeBackoffCooldownMs(60_000, 900_000, 2, () => 1)).toBe(144_000);  // +20%
  });
  it('respeita o teto maxMs', () => {
    expect(computeBackoffCooldownMs(60_000, 300_000, 20, () => 1)).toBe(300_000);
  });
});

// ── Fix #7: providers indisponíveis vão pro fim do cascade (estável) ──────────
describe('fix #7 — deprioritize probe-unavailable providers (stable)', () => {
  const tiers = [{ name: 'vast' }, { name: 'runpod' }, { name: 'tensordock' }];
  it('empurra o indisponível pro fim preservando ordem dos demais', () => {
    const out = deprioritizeUnavailable(tiers, new Set(['runpod']));
    expect(out.map((t) => t.name)).toEqual(['vast', 'tensordock', 'runpod']);
  });
  it('set vazio = inalterado', () => {
    expect(deprioritizeUnavailable(tiers, new Set())).toBe(tiers);
  });
});

// ── Fix #4c: detector de runaway gateia o create-rate das re-tentativas ───────
describe('fix #4c — runaway detector trips on rapid create-rate', () => {
  it('bloqueia após maxStarts na janela (o gate que o loop de retry usa)', () => {
    let t = 1_000;
    const d = new RunawayDetector({ maxStarts: 3, windowMs: 60_000, pauseMs: 60_000, now: () => t });
    expect(d.recordDeployStart('vast')).toBe(true);
    expect(d.recordDeployStart('vast')).toBe(true);
    expect(d.recordDeployStart('vast')).toBe(false); // 3ª trip → pausa
    t += 1_000;
    expect(d.recordDeployStart('vast')).toBe(false); // segue pausado
  });
  it('outro provedor não é afetado', () => {
    let t = 1_000;
    const d = new RunawayDetector({ maxStarts: 2, windowMs: 60_000, pauseMs: 60_000, now: () => t });
    d.recordDeployStart('vast'); d.recordDeployStart('vast'); // trip vast
    expect(d.recordDeployStart('runpod')).toBe(true);
  });
});

// ── Fix #4b: hard-block (quota 0 / abuso / KYC) vira cooldown longo ───────────
describe('fix #4b — provider hard-block → long persisted cooldown', () => {
  it('isProviderHardBlock detecta abuso/quota/KYC, ignora falhas transitórias', () => {
    expect(isProviderHardBlock('RunPod machine quota is 0 — account blocked')).toBe(true);
    expect(isProviderHardBlock('PREFLIGHT BLOCKED: ... abuse flag')).toBe(true);
    expect(isProviderHardBlock('KYC pending')).toBe(true);
    expect(isProviderHardBlock('No GPUs available on Vast.ai (0 offers matched)')).toBe(false);
    expect(isProviderHardBlock('ssh exited with code 255')).toBe(false);
  });
  it('recordHardBlock aplica cooldown longo que IGNORA o teto de 15min', async () => {
    const t = new ProviderCooldownTracker();
    await t.recordHardBlock('runpod', 24 * 60 * 60_000);
    const remain = t.getRemainingSeconds('runpod');
    expect(remain).toBeGreaterThan(ProviderCooldownTracker.MAX_COOLDOWN_MS / 1000); // > 900s (15min)
    expect(remain).toBeGreaterThan(80_000); // ~24h
  });
});

// ── Per-key isolation (fix A): deploy loop forwards the owner label ───────────
describe('per-key isolation — tier-cascade deploy forwards owner label', () => {
  it('createInstance spec inclui extra.label (senão o pod fica sem dono → invisível ao filtro)', () => {
    const src = readFileSync(join(__dirname, '../server/gpu-deploy-loop.ts'), 'utf-8');
    const start = src.indexOf('providerClient.createInstance(');
    expect(start).toBeGreaterThan(0);
    const spec = src.slice(start, start + 2000);
    expect(spec).toContain('extra.label');
  });

  it('ownerFromLabel extrai o userId do label <userId>/<task>', () => {
    expect(ownerFromLabel('moss-tts/job-123')).toBe('moss-tts');
    expect(ownerFromLabel('a/b/c')).toBe('a');
    expect(ownerFromLabel('hybrik')).toBeNull();      // sem namespace → ownerless
    expect(ownerFromLabel('')).toBeNull();
    expect(ownerFromLabel(undefined)).toBeNull();
  });

  it('o loop seta deployState.userId pelo dono do label (inline, mesma lógica do ownerFromLabel)', () => {
    const loop = readFileSync(join(__dirname, '../server/gpu-deploy-loop.ts'), 'utf-8');
    expect(loop).toMatch(/userId:\s*extra\.label && extra\.label\.includes\('\/'\)/);
    // a lógica inline deve casar com o helper unit-testado
    expect(ownerFromLabel('moss-tts/job-1')).toBe('moss-tts');
  });

  it('handlers escopam por dono: deploy 409, stop/resume 403, status esconde', () => {
    const h = readFileSync(join(__dirname, '../server/gpu-handlers.ts'), 'utf-8');
    const info = readFileSync(join(__dirname, '../server/gpu-handlers-info.ts'), 'utf-8');
    // deploy anti-clobber
    expect(h).toContain('deployState.userId && callerUserId && deployState.userId !== callerUserId');
    // stop / resume owner guard
    expect(h).toContain('deployState.userId !== stopCallerUserId');
    expect(h).toContain('deployState.userId !== resumeCallerUserId');
    // status hides another app's deploy
    expect(info).toContain('deployState.userId !== statusCallerUserId');
  });

  it('logs/inspect usam o deploy slot visível ao caller', () => {
    const h = readFileSync(join(__dirname, '../server/gpu-handlers.ts'), 'utf-8');
    const info = readFileSync(join(__dirname, '../server/gpu-handlers-info.ts'), 'utf-8');
    expect(info).toContain('resolveDeployStateForRequest(req)');
    expect(info).toContain('fetchGpuLogs(state.sshHost, state.sshPort, state.endpoint, state)');
    expect(h).toContain('resolveDeployStateForReadRequest(req)');
    expect(h).toContain('const sshHost = state.sshHost');
  });
});

// ── Multi-tenant concurrency (épico) — Passo 1: indireção DeploySlot ──────────
describe('multi-tenant slots — step 1 (sink indirection, global untouched)', () => {
  it('createDeploySlot dá um slot ocioso isolado por dono', () => {
    const s = createDeploySlot('moss-tts-test-1');
    expect(s.ownerKey).toBe('moss-tts-test-1');
    expect(s.state.status).toBe('idle');
    expect(s.state.userId).toBe('moss-tts-test-1');
    expect(s.persistFile).toContain('active_deploy.moss-tts-test-1.json');
  });

  it('setDeployState(patch, slot) escreve no SLOT, não no global', () => {
    const globalStatusBefore = deployState.status;
    const globalPodBefore = deployState.podId;
    const s = createDeploySlot('moss-tts-test-2');
    setDeployState({ status: 'creating', podId: 'pod-SLOT', message: 'm', step: 'creating_pod' }, s);
    expect(s.state.status).toBe('creating');
    expect(s.state.podId).toBe('pod-SLOT');
    expect(s.state.transitions.length).toBeGreaterThan(0); // transição registrada no slot
    // global intocado
    expect(deployState.status).toBe(globalStatusBefore);
    expect(deployState.podId).toBe(globalPodBefore);
    expect(deployState.podId).not.toBe('pod-SLOT');
  });

  it('setDeployState(patch) sem slot ainda escreve no global (compat)', () => {
    setDeployState({ message: 'global-msg-test' });
    expect(deployState.message).toBe('global-msg-test');
  });

  // Step 3-lite: orphan sweep não pode matar pods dos slots
  it('orphan-sweep protege pods dos slots + aborta se slot mid-deploy', () => {
    const src = readFileSync(join(__dirname, '../server/gpu-orphan-cleanup.ts'), 'utf-8');
    expect(src).toContain('listDeploySlots()');
    expect(src).toMatch(/slot\.state\.podId/);                 // protege podId do slot
    expect(src).toMatch(/slot.*deploy in progress/i);          // aborta sweep se slot ocupado
  });
});

describe('MCP GPU offers filter aliases', () => {
  it('gpu=RTX 5090 vira filtro gpuTypes e exclui ofertas genericas', () => {
    const url = new URL('http://localhost/v1/gpu/offers?gpu=RTX%205090&provider=vast');
    const gpuTypes = parseGpuTypesQuery(url);
    expect(gpuTypes).toEqual(['RTX 5090']);
    expect(gpuOfferMatchesTypes({ gpuName: 'NVIDIA GeForce RTX 5090', gpuType: 'RTX 5090' } as any, gpuTypes)).toBe(true);
    expect(gpuOfferMatchesTypes({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX 4090' } as any, gpuTypes)).toBe(false);
  });
});
