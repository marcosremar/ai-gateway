/**
 * Unit tests for alert-router-external — Slack/Discord/PagerDuty alerting.
 *
 * Covers: severity filtering, body shape for each channel, error isolation
 * (one channel failure does not prevent others), PagerDuty event_action mapping,
 * dedup key propagation, metadata embedding, and multi-channel routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAlertRouter, type AlertPayload } from '../../src/alerting/alert-router-external';

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue({ ok: true, text: async () => 'ok' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    severity: 'warning',
    title: 'Test Alert',
    message: 'Something happened',
    metadata: { pod: 'abc123', provider: 'runpod' },
    dedupKey: 'test-dedup',
    ...overrides,
  };
}

function capturedBody(callIndex = 0): unknown {
  const [, init] = mockFetch.mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

function capturedUrl(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex][0] as string;
}

// ── Severity filtering ────────────────────────────────────────────────────────

describe('severity filtering', () => {
  it('skips alerts below minSeverity', async () => {
    const router = createAlertRouter({
      slack: { webhookUrl: 'https://hooks.slack.com/test' },
      minSeverity: 'error',
    });
    await router.routeAlert(makePayload({ severity: 'warning' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends alerts at exactly minSeverity', async () => {
    const router = createAlertRouter({
      slack: { webhookUrl: 'https://hooks.slack.com/test' },
      minSeverity: 'warning',
    });
    await router.routeAlert(makePayload({ severity: 'warning' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends alerts above minSeverity', async () => {
    const router = createAlertRouter({
      slack: { webhookUrl: 'https://hooks.slack.com/test' },
      minSeverity: 'info',
    });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('defaults minSeverity to warning — skips info', async () => {
    const router = createAlertRouter({
      slack: { webhookUrl: 'https://hooks.slack.com/test' },
    });
    await router.routeAlert(makePayload({ severity: 'info' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('defaults minSeverity to warning — sends warning', async () => {
    const router = createAlertRouter({
      slack: { webhookUrl: 'https://hooks.slack.com/test' },
    });
    await router.routeAlert(makePayload({ severity: 'warning' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Slack channel ─────────────────────────────────────────────────────────────

describe('Slack channel', () => {
  const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secret';

  it('POSTs to the configured webhook URL', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload());
    expect(capturedUrl()).toBe(WEBHOOK);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('includes title and message in attachment', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ title: 'My Title', message: 'My Message' }));
    const body = capturedBody() as { attachments: { title: string; text: string }[] };
    expect(body.attachments[0].title).toBe('My Title');
    expect(body.attachments[0].text).toBe('My Message');
  });

  it('maps critical to red attachment color', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { attachments: { color: string }[] };
    expect(body.attachments[0].color).toBe('#FF0000');
  });

  it('maps error to orange attachment color', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK }, minSeverity: 'info' });
    await router.routeAlert(makePayload({ severity: 'error' }));
    const body = capturedBody() as { attachments: { color: string }[] };
    expect(body.attachments[0].color).toBe('#FF6600');
  });

  it('maps warning to yellow attachment color', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ severity: 'warning' }));
    const body = capturedBody() as { attachments: { color: string }[] };
    expect(body.attachments[0].color).toBe('#FFCC00');
  });

  it('maps info to green attachment color', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK }, minSeverity: 'info' });
    await router.routeAlert(makePayload({ severity: 'info' }));
    const body = capturedBody() as { attachments: { color: string }[] };
    expect(body.attachments[0].color).toBe('#36A64F');
  });

  it('expands metadata into fields', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ metadata: { provider: 'runpod', cost: 1.23 } }));
    const body = capturedBody() as { attachments: { fields: { title: string; value: string }[] }[] };
    const fields = body.attachments[0].fields;
    expect(fields.find(f => f.title === 'provider')?.value).toBe('runpod');
    expect(fields.find(f => f.title === 'cost')?.value).toBe('1.23');
  });

  it('omits fields array when no metadata', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ metadata: undefined }));
    const body = capturedBody() as { attachments: { fields: unknown[] }[] };
    expect(body.attachments[0].fields).toEqual([]);
  });

  it('respects custom channel override', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK, channel: '#alerts' } });
    await router.routeAlert(makePayload());
    const body = capturedBody() as { channel: string };
    expect(body.channel).toBe('#alerts');
  });

  it('uses custom username when provided', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK, username: 'MyBot' } });
    await router.routeAlert(makePayload());
    const body = capturedBody() as { username: string };
    expect(body.username).toBe('MyBot');
  });

  it('defaults username to AI Gateway Alerts', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload());
    const body = capturedBody() as { username: string };
    expect(body.username).toBe('AI Gateway Alerts');
  });

  it('does not throw when Slack returns HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad Request' });
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await expect(router.routeAlert(makePayload())).resolves.toBeUndefined();
  });

  it('does not throw when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const router = createAlertRouter({ slack: { webhookUrl: WEBHOOK } });
    await expect(router.routeAlert(makePayload())).resolves.toBeUndefined();
  });
});

// ── Discord channel ───────────────────────────────────────────────────────────

describe('Discord channel', () => {
  const WEBHOOK = 'https://discord.com/api/webhooks/123/secret';

  it('POSTs to the configured webhook URL', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload());
    expect(capturedUrl()).toBe(WEBHOOK);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('includes title in embed', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ title: 'Discord Title' }));
    const body = capturedBody() as { embeds: { title: string }[] };
    expect(body.embeds[0].title).toBe('Discord Title');
  });

  it('includes description from message', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ message: 'Discord Message' }));
    const body = capturedBody() as { embeds: { description: string }[] };
    expect(body.embeds[0].description).toBe('Discord Message');
  });

  it('maps critical to red embed color', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { embeds: { color: number }[] };
    expect(body.embeds[0].color).toBe(0xFF0000);
  });

  it('maps warning to yellow embed color', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ severity: 'warning' }));
    const body = capturedBody() as { embeds: { color: number }[] };
    expect(body.embeds[0].color).toBe(0xFFCC00);
  });

  it('maps info to green embed color', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK }, minSeverity: 'info' });
    await router.routeAlert(makePayload({ severity: 'info' }));
    const body = capturedBody() as { embeds: { color: number }[] };
    expect(body.embeds[0].color).toBe(0x36A64F);
  });

  it('expands metadata into inline fields', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ metadata: { region: 'eu-west', cost: 2.5 } }));
    const body = capturedBody() as { embeds: { fields: { name: string; value: string; inline: boolean }[] }[] };
    const fields = body.embeds[0].fields;
    expect(fields.find(f => f.name === 'region')?.value).toBe('eu-west');
    expect(fields.every(f => f.inline === true)).toBe(true);
  });

  it('omits fields when no metadata', async () => {
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await router.routeAlert(makePayload({ metadata: undefined }));
    const body = capturedBody() as { embeds: { fields?: unknown[] }[] };
    expect(body.embeds[0].fields).toEqual([]);
  });

  it('does not throw on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Too Many Requests' });
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await expect(router.routeAlert(makePayload())).resolves.toBeUndefined();
  });

  it('does not throw when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));
    const router = createAlertRouter({ discord: { webhookUrl: WEBHOOK } });
    await expect(router.routeAlert(makePayload())).resolves.toBeUndefined();
  });
});

// ── PagerDuty channel ─────────────────────────────────────────────────────────

describe('PagerDuty channel', () => {
  const PD_URL = 'https://events.pagerduty.com/v2/enqueue';
  const KEY = 'pdIntegrationKey123';

  it('POSTs to the PagerDuty Events API', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    expect(capturedUrl()).toBe(PD_URL);
  });

  it('sends routing_key from config', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { routing_key: string };
    expect(body.routing_key).toBe(KEY);
  });

  it('maps critical to trigger event_action', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { event_action: string };
    expect(body.event_action).toBe('trigger');
  });

  it('maps error to trigger event_action', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY }, minSeverity: 'info' });
    await router.routeAlert(makePayload({ severity: 'error' }));
    const body = capturedBody() as { event_action: string };
    expect(body.event_action).toBe('trigger');
  });

  it('maps warning to info event_action', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'warning' }));
    const body = capturedBody() as { event_action: string };
    expect(body.event_action).toBe('info');
  });

  it('maps info to info event_action', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY }, minSeverity: 'info' });
    await router.routeAlert(makePayload({ severity: 'info' }));
    const body = capturedBody() as { event_action: string };
    expect(body.event_action).toBe('info');
  });

  it('propagates dedupKey as dedup_key', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical', dedupKey: 'unique-incident-42' }));
    const body = capturedBody() as { dedup_key: string };
    expect(body.dedup_key).toBe('unique-incident-42');
  });

  it('builds summary from severity and title', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical', title: 'GPU OOM' }));
    const body = capturedBody() as { payload: { summary: string } };
    expect(body.payload.summary).toContain('CRITICAL');
    expect(body.payload.summary).toContain('GPU OOM');
  });

  it('sets payload source to ai-gateway', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { payload: { source: string } };
    expect(body.payload.source).toBe('ai-gateway');
  });

  it('uses custom service as component', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY, service: 'gpu-autoscaler' } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { payload: { component: string } };
    expect(body.payload.component).toBe('gpu-autoscaler');
  });

  it('defaults component to ai-gateway', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    const body = capturedBody() as { payload: { component: string } };
    expect(body.payload.component).toBe('ai-gateway');
  });

  it('includes metadata in custom_details', async () => {
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await router.routeAlert(makePayload({ severity: 'critical', metadata: { podId: 'p123', cost: 5 } }));
    const body = capturedBody() as { payload: { custom_details: Record<string, unknown> } };
    expect(body.payload.custom_details.podId).toBe('p123');
  });

  it('does not throw on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad Request' });
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await expect(router.routeAlert(makePayload({ severity: 'critical' }))).resolves.toBeUndefined();
  });

  it('does not throw when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const router = createAlertRouter({ pagerduty: { integrationKey: KEY } });
    await expect(router.routeAlert(makePayload({ severity: 'critical' }))).resolves.toBeUndefined();
  });
});

// ── Multi-channel routing ─────────────────────────────────────────────────────

describe('multi-channel routing', () => {
  const SLACK_URL = 'https://hooks.slack.com/test';
  const DISCORD_URL = 'https://discord.com/api/webhooks/1/secret';
  const PD_KEY = 'pdkey123';

  it('sends to all configured channels', async () => {
    const router = createAlertRouter({
      slack: { webhookUrl: SLACK_URL },
      discord: { webhookUrl: DISCORD_URL },
      pagerduty: { integrationKey: PD_KEY },
    });
    await router.routeAlert(makePayload({ severity: 'critical' }));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const urls = mockFetch.mock.calls.map(c => c[0] as string);
    expect(urls).toContain(SLACK_URL);
    expect(urls).toContain(DISCORD_URL);
    expect(urls).toContain('https://events.pagerduty.com/v2/enqueue');
  });

  it('still sends to other channels when one fails', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Slack down'))
      .mockResolvedValue({ ok: true, text: async () => 'ok' });

    const router = createAlertRouter({
      slack: { webhookUrl: SLACK_URL },
      discord: { webhookUrl: DISCORD_URL },
    });
    await expect(router.routeAlert(makePayload())).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sends to only Slack when only Slack is configured', async () => {
    const router = createAlertRouter({ slack: { webhookUrl: SLACK_URL } });
    await router.routeAlert(makePayload());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl()).toBe(SLACK_URL);
  });

  it('does nothing when no channels configured', async () => {
    const router = createAlertRouter({});
    await router.routeAlert(makePayload());
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
