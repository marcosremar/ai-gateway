import type { IncomingMessage, ServerResponse } from 'http';
import { AdminRouteError, readJsonBody, sendJson } from '../config/admin-gate';
import type { CustomRoute } from '../gateway/proxy/types';
import { CallsError, type Caller, type CallsService } from './service';

const errorBody = (type: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { type, message, ...extra } });

export function createCallsRoutes(service: CallsService, callerOf: (req: IncomingMessage) => Caller | null): CustomRoute[] {
  const route = (method: string, path: string, run: (caller: Caller, body: Record<string, unknown>) => Promise<[number, unknown]>): CustomRoute => ({
    method, path,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const caller = callerOf(req);
      if (!caller) return sendJson(res, 401, errorBody('unauthorized', 'calls need a gateway API key'));
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const [status, out] = await run(caller, body);
        sendJson(res, status, out);
      } catch (err) {
        if (err instanceof CallsError) {
          if (err.status === 503) res.setHeader('Retry-After', String(Math.ceil(Number(err.extra.retryAfterMs ?? 5000) / 1000)));
          return sendJson(res, err.status, errorBody(err.type, err.message, err.extra));
        }
        if (err instanceof AdminRouteError) return sendJson(res, err.status, errorBody('invalid_request', err.message));
        sendJson(res, 500, errorBody('internal_error', (err as Error).message));
      }
    },
  });
  const ownApp = (body: Record<string, unknown>) => {
    if (body.app !== undefined && body.app !== service.app) throw new CallsError(404, 'not_found', `no calls configured for app '${String(body.app)}'`);
  };
  return [
    route('GET', '/v1/calls/health', async () => [200, await service.health()]),
    route('POST', '/v1/calls/wake', async (caller, body) => { ownApp(body); return [202, await service.wake(caller)]; }),
    route('POST', '/v1/calls/park', async (caller, body) => { ownApp(body); return [202, await service.park(caller)]; }),
    route('POST', '/v1/calls/token', async (caller, body) => [200, await service.token(caller, body)]),
  ];
}
