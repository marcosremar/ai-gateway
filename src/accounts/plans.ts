// ── AI Gateway — ucast.me accounts: plans ────────────────────────────────────
// Monthly limits per plan. They apply only once billing is configured (STRIPE_SECRET_KEY): before that every account
// keeps the config-wide quota, so switching payments on is what turns the free plan's limits on. The Stripe prices are
// found by `lookupKey` (scripts/stripe-setup.ts creates them), so no price id lives in configuration.

import type { Quota } from './config';

export type PlanId = 'free' | 'pro' | 'events';

export interface Plan {
  id: PlanId;
  /** Monthly price in euro cents; 0 for the free plan. */
  priceCents: number;
  lookupKey: string | null;
  quota: Pick<Quota, 'audioSeconds' | 'llmTokens' | 'ttsChars' | 'rooms'>;
}

const HOUR = 3600;

export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', priceCents: 0, lookupKey: null, quota: { audioSeconds: 2 * HOUR, llmTokens: 300_000, ttsChars: 25_000, rooms: 5 } },
  pro: { id: 'pro', priceCents: 1900, lookupKey: 'ucast_pro_monthly', quota: { audioSeconds: 20 * HOUR, llmTokens: 3_000_000, ttsChars: 250_000, rooms: 0 } },
  events: { id: 'events', priceCents: 5900, lookupKey: 'ucast_events_monthly', quota: { audioSeconds: 80 * HOUR, llmTokens: 12_000_000, ttsChars: 1_000_000, rooms: 0 } },
};

export const PAID_PLANS = [PLANS.pro, PLANS.events];

export const planOf = (id: string): Plan => PLANS[id as PlanId] ?? PLANS.free;

export const planByLookupKey = (key: string | null | undefined): Plan | null => PAID_PLANS.find(p => p.lookupKey === key) ?? null;

const ORDER: PlanId[] = ['free', 'pro', 'events'];

export const nextPlan = (id: string): PlanId | null => ORDER[ORDER.indexOf(planOf(id).id) + 1] ?? null;
