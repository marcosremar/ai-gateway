import { loadSandboxEnv } from '../src/config/sandbox-env';
import { alertEmailFromEnv, createAlertMailer, secretValues } from '../src/telemetry/alert-email';
import { balanceThresholdsFromEnv, digestMail, readBalances } from '../src/telemetry/balance-watch';

const env: Record<string, string | undefined> = { ...process.env };
const loaded = await loadSandboxEnv(env);
if (!loaded.source) console.warn(`dev API not read: ${loaded.errors.join('; ') || 'no SANDBOX_TOKEN'}`);

const readings = await readBalances({ env, thresholds: balanceThresholdsFromEnv(env) });
for (const r of readings) {
  console.log(JSON.stringify({ provider: r.provider, level: r.level, balanceUsd: r.balanceUsd, burnPerHour: r.burnPerHour, currency: r.currency, hoursLeft: r.hoursLeft, keyExpiresAt: r.keyExpiresAt, reasons: r.reasons, error: r.error }));
}

const config = alertEmailFromEnv(env);
if (!config) {
  console.error('RESEND_API_KEY or ALERT_EMAIL_TO missing: no email sent');
  process.exit(1);
}
const mailer = createAlertMailer({ ...config, secrets: () => secretValues(env), log: (msg, data) => console.log(msg, JSON.stringify(data ?? {})) });
const digest = digestMail(readings, new Date().toISOString().slice(0, 10));
const id = await mailer.deliver({
  kind: 'test', level: 'warn', subject: 'teste de alerta',
  body: `Teste do alerta por email do ai-gateway. Se chegou, os avisos de saldo e de máquina vão chegar aqui.\n\n${digest.body}`,
});
console.log(id ? `sent to ${config.to.length} recipient(s), Resend id ${id}` : 'send failed');
process.exit(id ? 0 : 1);
