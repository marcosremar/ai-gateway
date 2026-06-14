import type { WebhookRule, RuleContext, RuleResult } from '../types';
import { validateEndpointUrlResolved } from '../../pipeline/ssrf-protection';

/**
 * Only http(s) webhooks are permitted. `file:`/`ftp:`/`gopher:`/`data:`
 * could be abused to read local files or pivot to internal services, none
 * of which a moderation webhook ever legitimately needs.
 */
const ALLOWED_WEBHOOK_PROTOCOLS = new Set(['http:', 'https:']);

/** Cap on the webhook response body we will parse, to avoid CPU/memory
 * amplification if a (potentially attacker-influenced) endpoint streams a
 * huge body back. A pass/fail verdict is tiny. */
const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

/**
 * Calls an external HTTP endpoint with the text + context.
 * The endpoint must respond with JSON: { pass: boolean; reason?: string }
 *
 * The target URL is validated against the SSRF blocklist (private/internal/
 * cloud-metadata addresses, non-http(s) schemes) *with DNS resolution* before
 * any request is made — an operator- or config-supplied webhook URL must not
 * be usable to reach `169.254.169.254`, `10.0.0.0/8`, `localhost`, etc. An
 * SSRF rejection fails CLOSED (blocks the request) because it indicates a
 * misconfigured/malicious rule, not a transient outage.
 *
 * Operational failures (network error, timeout, non-2xx, bad JSON) still
 * default to pass=true so a broken — but legitimate — webhook never hard-blocks
 * traffic.
 */
export async function runWebhook(rule: WebhookRule, ctx: RuleContext): Promise<RuleResult> {
  const timeoutMs = rule.timeoutMs ?? 3000;

  // ── SSRF guard ───────────────────────────────────────────────────────────
  // Scheme allowlist first (cheap, no DNS), then resolve-and-check the host.
  try {
    const parsed = new URL(rule.url);
    if (!ALLOWED_WEBHOOK_PROTOCOLS.has(parsed.protocol)) {
      return { pass: false, reason: `Webhook URL scheme "${parsed.protocol}" not allowed (http/https only)` };
    }
  } catch {
    return { pass: false, reason: `Invalid webhook URL: ${rule.url}` };
  }
  try {
    await validateEndpointUrlResolved(rule.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail CLOSED on SSRF — a webhook pointed at an internal address is never
    // a legitimate moderation endpoint.
    return { pass: false, reason: `Webhook URL blocked by SSRF policy: ${msg}` };
  }

  const payload = {
    text: ctx.text,
    model: ctx.model,
    hook: ctx.hook,
  };

  let controller: AbortController | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller!.abort(), timeoutMs);

    const res = await fetch(rule.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...rule.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (timeoutId) clearTimeout(timeoutId);

    if (!res.ok) {
      // Non-2xx — fail open (don't block)
      return { pass: true, reason: `Webhook returned ${res.status} — failing open` };
    }

    // Bound the body before parsing to avoid CPU/memory amplification on a
    // huge (or slow-loris) response. Reject oversized bodies as fail-open
    // rather than buffering megabytes for a one-line verdict.
    const declaredLen = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_WEBHOOK_RESPONSE_BYTES) {
      return { pass: true, reason: 'Webhook response too large — failing open' };
    }
    const raw = await res.text();
    if (raw.length > MAX_WEBHOOK_RESPONSE_BYTES) {
      return { pass: true, reason: 'Webhook response too large — failing open' };
    }
    const json = JSON.parse(raw) as { pass?: boolean; reason?: string };
    return {
      pass: json.pass !== false,
      reason: json.reason,
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    // Network/timeout errors → fail open
    return { pass: true, reason: `Webhook error (failing open): ${msg}` };
  }
}
