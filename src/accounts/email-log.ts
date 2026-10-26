import { readStateFile, writeStateFile } from '../deployments/state-file';
import type { EmailMessage, EmailSender } from './email';

export interface LoggedEmail {
  id: string;
  at: number;
  to: string;
  subject: string;
  text: string;
  ok: boolean;
  error?: string;
}

const HIDDEN = '[oculto]';
const SECRETS: Array<[RegExp, string]> = [
  [/(\/reset#token=)[A-Za-z0-9_-]+/g, `$1${HIDDEN}`],
  [/ucast_live_[A-Za-z0-9_-]+/g, `ucast_live_${HIDDEN}`],
];

export const withoutSecrets = (text: string): string => SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

export class EmailLog {
  private entries: LoggedEmail[] = [];
  private writing: Promise<void> = Promise.resolve();
  private serial = 0;

  constructor(
    private readonly path: string | undefined,
    private readonly now: () => number = Date.now,
    private readonly max = 200,
    private readonly log: (msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    const read = await readStateFile<{ emails?: LoggedEmail[] }>(this.path);
    this.entries = read.data?.emails ?? [];
  }

  list(limit = 50): LoggedEmail[] {
    return this.entries.slice(0, Math.max(1, Math.min(limit, this.max)));
  }

  wrap(sender: EmailSender): EmailSender {
    return {
      configured: sender.configured,
      send: async (message) => {
        try {
          await sender.send(message);
          this.record(message, true);
        } catch (err) {
          this.record(message, false, err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    };
  }

  private record(message: EmailMessage, ok: boolean, error?: string): void {
    const at = this.now();
    this.entries.unshift({ id: `${at}-${this.serial++}`, at, to: message.to, subject: message.subject, text: withoutSecrets(message.text), ok, ...(error ? { error } : {}) });
    this.entries.length = Math.min(this.entries.length, this.max);
    this.log('accounts: e-mail', { to: message.to, subject: message.subject, ok, ...(error ? { error } : {}) });
    this.persist();
  }

  private persist(): void {
    const path = this.path;
    if (!path) return;
    this.writing = this.writing.then(() => writeStateFile(path, JSON.stringify({ emails: this.entries }))).catch(() => {});
  }

  async flush(): Promise<void> {
    await this.writing;
  }
}
