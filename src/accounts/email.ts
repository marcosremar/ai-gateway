// ── AI Gateway — ucast.me accounts: outgoing e-mail ─────────────────────────
// Resend (RESEND_API_KEY + EMAIL_FROM) when configured. Otherwise nothing is sent: the link is written to the log only
// with ACCOUNTS_LOG_EMAIL_LINKS=1 (local development — never in production, the log would hold reset links).

export interface EmailMessage { to: string; subject: string; text: string; html: string }

export interface EmailSender {
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<void>;
}

export function createEmailSender(opts: {
  resendApiKey: string; from: string; logLinks: boolean;
  fetchImpl?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}): EmailSender {
  const log = opts.log ?? (() => {});
  if (opts.resendApiKey && opts.from) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    return {
      configured: true,
      async send(msg) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: opts.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`resend answered ${res.status}`);
      },
    };
  }
  return {
    configured: false,
    async send(msg) {
      if (opts.logLinks) log('accounts: e-mail NOT sent (no sender) — dev log', { to: msg.to, subject: msg.subject, text: msg.text });
      else log('accounts: e-mail NOT sent — set RESEND_API_KEY and EMAIL_FROM', { subject: msg.subject });
    },
  };
}
