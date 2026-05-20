/**
 * Discord alert channel — POST to Discord webhook.
 */

import type { AlertChannel, AlertPayload } from '../types';

const SEVERITY_COLOR: Record<string, number> = {
  info: 0x3498db,     // blue
  warning: 0xf39c12,  // orange
  critical: 0xe74c3c, // red
};

export class DiscordAlertChannel implements AlertChannel {
  readonly name = 'discord';
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(payload: AlertPayload): Promise<void> {
    const color = SEVERITY_COLOR[payload.severity] || 0x95a5a6;

    const body = {
      embeds: [{
        title: payload.title,
        description: payload.message,
        color,
        timestamp: payload.timestamp.toISOString(),
        ...(payload.metadata && {
          fields: Object.entries(payload.metadata).map(([name, value]) => ({
            name,
            value: String(value),
            inline: true,
          })),
        }),
      }],
    };

    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`[Discord] ${res.status}: ${await res.text().catch(() => '')}`);
    }
  }
}
