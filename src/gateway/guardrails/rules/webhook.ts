import type { WebhookRule, RuleContext, RuleResult } from '../types';

/**
 * Calls an external HTTP endpoint with the text + context.
 * The endpoint must respond with JSON: { pass: boolean; reason?: string }
 *
 * Failures (network error, timeout, non-2xx, bad JSON) default to pass=true
 * so a broken webhook never hard-blocks traffic.
 */
export async function runWebhook(rule: WebhookRule, ctx: RuleContext): Promise<RuleResult> {
  const timeoutMs = rule.timeoutMs ?? 3000;

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

    const json = await res.json() as { pass?: boolean; reason?: string };
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
