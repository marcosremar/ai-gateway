import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlertRouter } from '../src/alerting/alert-router';
import { SlackAlertChannel } from '../src/alerting/channels/slack';
import { DiscordAlertChannel } from '../src/alerting/channels/discord';
import { GenericWebhookAlertChannel } from '../src/alerting/channels/webhook';
import { createAlertingHooks } from '../src/alerting/hooks-adapter';
import type { AlertPayload } from '../src/alerting/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Alerting', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'ok' });
  });

  describe('AlertRouter', () => {
    it('routes to all channels', async () => {
      const ch1 = { name: 'ch1', send: vi.fn() };
      const ch2 = { name: 'ch2', send: vi.fn() };
      const router = new AlertRouter([ch1, ch2]);

      const payload: AlertPayload = {
        severity: 'warning',
        title: 'Test Alert',
        message: 'Something happened',
        timestamp: new Date(),
      };

      await router.route(payload);
      expect(ch1.send).toHaveBeenCalledWith(payload);
      expect(ch2.send).toHaveBeenCalledWith(payload);
    });

    it('deduplicates identical alerts', async () => {
      const ch = { name: 'ch', send: vi.fn() };
      const router = new AlertRouter([ch], { dedupeWindowMs: 5000 });

      const payload: AlertPayload = {
        severity: 'critical',
        title: 'Dup Alert',
        message: 'Same message',
        timestamp: new Date(),
      };

      await router.route(payload);
      await router.route(payload); // duplicate
      expect(ch.send).toHaveBeenCalledTimes(1);
    });

    it('allows different alerts', async () => {
      const ch = { name: 'ch', send: vi.fn() };
      const router = new AlertRouter([ch]);

      await router.route({
        severity: 'warning', title: 'A', message: 'msg1', timestamp: new Date(),
      });
      await router.route({
        severity: 'critical', title: 'B', message: 'msg2', timestamp: new Date(),
      });

      expect(ch.send).toHaveBeenCalledTimes(2);
    });

    it('rate limits alerts', async () => {
      const ch = { name: 'ch', send: vi.fn() };
      const router = new AlertRouter([ch], { rateLimit: { max: 2, windowMs: 60_000 } });

      for (let i = 0; i < 5; i++) {
        await router.route({
          severity: 'info', title: `Alert ${i}`, message: `msg ${i}`, timestamp: new Date(),
        });
      }

      expect(ch.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('SlackAlertChannel', () => {
    it('sends correct Slack payload', async () => {
      const slack = new SlackAlertChannel('https://hooks.slack.com/test');
      await slack.send({
        severity: 'warning',
        title: 'Cost Alert',
        message: 'Budget exceeded',
        metadata: { provider: 'runpod' },
        timestamp: new Date(),
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/test');
      const body = JSON.parse(opts.body);
      expect(body.text).toContain(':warning:');
      expect(body.text).toContain('Cost Alert');
      expect(body.blocks).toBeDefined();
    });
  });

  describe('DiscordAlertChannel', () => {
    it('sends correct Discord payload', async () => {
      const discord = new DiscordAlertChannel('https://discord.com/api/webhooks/test');
      await discord.send({
        severity: 'critical',
        title: 'Health Down',
        message: 'GPU unhealthy',
        timestamp: new Date(),
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toBe('Health Down');
      expect(body.embeds[0].color).toBe(0xe74c3c); // red for critical
    });
  });

  describe('GenericWebhookAlertChannel', () => {
    it('sends JSON payload', async () => {
      const webhook = new GenericWebhookAlertChannel('https://example.com/alert', {
        headers: { 'X-Custom': 'test' },
      });

      await webhook.send({
        severity: 'info',
        title: 'Test',
        message: 'Hello',
        timestamp: new Date(),
      });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-Custom']).toBe('test');
    });
  });

  describe('createAlertingHooks', () => {
    it('wires gateway hooks to alert router', () => {
      const ch = { name: 'ch', send: vi.fn() };
      const router = new AlertRouter([ch]);
      const hooks = createAlertingHooks(router);

      expect(hooks.onCostAlert).toBeDefined();
      expect(hooks.onHealthChange).toBeDefined();
      expect(hooks.onFallback).toBeDefined();
      expect(hooks.onScaleUp).toBeDefined();
      expect(hooks.onScaleDown).toBeDefined();
    });
  });
});
