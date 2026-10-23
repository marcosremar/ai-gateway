// Creates the ucast.me plans in a Stripe account (test or live, by the key), idempotently:
//   bun scripts/stripe-setup.ts <key file> <webhook url> <webhook secret out file>
// Products + monthly EUR prices found by lookup key (src/accounts/plans.ts), the webhook endpoint (its signing secret
// is written to the out file, chmod 600, never printed) and the Customer Portal configuration.

import { readFileSync, writeFileSync } from 'fs';
import { formEncode } from '../src/accounts/billing';
import { PAID_PLANS } from '../src/accounts/plans';

const [keyFile, webhookUrl, secretOut] = process.argv.slice(2);
if (!keyFile || !webhookUrl || !secretOut) {
  console.error('usage: bun scripts/stripe-setup.ts <key file> <webhook url> <webhook secret out file>');
  process.exit(2);
}
const key = readFileSync(keyFile, 'utf8').trim();
const NAMES: Record<string, string> = { pro: 'ucast.me Pro', events: 'ucast.me Eventos' };
const TAX_CODE = 'txcd_10105003';
const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

async function stripe<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const query = formEncode(params);
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && query ? `?${query}` : ''}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? query : undefined,
  });
  const body = await res.json() as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path}: ${body.error?.message ?? res.status}`);
  return body;
}

const mode = key.startsWith('sk_live_') ? 'LIVE' : 'test';
console.log(`Stripe ${mode} mode`);

const products: Record<string, { product: string; price: string }> = {};
for (const plan of PAID_PLANS) {
  const found = await stripe<{ data: Array<{ id: string; unit_amount: number; product: string }> }>('GET', '/prices', { 'lookup_keys[0]': plan.lookupKey!, active: true });
  const current = found.data[0];
  if (current && current.unit_amount === plan.priceCents) {
    products[plan.id] = { product: current.product, price: current.id };
    console.log(`${plan.id}: price ${current.id} already at ${plan.priceCents / 100} EUR/month`);
    continue;
  }
  const product = current?.product ?? (await stripe<{ id: string }>('POST', '/products', { name: NAMES[plan.id]!, tax_code: TAX_CODE, 'metadata[plan]': plan.id })).id;
  const price = await stripe<{ id: string }>('POST', '/prices', {
    product, currency: 'eur', unit_amount: plan.priceCents, 'recurring[interval]': 'month',
    lookup_key: plan.lookupKey!, transfer_lookup_key: true, tax_behavior: 'inclusive',
  });
  products[plan.id] = { product, price: price.id };
  console.log(`${plan.id}: created price ${price.id} at ${plan.priceCents / 100} EUR/month`);
}

const hooks = await stripe<{ data: Array<{ id: string; url: string }> }>('GET', '/webhook_endpoints', { limit: 100 });
if (hooks.data.some(h => h.url === webhookUrl)) {
  console.log(`webhook already points to ${webhookUrl} (its secret is in the Stripe dashboard)`);
} else {
  const params: Record<string, string> = { url: webhookUrl, description: 'ucast.me accounts' };
  EVENTS.forEach((e, i) => { params[`enabled_events[${i}]`] = e; });
  const hook = await stripe<{ id: string; secret: string }>('POST', '/webhook_endpoints', params);
  writeFileSync(secretOut, hook.secret, { mode: 0o600 });
  console.log(`webhook ${hook.id} created; signing secret written to ${secretOut}`);
}

const portal: Record<string, string | boolean> = {
  'business_profile[headline]': 'ucast.me — sua assinatura',
  'features[invoice_history][enabled]': true,
  'features[payment_method_update][enabled]': true,
  'features[subscription_cancel][enabled]': true,
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_update][enabled]': true,
  'features[subscription_update][default_allowed_updates][0]': 'price',
  'features[subscription_update][proration_behavior]': 'create_prorations',
};
Object.values(products).forEach((p, i) => {
  portal[`features[subscription_update][products][${i}][product]`] = p.product;
  portal[`features[subscription_update][products][${i}][prices][0]`] = p.price;
});
const configs = await stripe<{ data: Array<{ id: string; is_default: boolean }> }>('GET', '/billing_portal/configurations', { limit: 10 });
const existing = configs.data.find(c => c.is_default);
await stripe('POST', existing ? `/billing_portal/configurations/${existing.id}` : '/billing_portal/configurations', portal);
console.log('customer portal configured');
