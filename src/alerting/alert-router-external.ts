/**
 * External Alerting System.
 *
 * Fixes Gap: Alerting only in code — no external Slack/PagerDuty/Discord integration.
 *
 * Sends alerts to external services when error thresholds are exceeded.
 * Supports Slack, Discord, PagerDuty, and generic webhooks.
 *
 * Usage:
 * ```typescript
 * import { createAlertRouter } from './alert-router';
 *
 * const router = createAlertRouter({
 *   slack: { webhookUrl: process.env.SLACK_WEBHOOK_URL },
 *   discord: { webhookUrl: process.env.DISCORD_WEBHOOK_URL },
 *   pagerduty: { integrationKey: process.env.PAGERDUTY_KEY },
 * });
 *
 * // When an error occurs:
 * router.routeAlert({
 *   severity: 'critical',
 *   title: 'GPU deployment failed',
 *   message: 'Instance creation failed after 3 retries',
 *   metadata: { deployId: 'xyz', provider: 'vast' },
 * });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('alert-router');

export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AlertPayload {
  /** Alert severity level */
  severity: AlertSeverity;
  /** Alert title/summary */
  title: string;
  /** Detailed message */
  message: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Deduplication key (same key = same incident) */
  dedupKey?: string;
}

export interface SlackConfig {
  /** Slack incoming webhook URL */
  webhookUrl: string;
  /** Channel to post to (overrides default) */
  channel?: string;
  /** Username to post as */
  username?: string;
}

export interface DiscordConfig {
  /** Discord webhook URL */
  webhookUrl: string;
}

export interface PagerDutyConfig {
  /** PagerDuty integration key */
  integrationKey: string;
  /** Service name */
  service?: string;
}

export interface AlertRouterConfig {
  slack?: SlackConfig;
  discord?: DiscordConfig;
  pagerduty?: PagerDutyConfig;
  /** Only send alerts at or above this severity (default: 'warning') */
  minSeverity?: AlertSeverity;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

/**
 * Create an alert router that sends to configured external services.
 */
export function createAlertRouter(config: AlertRouterConfig) {
  const minSeverity = config.minSeverity ?? 'warning';

  /**
   * Route an alert to configured services.
   */
  async function routeAlert(alert: AlertPayload): Promise<void> {
    // Check minimum severity
    if (SEVERITY_ORDER[alert.severity] < SEVERITY_ORDER[minSeverity]) {
      return;
    }

    log.log({ severity: alert.severity, title: alert.title }, 'Routing alert');

    const promises: Promise<void>[] = [];

    // Slack
    if (config.slack?.webhookUrl) {
      promises.push(sendSlackAlert(config.slack, alert));
    }

    // Discord
    if (config.discord?.webhookUrl) {
      promises.push(sendDiscordAlert(config.discord, alert));
    }

    // PagerDuty
    if (config.pagerduty?.integrationKey) {
      promises.push(sendPagerDutyAlert(config.pagerduty, alert));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send alert to Slack.
   */
  async function sendSlackAlert(slack: SlackConfig, alert: AlertPayload): Promise<void> {
    try {
      const color = getSeverityColor(alert.severity);
      const body = {
        channel: slack.channel,
        username: slack.username || 'AI Gateway Alerts',
        attachments: [
          {
            color,
            title: alert.title,
            text: alert.message,
            fields: alert.metadata
              ? Object.entries(alert.metadata).map(([key, value]) => ({
                  title: key,
                  value: String(value),
                  short: true,
                }))
              : [],
            footer: 'AI Gateway',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      };

      const res = await fetch(slack.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Surface 4xx/5xx — without this, mis-typed webhook URL or revoked
        // token silently logged "alert sent" and operators believed alerts
        // were flowing during incidents.
        const txt = await res.text().catch(() => '');
        throw new Error(`Slack webhook returned ${res.status}: ${txt.slice(0, 200)}`);
      }
      log.log({ channel: slack.channel }, 'Slack alert sent');
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to send Slack alert');
    }
  }

  /**
   * Send alert to Discord.
   */
  async function sendDiscordAlert(discord: DiscordConfig, alert: AlertPayload): Promise<void> {
    try {
      const color = getSeverityColorInt(alert.severity);
      const body = {
        username: 'AI Gateway Alerts',
        embeds: [
          {
            title: alert.title,
            description: alert.message,
            color,
            fields: alert.metadata
              ? Object.entries(alert.metadata).map(([key, value]) => ({
                  name: key,
                  value: String(value),
                  inline: true,
                }))
              : [],
            footer: { text: 'AI Gateway' },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      const res = await fetch(discord.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Discord webhook returned ${res.status}: ${txt.slice(0, 200)}`);
      }
      log.log({}, 'Discord alert sent');
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to send Discord alert');
    }
  }

  /**
   * Send alert to PagerDuty.
   */
  async function sendPagerDutyAlert(pagerduty: PagerDutyConfig, alert: AlertPayload): Promise<void> {
    try {
      const eventType = alert.severity === 'critical' || alert.severity === 'error' ? 'trigger' : 'info';
      const body = {
        routing_key: pagerduty.integrationKey,
        event_action: eventType,
        dedup_key: alert.dedupKey,
        payload: {
          summary: `${alert.severity.toUpperCase()}: ${alert.title}`,
          source: 'ai-gateway',
          severity: alert.severity,
          timestamp: new Date().toISOString(),
          component: pagerduty.service || 'ai-gateway',
          custom_details: alert.metadata || {},
        },
      };

      const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`PagerDuty returned ${res.status}: ${txt.slice(0, 200)}`);
      }
      log.log({}, 'PagerDuty alert sent');
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to send PagerDuty alert');
    }
  }

  return {
    routeAlert,
  };
}

/**
 * Get severity color for Slack (hex color string).
 */
function getSeverityColor(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical': return '#FF0000';
    case 'error': return '#FF6600';
    case 'warning': return '#FFCC00';
    default: return '#36A64F';
  }
}

/**
 * Get severity color for Discord (integer).
 */
function getSeverityColorInt(severity: AlertSeverity): number {
  switch (severity) {
    case 'critical': return 0xFF0000;
    case 'error': return 0xFF6600;
    case 'warning': return 0xFFCC00;
    default: return 0x36A64F;
  }
}
