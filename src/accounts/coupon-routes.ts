import type { CustomRoute } from '../gateway/proxy/types';
import { readJsonBody, type AdminGate } from '../config/admin-gate';
import type { EmailLog } from './email-log';
import type { AccountService } from './service';

const mailLang = (raw: unknown) => (raw === 'en' || raw === 'fr' ? raw : 'pt');

export function createCouponRoutes(opts: { service: AccountService; gate: AdminGate; emailLog?: EmailLog }): CustomRoute[] {
  const { service, gate, emailLog } = opts;
  return [
    {
      method: 'GET', path: '/v1/admin/emails',
      handler: (req, res) => gate.run(req, res, 'emails.list', async () => ({
        status: 200, body: { emails: emailLog?.list(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? 50) || 50) ?? [] },
      })),
    },
    {
      method: 'GET', path: '/v1/admin/coupons',
      handler: (req, res) => gate.run(req, res, 'coupons.list', async () => ({ status: 200, body: { coupons: service.listCoupons() } })),
    },
    {
      method: 'POST', path: '/v1/admin/coupons',
      handler: (req, res) => gate.run(req, res, 'coupons.create', async (_actor, note) => {
        const body = await readJsonBody(req);
        const { coupons, skipped } = await service.issueCoupons(body, body.emails, mailLang(body.lang));
        note.names = [`${coupons.length} coupon(s)`];
        return { status: 201, body: { coupons, skipped } };
      }),
    },
  ];
}
