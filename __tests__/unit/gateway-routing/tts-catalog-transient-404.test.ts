/**
 * Reprodução (teste e2e do gateway, 05/10/2026) — risco de derrubar o engine da réplica Base:
 * um 404 PASSAGEIRO em /refs/voices.json (réplica ainda subindo o servidor de refs, proxy, rota trocada) fica guardado
 * como "réplica sem catálogo" por 5 min (CATALOG_TTL_MS), e nesse tempo todo pedido vai à réplica com `voice` e SEM
 * ref_audio — exatamente o pedido que mata o stage-0 do vLLM-Omni (commit 5ec5803).
 * Esperado: sem catálogo confirmado, não mandar `voice` sozinho a uma réplica Base (ou não guardar o 404 por 5 min).
 * Obtido (5ec5803): o 2º pedido, com o catálogo já de volta, sai com { voice: 'br-f-01' } e sem ref_audio.
 * Colocar em __tests__/unit/gateway-routing/ e rodar: bunx vitest run __tests__/unit/gateway-routing/tts-catalog-transient-404.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { DeploymentTTSProvider } from '../../../src/deployments/inference-providers';

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
const CATALOG = { model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
  voices: [{ id: 'br-f-01', lang: 'pt-BR', gender: 'feminine', audio: 'http://replica/refs/br-f-01.wav', text: 'Olá, eu sou a Ana.' }] };

describe('catálogo de vozes da réplica Base: 404 passageiro', () => {
  it('não manda voice sem ref_audio depois de um 404 passageiro do catálogo', async () => {
    const lease = { machine: { id: 'm1', ip: '10.0.0.5' }, token: 'tok', done: vi.fn() };
    const controller = { get: vi.fn(() => ({ status: 'ready' }) as never), wake: vi.fn(), acquire: vi.fn(async () => lease as never) };
    let refsUp = false;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
      if (url.endsWith('/refs/voices.json')) return refsUp ? Response.json(CATALOG) : new Response('not found', { status: 404 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav' } });
    });
    const tts = new DeploymentTTSProvider(controller as never, 'parle-qwen-tts', { fetchImpl: fetchImpl as never });
    const ask = () => tts.synthesize({ model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', input: 'Oi', voice: 'br-f-01', responseFormat: 'wav' }).catch(() => null);

    await ask();          // refs ainda subindo: 404
    refsUp = true;        // segundos depois o catálogo responde
    await ask();

    for (const b of bodies) expect(b.voice !== undefined && b.ref_audio === undefined).toBe(false);
  });
});
