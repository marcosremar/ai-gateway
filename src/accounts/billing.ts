// ── AI Gateway — ucast.me accounts: Stripe billing ───────────────────────────
// Stripe Checkout for subscriptions, the Customer Portal for changes, and the subscription as the source of truth:
// after Checkout the page calls `sync`, and the signed webhook (customer.subscription.*, checkout.session.completed)
// keeps renewals and cancellations in step. Plain REST over fetch, form-encoded like Stripe expects.

import { createHmac, timingSafeEqual } from 'crypto';
import { AccountError, type AccountService, type User } from './service';
import { PAID_PLANS, PLANS, planByLookupKey, type PlanId } from './plans';

const API = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE_S = 300;
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export interface BillingConfig { secretKey: string; webhookSecret: string; publicBaseUrl: string }

export function billingConfigFromEnv(env: NodeJS.ProcessEnv, publicBaseUrl: string): BillingConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  return secretKey ? { secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? '', publicBaseUrl } : null;
}

type Params = Record<string, string | number | boolean | undefined>;

export function formEncode(params: Params): string {
  return Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

/** Stripe-Signature: `t=<unix>,v1=<hex hmac of "t.body">`; any v1 may match (secret rotation). */
export function verifyStripeSignature(raw: string, header: string | undefined, secret: string, nowS: number): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map(p => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const given = Buffer.from(v ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface StripeSubscription {
  status: string; customer: string; current_period_end?: number; cancel_at_period_end?: boolean;
  items: { data: Array<{ price: { lookup_key: string | null }; current_period_end?: number }> };
}

export class BillingService {
  private priceIds: Map<PlanId, string> | null = null;

  constructor(
    private readonly cfg: BillingConfig,
    private readonly accounts: AccountService,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    const query = formEncode(params);
    const res = await this.fetchImpl(`${API}${path}${method === 'GET' && query ? `?${query}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.secretKey}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: method === 'POST' ? query : undefined,
    });
    const body = await res.json().catch(() => ({})) as T & { error?: { message?: string } };
    if (!res.ok) throw new AccountError(502, 'O sistema de pagamento não respondeu. Tente de novo em instantes.', 'billing_unavailable', { stripe: body.error?.message ?? res.status });
    return body;
  }

  private async priceIdOf(plan: PlanId): Promise<string> {
    if (!this.priceIds) {
      const keys = PAID_PLANS.map(p => p.lookupKey!);
      const params: Params = { active: true };
      keys.forEach((k, i) => { params[`lookup_keys[${i}]`] = k; });
      const list = await this.call<{ data: Array<{ id: string; lookup_key: string }> }>('GET', '/prices', params);
      this.priceIds = new Map(list.data.flatMap(p => { const found = planByLookupKey(p.lookup_key); return found ? [[found.id, p.id] as [PlanId, string]] : []; }));
    }
    const id = this.priceIds.get(plan);
    if (!id) throw new AccountError(503, 'Este plano ainda não está à venda.', 'plan_unavailable');
    return id;
  }

  private async customerOf(user: User): Promise<string> {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const customer = await this.call<{ id: string }>('POST', '/customers', { email: user.email, 'metadata[userId]': user.id });
    await this.accounts.setBilling(user, { stripeCustomerId: customer.id });
    return customer.id;
  }

  async checkout(user: User, plan: unknown): Promise<string> {
    if (plan !== 'pro' && plan !== 'events') throw new AccountError(400, 'Escolha um plano.', 'invalid_plan');
    const price = await this.priceIdOf(plan);
    const base = this.cfg.publicBaseUrl;
    const session = await this.call<{ url: string }>('POST', '/checkout/sessions', {
      mode: 'subscription', customer: await this.customerOf(user), client_reference_id: user.id,
      'line_items[0][price]': price, 'line_items[0][quantity]': 1, allow_promotion_codes: true,
      'subscription_data[metadata][userId]': user.id,
      success_url: `${base}/account?billing=success`, cancel_url: `${base}/account?billing=cancel`,
    });
    return session.url;
  }

  async portal(user: User): Promise<string> {
    if (!user.stripeCustomerId) throw new AccountError(400, 'Você ainda não tem uma assinatura.', 'no_subscription');
    const session = await this.call<{ url: string }>('POST', '/billing_portal/sessions', { customer: user.stripeCustomerId, return_url: `${this.cfg.publicBaseUrl}/account` });
    return session.url;
  }

  /** Reads the customer's subscriptions and sets the plan from the live one (none → free). */
  async sync(user: User): Promise<void> {
    if (!user.stripeCustomerId) return;
    const subs = await this.call<{ data: StripeSubscription[] }>('GET', '/subscriptions', { customer: user.stripeCustomerId, status: 'all', limit: 10 });
    const live = subs.data.find(s => LIVE_STATUSES.has(s.status) && planByLookupKey(s.items.data[0]?.price.lookup_key));
    const item = live?.items.data[0];
    const periodEnd = live?.current_period_end ?? item?.current_period_end;
    await this.accounts.setBilling(user, {
      plan: live ? planByLookupKey(item?.price.lookup_key)!.id : PLANS.free.id,
      planRenewsAt: periodEnd ? periodEnd * 1000 : undefined,
      planCancelsAtPeriodEnd: live?.cancel_at_period_end || undefined,
    });
  }

  async webhook(raw: string, signature: string | undefined): Promise<void> {
    if (!verifyStripeSignature(raw, signature, this.cfg.webhookSecret, Math.floor(this.now() / 1000))) {
      throw new AccountError(400, 'Assinatura do webhook inválida.', 'bad_signature');
    }
    const event = JSON.parse(raw) as { type?: string; data?: { object?: { customer?: string } } };
    const customer = event.data?.object?.customer;
    if (!customer || !/^(customer\.subscription\.|checkout\.session\.completed$)/.test(event.type ?? '')) return;
    const user = this.accounts.userByStripeCustomer(customer);
    if (user) await this.sync(user);
  }

  async forget(user: User): Promise<void> {
    if (user.stripeCustomerId) await this.call('DELETE', `/customers/${encodeURIComponent(user.stripeCustomerId)}`).catch(() => {});
  }
}
