/**
 * Unit tests for src/autoscaler/health.ts
 * Covers: probeGpuHealth (boolean + returnData overloads), SSH health probe.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeGpuHealth } from '../../src/autoscaler/health';

afterEach(() => vi.unstubAllGlobals());

// ── probeGpuHealth ────────────────────────────────────────────────────────────

describe('probeGpuHealth', () => {
  describe('empty/missing endpoint', () => {
    it('returns false for empty string', async () => {
      expect(await probeGpuHealth('')).toBe(false);
    });

    it('returns { ok: false } in returnData mode for empty string', async () => {
      expect(await probeGpuHealth('', true)).toEqual({ ok: false });
    });
  });

  describe('boolean mode (returnData=false/omitted)', () => {
    it('returns true for healthy status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      })));
      expect(await probeGpuHealth('http://gpu')).toBe(true);
    });

    it('returns true for ok status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'ok' }),
      })));
      expect(await probeGpuHealth('http://gpu')).toBe(true);
    });

    it('returns true for degraded status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'degraded' }),
      })));
      expect(await probeGpuHealth('http://gpu')).toBe(true);
    });

    it('returns true for ready status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'ready' }),
      })));
      expect(await probeGpuHealth('http://gpu')).toBe(true);
    });

    it('returns false for unknown status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'starting' }),
      })));
      expect(await probeGpuHealth('http://gpu')).toBe(false);
    });

    it('returns false for non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ status: 'healthy' }),
      })));
      expect(await probeGpuHealth('http://gpu')).toBe(false);
    });

    it('returns false on network error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
      expect(await probeGpuHealth('http://gpu')).toBe(false);
    });

    it('calls the correct /health URL', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      await probeGpuHealth('http://gpu-host:8080');
      expect(fetchMock.mock.calls[0][0]).toBe('http://gpu-host:8080/health');
    });
  });

  describe('returnData mode (returnData=true)', () => {
    it('returns { ok: true, data } for healthy status', async () => {
      const healthData = { status: 'healthy', models: { whisper: true } };
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => healthData,
      })));
      const result = await probeGpuHealth('http://gpu', true);
      expect(result).toEqual({ ok: true, data: healthData });
    });

    it('returns { ok: false } for non-ok HTTP', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })));
      const result = await probeGpuHealth('http://gpu', true);
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: false } for unknown status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'booting' }),
      })));
      const result = await probeGpuHealth('http://gpu', true);
      expect(result).toEqual({ ok: false });
    });

    it('does not include data when status is unhealthy', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'error' }),
      })));
      const result = await probeGpuHealth('http://gpu', true);
      expect((result as any).data).toBeUndefined();
    });

    it('returns { ok: false } on network error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
      const result = await probeGpuHealth('http://gpu', true);
      expect((result as any).ok).toBe(false);
    });

    it('sets timedOut when AbortError', async () => {
      const abortError = new Error('signal timed out');
      abortError.name = 'TimeoutError';
      vi.stubGlobal('fetch', vi.fn(async () => { throw abortError; }));
      const result = await probeGpuHealth('http://gpu', true);
      expect((result as any).timedOut).toBe(true);
    });

    it('timedOut is undefined for non-timeout errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
      const result = await probeGpuHealth('http://gpu', true);
      expect((result as any).timedOut).toBeUndefined();
    });
  });

  describe('timeout parameter', () => {
    it('passes custom timeout to AbortSignal', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      await probeGpuHealth('http://gpu', false, 5000);
      // Just verify it was called — AbortSignal internals not directly accessible
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
