import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';

export interface KeyAuditEntry {
  at: string;
  actor: string;
  action: string;
  names: string[];
  ok: boolean;
  detail?: string;
}

const KEEP = 500;

export class KeyAudit {
  private entries: KeyAuditEntry[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: { path?: string; now?: () => number; log?: (msg: string, data?: Record<string, unknown>) => void } = {}) {}

  async init(): Promise<void> {
    if (!this.opts.path) return;
    const text = await readFile(this.opts.path, 'utf8').catch(() => '');
    this.entries = text.split('\n').filter(Boolean).slice(-KEEP).flatMap((line) => {
      try { return [JSON.parse(line) as KeyAuditEntry]; } catch { return []; }
    });
  }

  record(entry: Omit<KeyAuditEntry, 'at'>): KeyAuditEntry {
    const full: KeyAuditEntry = { at: new Date((this.opts.now ?? Date.now)()).toISOString(), ...entry };
    this.entries.push(full);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    this.opts.log?.('key audit', { ...full });
    const path = this.opts.path;
    if (path) {
      this.chain = this.chain
        .then(() => mkdir(dirname(path), { recursive: true }))
        .then(() => appendFile(path, `${JSON.stringify(full)}\n`, { mode: 0o600 }))
        .catch((err: unknown) => this.opts.log?.('key audit write failed', { error: err instanceof Error ? err.message : String(err) }));
    }
    return full;
  }

  recent(limit = 100): KeyAuditEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(limit, KEEP))).reverse();
  }

  flush(): Promise<void> { return this.chain; }
}
