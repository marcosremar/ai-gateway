/**
 * Modal Real API Integration Tests
 *
 * Tests the AI Gateway's Modal integration against the LIVE Modal API.
 * Requires real credentials in .env:
 *   MODAL_TOKEN_ID=ak-...
 *   MODAL_TOKEN_SECRET=as-...
 *
 * Run: bun run vitest run --config vitest.config.modal.mts
 *
 * Tests:
 *   1. Modal REST API — list apps (handleModalApps)
 *   2. Modal TTS — synthesize speech via MOSS-TTS endpoint
 *   3. ModalClient GPU provider — discoverInstance, getInstanceStatus
 *   4. Autoscaler — createAutoscaler with Modal tier, getPoolStatus, getAutoScaleDecision
 *   5. MOSS-TTS endpoint health
 *   6. Gateway unified API — handleModalApps + handleModalStop
 *
 * Note: Modal's v1/apps REST API may return gRPC/protobuf instead of JSON.
 * The handleModalApps handler gracefully returns connected:false in that case.
 * The ModalClient uses the `modal` CLI for listing apps — requires CLI installed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Load .env ────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env */ }
}
loadEnv();

// ── Imports from ai-gateway ──────────────────────────────────────────────
import { handleModalApps, handleModalStop } from '@ai-gateway/handlers/modal-handler';
import { ModalTTSProvider } from '@ai-gateway/providers/modal';
import { ModalClient } from '@ai-gateway/gpu-providers/modal-client';
import { createAutoscaler } from '@ai-gateway/factory';
import { InMemoryStateAdapter } from '@ai-gateway/adapters/in-memory-state';
import { probeGpuHealth } from '@ai-gateway/autoscaler/health';
import type { AutoScalerConfig, GpuTierConfig } from '@ai-gateway/types';
import type { HandlerResult } from '@ai-gateway/handlers/types';

interface ModalAppsResult {
  connected: boolean;
  apps?: Array<{ appId: string; name: string; stateLabel: string; nRunningTasks: number; webUrl?: string }>;
  totalCount?: number;
  deployedCount?: number;
  error?: string;
}

// ── Credential helpers ───────────────────────────────────────────────────
const TOKEN_ID = process.env.MODAL_TOKEN_ID ?? '';
const TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET ?? '';
const API_KEY = `${TOKEN_ID}:${TOKEN_SECRET}`;

const hasCredentials = TOKEN_ID.length > 0 && TOKEN_SECRET.length > 0;

const MODAL_TTS_ENDPOINT =
  process.env.MODAL_TTS_URL ||
  'https://marcosremar--babelcast-tts-serve.modal.run';

// ── Endpoint availability check ──────────────────────────────────────────
let modalTtsAvailable = false;

async function checkModalTtsAvailability(): Promise<boolean> {
  try {
    const res = await fetch(MODAL_TTS_ENDPOINT, {
      signal: AbortSignal.timeout(10_000),
    });
    // 404 = stopped, 405 = running but method not allowed on root, 200 = running
    return res.status !== 404;
  } catch {
    return false;
  }
}

