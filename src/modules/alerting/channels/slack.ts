/**
 * Slack alert channel — POST to Slack incoming webhook.
 */

import type { AlertChannel, AlertPayload } from '../types';

const SEVERITY_EMOJI: Record<string, string> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
};

export class SlackAlertChannel implements AlertChannel {
  readonly name = 'slack';
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(payload: AlertPayload): Promise<void> {
    const emoji = SEVERITY_EMOJI[payload.severity] || ':bell:';

    const body = {
      text: `${emoji} *${payload.title}*\n${payload.message}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *${payload.title}*\n${payload.message}`,
          },
        },
        ...(payload.metadata ? [{
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: Object.entries(payload.metadata)
              .map(([k, v]) => `*${k}:* ${v}`)
              .join(' | '),
          }],
        }] : []),
      ],
    };

    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`[Slack] ${res.status}: ${await res.text().catch(() => '')}`);
    }
  }
}
