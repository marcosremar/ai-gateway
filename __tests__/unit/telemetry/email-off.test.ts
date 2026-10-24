import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { alertEmailFromEnv } from '../../../src/telemetry/alert-email';

// Owner, 24/10/2026: «não enviar mais e-mail». Alerts keep the log and ALERT_WEBHOOK_URL; e-mail only with ALERT_EMAIL=1.
const RESEND_HOST = ['api', 'resend', 'com'].join('.');
const ROOT = join(__dirname, '../../..');
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
});

describe('alert e-mail is off by default', () => {
  const full = { RESEND_API_KEY: 're_test_key_123', ALERT_EMAIL_TO: 'a@x.com', MAIL_FROM: 'g <g@x.com>' };

  it('no mailer without ALERT_EMAIL=1, even with the Resend key and a recipient', () => {
    expect(alertEmailFromEnv(full)).toBeNull();
    expect(alertEmailFromEnv({ ...full, ALERT_EMAIL: '0' })).toBeNull();
    expect(alertEmailFromEnv({ ...full, ALERT_EMAIL: '1' })).not.toBeNull();
  });

  it('serve.ts builds its one alert mailer only from alertEmailFromEnv', () => {
    const serve = readFileSync(join(ROOT, 'serve.ts'), 'utf8');
    expect(serve.match(/createAlertMailer\(/g)).toHaveLength(1);
    expect(serve).toMatch(/const alertMailer = alertEmail && createAlertMailer\(/);
  });

  it('only the alert mailer and the account mailer call Resend', () => {
    const callers = [...filesUnder(join(ROOT, 'src')), join(ROOT, 'serve.ts')]
      .filter(f => readFileSync(f, 'utf8').split(RESEND_HOST).length > 1).map(f => f.slice(ROOT.length + 1)).sort();
    expect(callers).toEqual(['src/accounts/email.ts', 'src/telemetry/alert-email.ts']);
  });
});