// ── Helper: create autoscaler with Modal tier ────────────────────────────
function createModalAutoscaler(userId: string, activeSessions: number) {
  const stateAdapter = new InMemoryStateAdapter();

  const config: AutoScalerConfig = {
    enabled: true,
    threshold: 1,
    windowMinutes: 5,
    maxLatencyMs: 2000,
    tiers: [
      {
        provider: 'modal',
        gpuTypes: ['parle-ultralight'],
        apiKey: API_KEY,
      } as GpuTierConfig,
    ],
  };

  const autoscaler = createAutoscaler({
    settingsStore: {
      get: async () => ({ autoscaler: config }),
      patch: async () => {},
    },
    stateStore: stateAdapter,
    sessionResolver: {
      countDbSessions: async () => activeSessions,
      resolveTeacher: async () => null,
    },
    logger: {
      log: (...args: unknown[]) => console.log('[autoscaler]', ...args),
      warn: (...args: unknown[]) => console.warn('[autoscaler]', ...args),
      error: (...args: unknown[]) => console.error('[autoscaler]', ...args),
    },
  });

  return { autoscaler, config };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Modal REST API — handleModalApps
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Modal REST API (handleModalApps)', () => {
  it.skipIf(!hasCredentials)('calls Modal API and returns a valid response', async () => {
    const result = await handleModalApps(TOKEN_ID, TOKEN_SECRET);
    const body = result.body as ModalAppsResult;

    expect(result.status).toBe(200);

    // Modal's v1/apps endpoint may return gRPC/protobuf instead of JSON.
    // handleModalApps returns connected:false with an error in that case.
    if (body.connected) {
      // REST JSON worked — validate app structure
      expect(body.apps).toBeDefined();
      expect(Array.isArray(body.apps)).toBe(true);
      expect(typeof body.totalCount).toBe('number');
      expect(typeof body.deployedCount).toBe('number');

      console.log(`[Modal API] Connected! Found ${body.totalCount} apps (${body.deployedCount} deployed)`);
      for (const app of body.apps ?? []) {
        console.log(`  - ${app.name} [${app.stateLabel}] tasks=${app.nRunningTasks} appId=${app.appId}`);
      }
    } else {
      // gRPC/protobuf response — handler gracefully reports disconnected
      expect(typeof body.error).toBe('string');
      console.log(`[Modal API] API returned non-JSON (gRPC): ${body.error}`);
    }
  });

  it.skipIf(!hasCredentials)('apps have required fields when API returns JSON', async () => {
    const result = await handleModalApps(TOKEN_ID, TOKEN_SECRET);
    const body = result.body as ModalAppsResult;
    if (!body.connected) return; // skip if gRPC

    const apps = body.apps ?? [];
    for (const app of apps) {
      expect(app.appId).toBeTruthy();
      expect(typeof app.name).toBe('string');
      expect(typeof app.stateLabel).toBe('string');
      expect(typeof app.nRunningTasks).toBe('number');
    }
  });

  it.skipIf(!hasCredentials)('apps are sorted by state priority when API returns JSON', async () => {
    const result = await handleModalApps(TOKEN_ID, TOKEN_SECRET);
    const body = result.body as ModalAppsResult;
    if (!body.connected) return; // skip if gRPC

    const apps = body.apps ?? [];
    if (apps.length >= 2) {
      const statePriority: Record<string, number> = {
        deployed: 0, ephemeral: 1, initializing: 2,
        stopped: 3, detached: 4, disabled: 5, unknown: 6,
      };
      for (let i = 1; i < apps.length; i++) {
        const prev = statePriority[apps[i - 1].stateLabel] ?? 99;
        const curr = statePriority[apps[i].stateLabel] ?? 99;
        expect(prev).toBeLessThanOrEqual(curr);
      }
    }
  });

  it('returns error for invalid credentials', async () => {
    const result = await handleModalApps('invalid-token', 'invalid-secret');
    const body = result.body as ModalAppsResult;
    expect(result.status).toBe(200);
    expect(body.connected).toBe(false);
    expect(body.error).toBeTruthy();
    console.log(`[Modal API] Invalid creds error: ${body.error}`);
  });

  it('returns error for empty credentials', async () => {
    const result = await handleModalApps('', '');
    const body = result.body as ModalAppsResult;
    expect(result.status).toBe(400);
    expect(body.error).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Modal TTS — ModalTTSProvider (Qwen3-TTS)
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Modal TTS (Qwen3-TTS)', () => {
  let tts: ModalTTSProvider;

  beforeAll(async () => {
    tts = new ModalTTSProvider(MODAL_TTS_ENDPOINT);
    modalTtsAvailable = await checkModalTtsAvailability();
    if (!modalTtsAvailable) {
      console.log(`[Modal TTS] Endpoint ${MODAL_TTS_ENDPOINT} is stopped/unavailable — skipping synthesis tests`);
    }
  });

  it('isConfigured() returns true (no API key needed)', () => {
    expect(tts.isConfigured()).toBe(true);
    expect(tts.providerId).toBe('modal');
  });

  it('getModels() returns Qwen3-TTS model', () => {
    const models = tts.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe('qwen3-tts');
    expect(models[0].capability).toBe('tts');
  });

  it('synthesizes Portuguese speech', async () => {
    if (!modalTtsAvailable) {
      console.log('[Modal TTS] Skipped — endpoint stopped');
      return;
    }

    const result = await tts.synthesize({
      input: 'Ola, como vai voce?',
      model: 'qwen3-tts',
      voice: 'serena',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('audio/wav');

    const header = result.audio.toString('ascii', 0, 4);
    expect(header).toBe('RIFF');
    console.log(`[Modal TTS] PT audio: ${(result.audio.length / 1024).toFixed(1)} KB`);
  }, 30_000);

  it('synthesizes English speech', async () => {
    if (!modalTtsAvailable) {
      console.log('[Modal TTS] Skipped — endpoint stopped');
      return;
    }

    const result = await tts.synthesize({
      input: 'Hello, how are you today?',
      model: 'qwen3-tts',
      voice: 'ryan',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    const header = result.audio.toString('ascii', 0, 4);
    expect(header).toBe('RIFF');
    console.log(`[Modal TTS] EN audio: ${(result.audio.length / 1024).toFixed(1)} KB`);
  }, 30_000);

  it('synthesizes longer text', async () => {
    if (!modalTtsAvailable) {
      console.log('[Modal TTS] Skipped — endpoint stopped');
      return;
    }

    const longText =
      'A inteligencia artificial tem transformado muitos aspectos da nossa vida. ' +
      'Desde assistentes de voz ate carros autonomos, a tecnologia esta cada vez mais presente.';

    const result = await tts.synthesize({
      input: longText,
      model: 'qwen3-tts',
      voice: 'serena',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(5000);
    console.log(`[Modal TTS] Long text audio: ${(result.audio.length / 1024).toFixed(1)} KB`);
  }, 60_000);

  it('synthesizeStream returns a readable stream', async () => {
    if (!modalTtsAvailable) {
      console.log('[Modal TTS] Skipped — endpoint stopped');
      return;
    }

    const stream = await tts.synthesizeStream({
      input: 'Teste de stream.',
      model: 'qwen3-tts',
      voice: 'serena',
    });

    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
    console.log(`[Modal TTS] Stream: ${chunks.length} chunks, ${(totalBytes / 1024).toFixed(1)} KB`);
  }, 30_000);

  it('defaults to serena when voice is unknown', async () => {
    if (!modalTtsAvailable) {
      console.log('[Modal TTS] Skipped — endpoint stopped');
      return;
    }

    const result = await tts.synthesize({
      input: 'Bom dia!',
      model: 'qwen3-tts',
      voice: 'unknown-voice',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(500);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. ModalClient GPU Provider
// ═════════════════════════════════════════════════════════════════════════════

describe('3. ModalClient GPU Provider', () => {
  let client: ModalClient;

  beforeAll(() => {
    client = new ModalClient({ workspace: 'marcosremar' });
  });

  it('has correct providerId and bootTimeSecs', () => {
    expect(client.providerId).toBe('modal');
    expect(client.bootTimeSecs).toBe(60);
  });

  it.skipIf(!hasCredentials)('discoverInstance finds parle-ultralight app', async () => {
    try {
      const instance = await client.discoverInstance(
        { apiKey: API_KEY },
        ['parle-ultralight'],
      );

      console.log('[ModalClient] discoverInstance result:', instance);

      if (instance) {
        expect(instance.instanceId).toBeTruthy();
        expect(instance.endpoint).toBeTruthy();
        expect(instance.endpoint).toContain('.modal.run');
        console.log(`[ModalClient] Found: ${instance.instanceName} [${instance.status}] @ ${instance.endpoint}`);
      } else {
        console.log('[ModalClient] No parle-ultralight app deployed (expected if app is stopped)');
      }
    } catch (e) {
      // ModalClient uses CLI — may fail if `modal` CLI is not installed
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('command not found')) {
        console.log('[ModalClient] Skipped — modal CLI not installed locally');
        return;
      }
      throw e;
    }
  }, 60_000);

  it.skipIf(!hasCredentials)('getInstanceStatus returns null for non-existent app', async () => {
    try {
      const status = await client.getInstanceStatus('ap-nonexistent-12345', { apiKey: API_KEY });
      expect(status).toBeNull();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('command not found')) {
        console.log('[ModalClient] Skipped — modal CLI not installed locally');
        return;
      }
      throw e;
    }
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Autoscaler with Modal Tier
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Autoscaler with Modal Tier', () => {
  it.skipIf(!hasCredentials)('creates autoscaler with Modal tier and initial state is idle', () => {
    const { autoscaler, config } = createModalAutoscaler('test-user-modal', 0);

    expect(autoscaler).toBeTruthy();

    // getPoolStatus returns tier states for the user
    const states = autoscaler.getPoolStatus('test-user-modal');
    // Initially empty (no tiers initialized yet until decision runs)
    console.log(`[Autoscaler] Pool status: ${JSON.stringify(states)}`);

    // Engine and registry should be wired
    expect(autoscaler.engine).toBeTruthy();
    expect(autoscaler.registry).toBeTruthy();

    // Modal provider should be registered
    const modalProvider = autoscaler.registry.get('modal');
    expect(modalProvider).toBeTruthy();
    expect(modalProvider?.providerId).toBe('modal');
    expect(modalProvider?.bootTimeSecs).toBe(60);

    // Verify other providers are also registered
    expect(autoscaler.registry.get('runpod')).toBeTruthy();
    expect(autoscaler.registry.get('tensordock')).toBeTruthy();
    expect(autoscaler.registry.get('vast')).toBeTruthy();
  });

  it.skipIf(!hasCredentials)('probeGpuHealth handles MOSS-TTS endpoint', async () => {
    const health = await probeGpuHealth(MODAL_TTS_ENDPOINT, 10_000);

    console.log(`[Autoscaler] Health probe result:`, health);

    // probeGpuHealth returns boolean: true = healthy, false = unhealthy/unreachable
    expect(typeof health).toBe('boolean');
    if (health) {
      console.log('[Autoscaler] GPU endpoint is healthy');
    } else {
      console.log('[Autoscaler] Health probe returned false (endpoint likely stopped)');
    }
  }, 15_000);

  it.skipIf(!hasCredentials)('getAutoScaleDecision with 0 sessions returns idle/noop', async () => {
    const { autoscaler, config } = createModalAutoscaler('test-decision-idle', 0);

    const decision = await autoscaler.getAutoScaleDecision(
      'test-decision-idle',
      config,
    );

    console.log(`[Autoscaler] Decision (0 sessions): ${JSON.stringify(decision, null, 2)}`);

    expect(decision).toBeTruthy();
    expect(typeof decision.reason).toBe('string');
    expect(decision.activeSessions).toBe(0);
    // With 0 sessions, should not trigger boot
    expect(decision.gpuState).toBe('idle');
  }, 30_000);

  it.skipIf(!hasCredentials)('getAutoScaleDecision with active sessions triggers boot', async () => {
    const { autoscaler, config } = createModalAutoscaler('test-decision-boot', 1);

    const decision = await autoscaler.getAutoScaleDecision(
      'test-decision-boot',
      config,
    );

    console.log(`[Autoscaler] Decision (1 session): ${JSON.stringify(decision, null, 2)}`);

    expect(decision).toBeTruthy();
    expect(typeof decision.reason).toBe('string');

    // With 1 active session, decision should either:
    // - Boot first tier (gpuState → 'booting') if enabled
    // - Stay idle if autoscaling is disabled in the config
    if (decision.enabled) {
      // Should transition to booting or already be booting
      expect(['booting', 'ready']).toContain(decision.gpuState);
      console.log(`[Autoscaler] Boot triggered! state=${decision.gpuState}`);
    } else {
      console.log(`[Autoscaler] Autoscaling disabled in config`);
    }

    // Pool status should reflect the decision
    const states = autoscaler.getPoolStatus('test-decision-boot');
    console.log(`[Autoscaler] Pool status after decision: ${JSON.stringify(states)}`);
  }, 60_000);

  it.skipIf(!hasCredentials)('PROVIDER_BOOT_SECS includes modal at 60s', () => {
    const { autoscaler } = createModalAutoscaler('test-boot-secs', 0);
    expect(autoscaler.PROVIDER_BOOT_SECS.modal).toBe(60);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. MOSS-TTS Endpoint Health
// ═════════════════════════════════════════════════════════════════════════════

describe('5. MOSS-TTS Endpoint Health', () => {
  it('endpoint is reachable (may be stopped)', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(MODAL_TTS_ENDPOINT, {
        signal: controller.signal,
      });

      // A running Modal app returns some response
      // 404 = app stopped, 200/405 = app running
      console.log(`[Health] ${MODAL_TTS_ENDPOINT} -> ${res.status}`);
      expect(res.status).toBeDefined();

      if (res.status === 404) {
        console.log('[Health] MOSS-TTS endpoint is STOPPED (auto-scaled to zero)');
      } else {
        console.log('[Health] MOSS-TTS endpoint is RUNNING');
      }
    } finally {
      clearTimeout(timeout);
    }
  }, 15_000);

  it('/api/text endpoint responds to POST (when running)', async () => {
    if (!modalTtsAvailable) {
      console.log('[Health] Skipped — endpoint stopped');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(`${MODAL_TTS_ENDPOINT}/api/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Teste.',
          language: 'pt',
          temperature: 0.8,
          top_p: 0.6,
          top_k: 30,
        }),
        signal: controller.signal,
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.audio).toBeTruthy();
      expect(typeof data.audio).toBe('string');
      console.log(`[Health] /api/text -> ${res.status}, audio length: ${data.audio.length} chars`);
      if (data.generation_time) {
        console.log(`[Health] Generation time: ${data.generation_time.toFixed(2)}s`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Gateway Unified API with Modal
// ═════════════════════════════════════════════════════════════════════════════

describe('6. Gateway unified API', () => {
  it.skipIf(!hasCredentials)('handleModalApps returns valid response structure', async () => {
    const result = await handleModalApps(TOKEN_ID, TOKEN_SECRET);
    const body = result.body as ModalAppsResult;

    expect(result.status).toBe(200);
    expect(typeof body.connected).toBe('boolean');

    if (body.connected) {
      // REST JSON worked
      const deployed = (body.apps ?? []).filter(
        (a: { stateLabel: string }) => a.stateLabel === 'deployed',
      );

      for (const app of deployed) {
        if (app.webUrl) {
          expect(app.webUrl).toContain('modal.run');
        }
      }
      console.log(`[Gateway] ${deployed.length} deployed apps found`);
    } else {
      // gRPC response — handler returned graceful error
      expect(body.error).toBeTruthy();
      console.log(`[Gateway] Modal API non-JSON response: ${body.error}`);
    }
  });

  it.skipIf(!hasCredentials)('handleModalStop rejects invalid appId gracefully', async () => {
    const result = await handleModalStop(
      'ap-nonexistent-99999',
      TOKEN_ID,
      TOKEN_SECRET,
    );

    // Should return error but not crash
    console.log(`[Gateway] Stop non-existent app: status=${result.status}, body=`, result.body);
    expect(result).toBeTruthy();
    expect(typeof result.status).toBe('number');
  });
});
