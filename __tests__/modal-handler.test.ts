import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleModalApps, handleModalStop } from '@ai-gateway/handlers/modal-handler';

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchText(text: string, status: number): Response {
  return new Response(text, { status });
}

describe('modal-handler', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── handleModalApps ───────────────────────────────────────────────────

  describe('handleModalApps', () => {
    it('returns error for missing credentials', async () => {
      const result = await handleModalApps('', 'secret');
      expect(result.status).toBe(400);
      expect(result.body).toHaveProperty('error');
    });

    it('returns error for empty token secret', async () => {
      const result = await handleModalApps('token-id', '');
      expect(result.status).toBe(400);
    });

    it('returns connected=false on 401', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Unauthorized', 401));
      const result = await handleModalApps('bad-id', 'bad-secret');
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).connected).toBe(false);
      expect((result.body as Record<string, unknown>).error).toContain('Credenciais invalidas');
    });

    it('returns connected=false on 403', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Forbidden', 403));
      const result = await handleModalApps('id', 'secret');
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).connected).toBe(false);
    });

    it('returns connected=false on other HTTP errors', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Server Error', 500));
      const result = await handleModalApps('id', 'secret');
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).connected).toBe(false);
      expect((result.body as Record<string, unknown>).error).toContain('500');
    });

    it('parses and normalizes apps successfully', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        apps: [
          { app_id: 'app-1', name: 'parle-speech', state: 3, n_running_tasks: 2, web_url: 'https://modal.run/a' },
          { app_id: 'app-2', name: 'other-app', state: 5, created_at: '2026-01-01' },
        ],
      }));

      const result = await handleModalApps('id', 'secret');
      const body = result.body as Record<string, unknown>;
      expect(body.connected).toBe(true);
      expect((body.apps as unknown[]).length).toBe(2);
      expect(body.totalCount).toBe(2);
      expect(body.deployedCount).toBe(1);
    });

    it('normalizes app state numbers to labels', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        apps: [
          { app_id: 'a1', name: 'test', state: 3 },  // deployed
          { app_id: 'a2', name: 'test2', state: 5 },  // stopped
        ],
      }));

      const result = await handleModalApps('id', 'secret');
      const apps = (result.body as Record<string, unknown>).apps as Array<Record<string, unknown>>;
      expect(apps[0].stateLabel).toBe('deployed');
      expect(apps[1].stateLabel).toBe('stopped');
    });

    it('deduplicates apps by name, keeping deployed over stopped', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        apps: [
          { app_id: 'old', name: 'my-app', state: 5 },  // stopped
          { app_id: 'new', name: 'my-app', state: 3 },  // deployed
        ],
      }));

      const result = await handleModalApps('id', 'secret');
      const apps = (result.body as Record<string, unknown>).apps as Array<Record<string, unknown>>;
      expect(apps).toHaveLength(1);
      expect(apps[0].appId).toBe('new');
    });

    it('sorts apps by state priority (deployed first)', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        apps: [
          { app_id: 'a-stopped', name: 'stopped-app', state: 5 },
          { app_id: 'a-deployed', name: 'deployed-app', state: 3 },
        ],
      }));

      const result = await handleModalApps('id', 'secret');
      const apps = (result.body as Record<string, unknown>).apps as Array<Record<string, unknown>>;
      expect(apps[0].stateLabel).toBe('deployed');
      expect(apps[1].stateLabel).toBe('stopped');
    });

    it('handles non-JSON response gracefully', async () => {
      const badResponse = new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      fetchSpy.mockResolvedValueOnce(badResponse);
      const result = await handleModalApps('id', 'secret');
      expect((result.body as Record<string, unknown>).connected).toBe(false);
      expect((result.body as Record<string, unknown>).error).toContain('não é JSON');
    });

    it('handles timeout error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
      const result = await handleModalApps('id', 'secret');
      expect((result.body as Record<string, unknown>).connected).toBe(false);
      expect((result.body as Record<string, unknown>).error).toContain('demorou demais');
    });

    it('handles network error (ECONNREFUSED)', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
      const result = await handleModalApps('id', 'secret');
      expect((result.body as Record<string, unknown>).connected).toBe(false);
      expect((result.body as Record<string, unknown>).error).toContain('conectar');
    });

    it('constructs Basic auth header correctly', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ apps: [] }));
      await handleModalApps('my-token-id', 'my-token-secret');

      const authHeader = fetchSpy.mock.calls[0][1].headers.Authorization;
      const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe('my-token-id:my-token-secret');
    });

    it('returns empty apps list gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ apps: [] }));
      const result = await handleModalApps('id', 'secret');
      const body = result.body as Record<string, unknown>;
      expect(body.connected).toBe(true);
      expect((body.apps as unknown[]).length).toBe(0);
      expect(body.totalCount).toBe(0);
    });
  });

  // ── handleModalStop ───────────────────────────────────────────────────

  describe('handleModalStop', () => {
    it('returns error for missing params', async () => {
      const result = await handleModalStop('', 'id', 'secret');
      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toBeDefined();
    });

    it('stops app successfully', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      const result = await handleModalStop('app-123', 'id', 'secret');
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).success).toBe(true);
      expect((result.body as Record<string, unknown>).appId).toBe('app-123');
    });

    it('propagates API error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Not Found', 404));
      const result = await handleModalStop('app-bad', 'id', 'secret');
      expect(result.status).toBe(502);
      expect((result.body as Record<string, unknown>).success).toBe(false);
    });
  });
});
