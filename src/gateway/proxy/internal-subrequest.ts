/**
 * Sub-requests the gateway makes to itself (the `/v1/s2s` composite calls `/v1/audio/transcriptions`, `/v1/chat/
 * completions` and `/v1/audio/speech` over loopback with the caller's key). The turn already holds one of the caller's
 * concurrency slots: counting each stage again made 16 simultaneous turns hit the per-user limit (20) and answer 429
 * (measured 06/10/2026). The marker is a per-process secret, honoured only from a loopback address, so a client cannot
 * use it to skip the limit.
 */
import { randomUUID } from 'crypto';

export const SUBREQUEST_HEADER = 'x-gateway-subrequest';
export const SUBREQUEST_TOKEN = randomUUID();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const HEDGE_CAP_HEADER = 'x-gateway-hedge-ms';

export const BUDGET_CAP_HEADER = 'x-gateway-budget-ms';

type HeaderBag = Record<string, string | string[] | undefined>;

function capOf(headers: HeaderBag, name: string): number {
  const ms = Number(headers[name]);
  return headers[SUBREQUEST_HEADER] === SUBREQUEST_TOKEN && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export const hedgeCapOf = (headers: HeaderBag): number => capOf(headers, HEDGE_CAP_HEADER);
export const budgetCapOf = (headers: HeaderBag): number => capOf(headers, BUDGET_CAP_HEADER);

export function isInternalSubrequest(header: string | string[] | undefined, remoteAddress: string | undefined): boolean {
  return header === SUBREQUEST_TOKEN && LOOPBACK.has(remoteAddress ?? '');
}
