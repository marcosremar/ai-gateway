/**
 * Generic webhook alert channel — POST JSON to any URL.
 */

import type { AlertChannel, AlertPayload } from '../types';

export class GenericWebhookAlertChannel implements AlertChannel {
  readonly name: string;
  private readonly url: string;
  private readonly headers?: Record<string, string>;

  constructor(url: string, opts?: { name?: string; headers?: Record<string, string> }) {
    this.url = url;
    this.name = opts?.name || 'webhook';
    this.headers = opts?.headers;
  }

  async send(payload: AlertPayload): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        severity: payload.severity,
        title: payload.title,
        message: payload.message,
        metadata: payload.metadata,
        timestamp: payload.timestamp.toISOString(),
      }),
    });

    if (!res.ok) {
      throw new Error(`[Webhook:${this.name}] ${res.status}: ${await res.text().catch(() => '')}`);
    }
  }
}
