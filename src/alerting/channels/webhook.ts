/**
 * Generic webhook alert channel — POST JSON to any URL.
 */

import type { AlertChannel, AlertPayload } from '../types';
import { isPrivateUrl } from '../../gateway/pipeline/ssrf-protection';

export class GenericWebhookAlertChannel implements AlertChannel {
  readonly name: string;
  private readonly url: string;
  private readonly headers?: Record<string, string>;

  constructor(url: string, opts?: { name?: string; headers?: Record<string, string> }) {
    // SSRF guard: webhook URL is admin-configurable; reject private/metadata
    // hosts so a malicious config can't exfil cloud metadata or probe
    // internal services.
    if (isPrivateUrl(url)) {
      throw new Error(`[Webhook] URL points to private/internal address: ${url}`);
    }
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
      // Without a timeout a hung edge would freeze the AlertRouter and the
      // cost-watcher / alerting subsystem behind it.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`[Webhook:${this.name}] ${res.status}: ${await res.text().catch(() => '')}`);
    }
  }
}
