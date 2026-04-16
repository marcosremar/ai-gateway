import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunpodClient } from '@ai-gateway/gpu-providers/runpod-client';
import { TensordockClient } from '@ai-gateway/gpu-providers/tensordock-client';
import { VastClient } from '@ai-gateway/gpu-providers/vast-client';
import { ModalClient } from '@ai-gateway/gpu-providers/modal-client';
import type { ProviderCredentials } from '@ai-gateway/gpu-providers/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const creds: ProviderCredentials = {
  apiKey: 'test-key',
  authId: 'test-auth',
};

describe('GPU provider edge cases', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Malformed JSON 200 responses ──────────────────────────────────────

  describe('malformed JSON 200 responses', () => {
    it('RunPod discoverInstance handles invalid JSON body', async () => {
      const client = new RunpodClient();
      fetchSpy.mockResolvedValueOnce(new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const result = await client.discoverInstance(creds, ['RTX 4090']);
      expect(result).toBeNull();
    });

    it('TensorDock discoverInstance handles invalid JSON body', async () => {
      const client = new TensordockClient();
      fetchSpy.mockResolvedValueOnce(new Response('{{bad', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeNull();
    });

    it('Vast discoverInstance handles invalid JSON body', async () => {
      const client = new VastClient();
      // listInstances (on-demand) returns bad JSON
      fetchSpy.mockResolvedValueOnce(new Response('broken', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const result = await client.discoverInstance(creds, ['RTX 3090']);
      expect(result).toBeNull();
    });
  });

  // ── Empty response bodies ─────────────────────────────────────────────

  describe('empty response bodies', () => {
    it('RunPod listInstances handles empty body', async () => {
      const client = new RunpodClient();
      fetchSpy.mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const result = await client.listInstances(creds);
      expect(result).toEqual([]);
    });

    it('TensorDock listInstances handles empty body from both APIs', async () => {
      const client = new TensordockClient();
      // v0 returns empty
      fetchSpy.mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      // v2 returns empty
      fetchSpy.mockResolvedValueOnce(new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const result = await client.listInstances(creds);
      expect(result).toEqual([]);
    });
  });

  // ── Credential edge cases ─────────────────────────────────────────────

  describe('credential edge cases', () => {
    it('RunPod works with empty string apiKey', async () => {
      const client = new RunpodClient();

      const result = await client.listInstances({ apiKey: '' });
      // Empty string is falsy — implementation short-circuits and returns [] without calling fetch
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(result).toEqual([]);
    });

    it('TensorDock getInstanceStatus with empty apiKey', async () => {
      const client = new TensordockClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { status: 'running' } },
      }));

      const result = await client.getInstanceStatus('vm-1', { apiKey: '' });
      expect(result).toBe('running');
    });

    it('Vast listInstances with missing authId', async () => {
      const client = new VastClient();
      // On-demand instances call
      fetchSpy.mockResolvedValueOnce(jsonResponse({ instances: [] }));

      const result = await client.listInstances({ apiKey: 'key-only' });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── 429 rate limiting ─────────────────────────────────────────────────

  describe('429 rate limiting', () => {
    it('RunPod discoverInstance returns null on 429', async () => {
      const client = new RunpodClient();
      fetchSpy.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));

      const result = await client.discoverInstance(creds, ['RTX 4090']);
      expect(result).toBeNull();
    });

    it('TensorDock getInstanceStatus returns null on 429', async () => {
      const client = new TensordockClient();
      // v2 returns 429
      fetchSpy.mockResolvedValueOnce(new Response('Too many requests', { status: 429 }));

      const result = await client.getInstanceStatus('vm-1', { apiKey: 'test' });
      expect(result).toBeNull();
    });
  });

  // ── Network timeouts ──────────────────────────────────────────────────

  describe('network timeouts', () => {
    it('RunPod discoverInstance handles AbortError', async () => {
      const client = new RunpodClient();
      fetchSpy.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

      const result = await client.discoverInstance(creds, ['RTX 4090']);
      expect(result).toBeNull();
    });

    it('TensorDock discoverInstance handles timeout', async () => {
      const client = new TensordockClient();
      fetchSpy.mockRejectedValueOnce(new DOMException('Timeout', 'TimeoutError'));

      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeNull();
    });

    it('Vast discoverInstance handles timeout', async () => {
      const client = new VastClient();
      fetchSpy.mockRejectedValueOnce(new DOMException('Timeout', 'TimeoutError'));

      const result = await client.discoverInstance(creds, ['RTX 3090']);
      expect(result).toBeNull();
    });
  });

  // ── Cross-provider providerId ─────────────────────────────────────────

  describe('provider identity', () => {
    it('each provider has correct providerId', () => {
      expect(new RunpodClient().providerId).toBe('runpod');
      expect(new TensordockClient().providerId).toBe('tensordock');
      expect(new VastClient().providerId).toBe('vast');
      expect(new ModalClient().providerId).toBe('modal');
    });

    it('each provider has bootTimeSecs > 0', () => {
      expect(new RunpodClient().bootTimeSecs).toBeGreaterThan(0);
      expect(new TensordockClient().bootTimeSecs).toBeGreaterThan(0);
      expect(new VastClient().bootTimeSecs).toBeGreaterThan(0);
      expect(new ModalClient().bootTimeSecs).toBeGreaterThan(0);
    });
  });
});
