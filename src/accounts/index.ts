// ── AI Gateway — ucast.me accounts ───────────────────────────────────────────
// People sign up on ucast.me (e-mail + password) and create activation keys for the desktop app. An activation key is
// a gateway key of the accounts app (ACCOUNTS_APP, default `babelcast`): it reaches exactly what that app's keys reach
// (its model aliases, its daily budget, rooms, telemetry) and never anything admin. On top, every request it makes is
// metered per user and per key, and admitted against the user's quota. Contract: docs/accounts.md.
//
// `createAccounts(opts)` gives what serve.ts wires:
//   - `init()` / `stop()`   load and flush the state (accounts.json, account-usage.json on the volume);
//   - `resolveAppKey`       the extra entry of the gateway key registry;
//   - `mount(server)`       the account API, the pages and the quota gate, in front of the proxy's listeners;
//   - `recordInference`     the proxy's `onInference` hook (usage of each STT/LLM/TTS request);
//   - `streamMeter`         admission and metering of a streaming STT session (a WebSocket, not a request).

import { dirname, join } from 'path';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { accountsConfigFromEnv, type AccountsConfig } from './config';
import { createEmailSender, type EmailSender } from './email';
import { EmailLog } from './email-log';
import { createAccountsHttp } from './http';
import { BillingService, billingConfigFromEnv } from './billing';
import { AttemptLimiter } from './rate-limit';
import { AccountService } from './service';
import { UsageMeter } from './usage';

export { accountsConfigFromEnv, ACCOUNTS_DEFAULTS } from './config';
export type { AccountsConfig, Quota, QuotaMetric } from './config';
export { AccountError, AccountService, KEY_PREFIX, normalizeEmail } from './service';
export { UsageMeter, wavSeconds, audioSecondsOf, llmTokensOf } from './usage';
export { AttemptLimiter, ATTEMPT_LIMITS } from './rate-limit';
export { hashPassword, verifyPassword } from './password';
export { isCrossSite } from './http';
export { EmailLog, withoutSecrets, type LoggedEmail } from './email-log';

export interface CreateAccountsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides on top of the env config (tests). */
  config?: Partial<AccountsConfig>;
  email?: EmailSender;
  /** Gateway admin check: the accounts app must never be an admin (activation keys are then refused). */
  isAdmin?: (userId: string) => boolean;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Requests a realtime session is worth against the account's daily budget (the app budget's charge). */
  sessionRequests?: () => number;
  /** Stripe's HTTP client (tests). */
  stripeFetch?: typeof fetch;
}

export function createAccounts(opts: CreateAccountsOptions = {}) {
  const config: AccountsConfig = { ...accountsConfigFromEnv(opts.env ?? process.env), ...opts.config };
  const now = opts.now ?? Date.now;
  const emailLog = new EmailLog(config.statePath ? join(dirname(config.statePath), 'account-emails.json') : undefined, now, 200, opts.log);
  const email = emailLog.wrap(opts.email ?? createEmailSender({ ...config.email, log: opts.log }));
  const usage = new UsageMeter({ path: config.usagePath, retentionDays: config.usageRetentionDays, now, log: opts.log });
  const billingConfig = billingConfigFromEnv(opts.env ?? process.env, config.publicBaseUrl);
  const service = new AccountService({ config, usage, email, isAdmin: opts.isAdmin, planLimits: Boolean(billingConfig), now, log: opts.log });
  const billing = billingConfig ? new BillingService(billingConfig, service, opts.stripeFetch, now) : null;
  const limiter = new AttemptLimiter(now);
  const http = createAccountsHttp({ service, usage, limiter, emailLog, log: opts.log, sessionRequests: opts.sessionRequests, billing });

  /** Puts the account routes and the quota gate in front of the proxy's listeners (call after the rooms' mount). */
  function mount(server: Server): void {
    const listeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      let handled = false;
      try { handled = http.handle(req, res); } catch (err) {
        opts.log?.('accounts: routing failed', { error: err instanceof Error ? err.message : String(err) });
      }
      if (handled) return;
      for (const l of listeners) l.call(server, req, res);
    });
  }

  return {
    config,
    service,
    usage,
    limiter,
    emailLog,
    emailConfigured: email.configured,
    billingConfigured: Boolean(billing),
    async init(): Promise<void> {
      await service.load();
      await usage.load();
      await emailLog.load();
      service.start();
    },
    resolveAppKey: (token: string) => service.resolveAppKey(token),
    get activeKeyCount(): number { return service.activeKeyCount; },
    mount,
    handle: http.handle,
    recordInference: http.recordInference,
    /** Metering of a streaming STT session of an activation key (`GET /v1/audio/transcriptions/stream`). */
    streamMeter: http.streamMeter,
    async stop(): Promise<void> {
      await service.stop();
      await usage.flush();
      await emailLog.flush();
    },
  };
}
