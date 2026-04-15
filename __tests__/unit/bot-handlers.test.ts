/**
 * Bot Handlers Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  defaultLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  withLogContext: (_ctx: any, fn: () => any) => fn(),
  getLogContext: () => undefined,
}));

vi.mock('../../../server/state', () => ({
  botState: {
    status: 'idle', podId: '', endpoint: '', sshHost: '', sshPort: 0,
    message: '', startedAt: 0, botId: '', meetingUrl: '',
    webcamRtmpUrl: '', youtubeStreamKey: '',
  },
  setBotStateVar: vi.fn(),
  botDeployLock: false,
  setBotDeployLock: vi.fn(),
  setBotApiKey: vi.fn(),
  botApiKey: '',
  botPodApiKey: '',
  setBotPodApiKey: vi.fn(),
  deployState: { status: 'idle', endpoint: '' },
  deployApiKey: '',
}));

vi.mock('../../../server/providers', () => ({
  runpod: {
    createInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstances: vi.fn().mockResolvedValue([]),
    resolveInstanceEndpoint: vi.fn(),
    getInstanceDetail: vi.fn(),
  },
  scaleway: {
    createInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstances: vi.fn().mockResolvedValue([]),
  },
  flyio: {
    createInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstances: vi.fn().mockResolvedValue([]),
    getFlyHost: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../../server/http-utils', () => ({
  maskKey: (k: string) => k.slice(0, 4) + '****',
  readJsonBody: vi.fn(),
  handleBodyError: vi.fn(),
}));

vi.mock('../../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
  wsClients: new Set(),
  startBotTranscriptPoll: vi.fn(),
  stopBotTranscriptPoll: vi.fn(),
}));

vi.mock('../../../server/provider-warmup', () => ({
  warmupAllGpuModels: vi.fn(),
}));

vi.mock('../../../server/ai-handlers', () => ({
  isPrivateUrl: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/input-validator', () => ({
  validateInput: (body: any) => ({ ok: true, data: body }),
}));

vi.mock('../../../src/contracts', () => ({
  BotDeployRequestSchema: {},
  BotJoinRequestSchema: {},
  BotStreamPageRequestSchema: {},
}));

vi.mock('../../../server/config', () => ({
  PORT: 3000,
}));

vi.mock('../../../server/ws-server', () => ({
  getBotAudioChunks: vi.fn().mockReturnValue(0),
  startParecCapture: vi.fn(),
  stopParecCapture: vi.fn(),
}));

const botSharedPath = '../../../server/handlers/bot/bot-shared';
const botProxyPath = '../../../server/handlers/bot/bot-proxy';
const botDeployPath = '../../../server/handlers/bot/bot-deploy';
const botAudioPullPath = '../../../server/handlers/bot/bot-audio-pull';
const botMeetingPath = '../../../server/handlers/bot/bot-meeting';
const statePath = '../../../server/state';
const providersPath = '../../../server/providers';

describe('bot-shared', () => {
  describe('redactMeetingUrl', () => {
    it('should redact path and query from URL', async () => {
      const { redactMeetingUrl } = await import(botSharedPath);
      expect(redactMeetingUrl('https://zoom.us/j/123456?pwd=secret')).toBe('https://zoom.us/[redacted]');
    });

    it('should handle invalid URLs', async () => {
      const { redactMeetingUrl } = await import(botSharedPath);
      expect(redactMeetingUrl('not-a-url')).toBe('[invalid-url]');
    });

    it('should preserve protocol', async () => {
      const { redactMeetingUrl } = await import(botSharedPath);
      expect(redactMeetingUrl('http://example.com/path')).toBe('http://example.com/[redacted]');
    });
  });

  describe('botHeaders', () => {
    it('should include Content-Type by default', async () => {
      const { botHeaders } = await import(botSharedPath);
      const headers = botHeaders();
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should merge extra headers', async () => {
      const { botHeaders } = await import(botSharedPath);
      const headers = botHeaders({ 'X-Custom': 'value' });
      expect(headers['X-Custom']).toBe('value');
    });
  });

  describe('setBotState', () => {
    it('should patch botState', async () => {
      const { setBotState } = await import(botSharedPath);
      const { botState } = await import(statePath);
      setBotState({ status: 'creating', message: 'Test' });
      expect(botState.status).toBe('creating');
      expect(botState.message).toBe('Test');
    });
  });

  describe('constants', () => {
    it('should export BOT_POD_PREFIX', async () => {
      const { BOT_POD_PREFIX } = await import(botSharedPath);
      expect(BOT_POD_PREFIX).toBe('babelcast-bot-');
    });

    it('should export BOT_PORTS array', async () => {
      const { BOT_PORTS } = await import(botSharedPath);
      expect(BOT_PORTS).toContain('8080/http');
      expect(BOT_PORTS).toContain('22/tcp');
    });

    it('should export BOT_IDLE_SHUTDOWN_MS as 30 minutes', async () => {
      const { BOT_IDLE_SHUTDOWN_MS } = await import(botSharedPath);
      expect(BOT_IDLE_SHUTDOWN_MS).toBe(30 * 60_000);
    });
  });
});

describe('bot-proxy', () => {
  describe('handleBotStatus', () => {
    it('should return bot state with elapsed time', async () => {
      const { handleBotStatus } = await import(botProxyPath);
      const { botState } = await import(statePath);
      botState.startedAt = Date.now() - 5000;
      botState.youtubeStreamKey = 'abcd1234efgh';

      const res: any = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

      await handleBotStatus({} as any, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.elapsedSec).toBe(5);
      expect(body.youtubeStreamKey).toBe('abcd****');
    });

    it('should handle zero startedAt', async () => {
      const { handleBotStatus } = await import(botProxyPath);
      const { botState } = await import(statePath);
      botState.startedAt = 0;

      const res: any = { writeHead: vi.fn(), end: vi.fn() };
      await handleBotStatus({} as any, res);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.elapsedSec).toBe(0);
    });
  });

  describe('handleBotStreamStatus', () => {
    it('should return no bot pod when endpoint is empty', async () => {
      const { handleBotStreamStatus } = await import(botProxyPath);
      const { botState } = await import(statePath);
      botState.endpoint = '';

      const res: any = { writeHead: vi.fn(), end: vi.fn() };
      await handleBotStreamStatus({} as any, res);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.streaming).toBe(false);
      expect(body.reason).toBe('No bot pod');
    });
  });

  describe('handleBotProxy', () => {
    it('should return error when no endpoint', async () => {
      const { handleBotProxy } = await import(botProxyPath);
      const { botState } = await import(statePath);
      botState.endpoint = '';

      const res: any = { writeHead: vi.fn(), end: vi.fn() };
      await handleBotProxy({ url: '/v1/bot/debug/test' } as any, res);
      expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    });
  });

  describe('handleBotProxyBinary', () => {
    it('should return error when no endpoint', async () => {
      const { handleBotProxyBinary } = await import(botProxyPath);
      const { botState } = await import(statePath);
      botState.endpoint = '';

      const res: any = { writeHead: vi.fn(), end: vi.fn() };
      await handleBotProxyBinary({ url: '/v1/bot/screenshot' } as any, res);
      expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    });
  });
});

describe('bot-deploy', () => {
  describe('constants', () => {
    it('should export BOT_LOCAL_CONTAINER', async () => {
      const { BOT_LOCAL_CONTAINER } = await import(botSharedPath);
      expect(BOT_LOCAL_CONTAINER).toBe('babelcast-bot');
    });

    it('should export BOT_DOCKER_IMAGE with default', async () => {
      const { BOT_DOCKER_IMAGE } = await import(botSharedPath);
      expect(BOT_DOCKER_IMAGE).toBeTruthy();
    });
  });
});

describe('bot-audio-pull', () => {
  describe('stopBotAudioPull', () => {
    it('should handle null WebSocket gracefully', async () => {
      const { stopBotAudioPull } = await import(botAudioPullPath);
      expect(() => stopBotAudioPull()).not.toThrow();
    });
  });
});

describe('bot-meeting', () => {
  describe('timer management', () => {
    it('should set and clear idle timer', async () => {
      const { setBotIdleTimer, getBotIdleTimer } = await import(botSharedPath);

      const mockTimer = setTimeout(() => {}, 100_000) as unknown as Timer;
      setBotIdleTimer(mockTimer);
      expect(getBotIdleTimer()).toBe(mockTimer);

      clearTimeout(mockTimer);
      setBotIdleTimer(null);
      expect(getBotIdleTimer()).toBeNull();
    });

    it('should increment watchdog generation', async () => {
      const { getBotWatchdogGen, incrementBotWatchdogGen } = await import(botSharedPath);
      const gen = incrementBotWatchdogGen();
      expect(getBotWatchdogGen()).toBe(gen);
    });
  });
});
