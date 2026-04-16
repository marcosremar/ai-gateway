import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

// Mock ws-state before importing handlers
vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
  wsClients: new Set(),
}));

import {
  handleRecallJoin,
  handleRecallLeave,
  handleRecallStatus,
  handleRecallWebhook,
  getRecallState,
  resetRecallState,
} from '../../server/recall-handlers';
import { broadcastWs } from '../../server/ws-state';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(body: Record<string, unknown> | null = null): IncomingMessage {
  const stream = new PassThrough();
  if (body !== null) {
    stream.end(JSON.stringify(body));
  } else {
    stream.end('');
  }
  return stream as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    headersSent: false,
    writeHead(status: number, _headers?: Record<string, string>) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? '';
      return res;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

function resJson(res: { _body: string }): Record<string, unknown> {
  return JSON.parse(res._body);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Recall handlers', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    resetRecallState();
    mockFetch.mockReset();
    vi.mocked(broadcastWs).mockReset();
    process.env.RECALL_API_KEY = 'test-recall-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ── handleRecallJoin ───────────────────────────────────────────────────────

  describe('handleRecallJoin', () => {
    it('returns 400 when meetingUrl is missing', async () => {
      const res = mockRes();
      await handleRecallJoin(mockReq({}), res);
      expect(res._status).toBe(400);
      // Missing meetingUrl fails Zod schema validation before reaching manual check
      expect(resJson(res).error).toBe('Validation failed');
    });

    it('returns 400 when meetingUrl is empty string', async () => {
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: '  ' }), res);
      expect(res._status).toBe(400);
      // Whitespace-only meetingUrl fails Zod .url() validation before reaching manual check
      expect(resJson(res).error).toBe('Validation failed');
    });

    it('returns 500 when RECALL_API_KEY is not set', async () => {
      delete process.env.RECALL_API_KEY;
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://teams.microsoft.com/meet/123' }), res);
      expect(res._status).toBe(500);
      expect(resJson(res).error).toBe('RECALL_API_KEY not configured');
    });

    it('returns 409 when bot is already active', async () => {
      // First join
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-111' }),
      });
      const res1 = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://teams.microsoft.com/meet/1' }), res1);
      expect(res1._status).toBe(201);

      // Second join → conflict
      const res2 = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://teams.microsoft.com/meet/2' }), res2);
      expect(res2._status).toBe(409);
      expect(resJson(res2).error).toContain('already active');
    });

    it('calls Recall.ai API with correct headers and body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-222' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/123', botName: 'MyBot' }), res);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.recall.ai/api/v1/bot');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Token test-recall-key');
      const body = JSON.parse(opts.body);
      expect(body.meeting_url).toBe('https://zoom.us/j/123');
      expect(body.bot_name).toBe('MyBot');
    });

    it('returns 201 with botId on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-333' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://meet.google.com/abc' }), res);

      expect(res._status).toBe(201);
      const json = resJson(res);
      expect(json.botId).toBe('bot-333');
      expect(json.status).toBe('joining');
    });

    it('sets state to joining on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-444' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://teams.microsoft.com/meet/x' }), res);

      const state = getRecallState();
      expect(state.botId).toBe('bot-444');
      expect(state.status).toBe('joining');
      expect(state.meetingUrl).toBe('https://teams.microsoft.com/meet/x');
    });

    it('broadcasts recall:status joining via WS', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-555' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/1' }), res);

      expect(broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recall:status', status: 'joining' }),
      );
    });

    it('returns 502 when Recall.ai API returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'Unprocessable Entity',
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/2' }), res);

      expect(res._status).toBe(502);
      expect(resJson(res).error).toContain('422');
    });

    it('returns 502 when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/3' }), res);

      expect(res._status).toBe(502);
      expect(resJson(res).error).toContain('ECONNREFUSED');
    });

    it('uses default botName "BabelCast" when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-666' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/4' }), res);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.bot_name).toBe('BabelCast');
    });

    it('uses default us-west-2 API base when RECALL_REGION not set', async () => {
      delete process.env.RECALL_REGION;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-region-default' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/5' }), res);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.recall.ai/api/v1/bot');
    });

    it('uses region-specific API base when RECALL_REGION is set', async () => {
      process.env.RECALL_REGION = 'eu-central-1';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-region-eu' }),
      });
      const res = mockRes();
      await handleRecallJoin(mockReq({ meetingUrl: 'https://zoom.us/j/6' }), res);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://eu-central-1.recall.ai/api/v1/bot');
    });
  });

  // ── handleRecallLeave ──────────────────────────────────────────────────────

  describe('handleRecallLeave', () => {
    async function joinBot(): Promise<void> {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-leave-test' }),
      });
      await handleRecallJoin(
        mockReq({ meetingUrl: 'https://teams.microsoft.com/meet/leave' }),
        mockRes(),
      );
      mockFetch.mockReset();
      vi.mocked(broadcastWs).mockReset();
    }

    it('returns 404 when no active bot', async () => {
      const res = mockRes();
      await handleRecallLeave(mockReq(), res);
      expect(res._status).toBe(404);
      expect(resJson(res).error).toContain('No active');
    });

    it('calls Recall.ai leave API with correct bot ID', async () => {
      await joinBot();
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });

      const res = mockRes();
      await handleRecallLeave(mockReq(), res);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.recall.ai/api/v1/bot/bot-leave-test/leave_call');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Token test-recall-key');
    });

    it('resets state to idle on success', async () => {
      await joinBot();
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });

      await handleRecallLeave(mockReq(), mockRes());

      const state = getRecallState();
      expect(state.botId).toBeNull();
      expect(state.status).toBe('idle');
      expect(state.meetingUrl).toBe('');
    });

    it('broadcasts recall:status idle', async () => {
      await joinBot();
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });

      await handleRecallLeave(mockReq(), mockRes());

      expect(broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recall:status', status: 'idle' }),
      );
    });

    it('returns 200 on success', async () => {
      await joinBot();
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });

      const res = mockRes();
      await handleRecallLeave(mockReq(), res);
      expect(res._status).toBe(200);
    });

    it('still resets state when Recall.ai API fails', async () => {
      await joinBot();
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      const res = mockRes();
      await handleRecallLeave(mockReq(), res);

      expect(res._status).toBe(200);
      expect(getRecallState().botId).toBeNull();
    });
  });

  // ── handleRecallStatus ─────────────────────────────────────────────────────

  describe('handleRecallStatus', () => {
    it('returns idle state when no bot active', async () => {
      const res = mockRes();
      await handleRecallStatus(mockReq(), res);

      expect(res._status).toBe(200);
      const json = resJson(res);
      expect(json.botId).toBeNull();
      expect(json.status).toBe('idle');
      expect(json.meetingUrl).toBe('');
    });

    it('returns current state when bot is active', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-status-test' }),
      });
      await handleRecallJoin(
        mockReq({ meetingUrl: 'https://zoom.us/j/status' }),
        mockRes(),
      );

      const res = mockRes();
      await handleRecallStatus(mockReq(), res);

      expect(res._status).toBe(200);
      const json = resJson(res);
      expect(json.botId).toBe('bot-status-test');
      expect(json.status).toBe('joining');
      expect(json.meetingUrl).toBe('https://zoom.us/j/status');
    });
  });

  // ── handleRecallWebhook ────────────────────────────────────────────────────

  describe('handleRecallWebhook', () => {
    it('returns 200 for valid webhook event', async () => {
      const res = mockRes();
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { bot_id: 'b1', status: { code: 'ready' } } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(resJson(res).received).toBe(true);
    });

    it('updates status to in_meeting on in_call_recording event', async () => {
      const res = mockRes();
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { bot_id: 'b1', status: { code: 'in_call_recording' } } }),
        res,
      );

      expect(getRecallState().status).toBe('in_meeting');
      expect(broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recall:status', status: 'in_meeting', wsConnected: true }),
      );
    });

    it('updates status to in_meeting on in_call_not_recording event', async () => {
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { status: { code: 'in_call_not_recording' } } }),
        mockRes(),
      );

      expect(getRecallState().status).toBe('in_meeting');
      expect(broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({ wsConnected: false }),
      );
    });

    it('updates status to ended on done event', async () => {
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { status: { code: 'done' } } }),
        mockRes(),
      );

      expect(getRecallState().status).toBe('ended');
      expect(getRecallState().botId).toBeNull();
    });

    it('updates status to ended on call_ended event', async () => {
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { status: { code: 'call_ended' } } }),
        mockRes(),
      );
      expect(getRecallState().status).toBe('ended');
    });

    it('updates status to error on fatal event', async () => {
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { status: { code: 'fatal' } } }),
        mockRes(),
      );

      expect(getRecallState().status).toBe('error');
      expect(broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recall:status', status: 'error' }),
      );
    });

    it('handles unknown event types gracefully (no state change)', async () => {
      const res = mockRes();
      await handleRecallWebhook(
        mockReq({ event: 'bot.status_change', data: { status: { code: 'some_unknown_code' } } }),
        res,
      );

      expect(res._status).toBe(200);
      expect(getRecallState().status).toBe('idle'); // unchanged
    });

    it('handles empty body gracefully', async () => {
      const res = mockRes();
      await handleRecallWebhook(mockReq({}), res);
      expect(res._status).toBe(200);
    });
  });

  // ── resetRecallState ───────────────────────────────────────────────────────

  describe('resetRecallState', () => {
    it('clears all state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'bot-reset' }),
      });
      await handleRecallJoin(
        mockReq({ meetingUrl: 'https://zoom.us/j/reset' }),
        mockRes(),
      );

      resetRecallState();

      const state = getRecallState();
      expect(state.botId).toBeNull();
      expect(state.status).toBe('idle');
      expect(state.meetingUrl).toBe('');
    });
  });
});
