import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export interface HostRecord {
  host: number;
  location: string | null;
  bootsOk: number;
  bootsFailed: number;
  bootMs: number | null;
  rttMs: number | null;
  baselineMs: number | null;
  rttAt: number | null;
  udp: 'ok' | 'blocked' | null;
  udpAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  avoidUntil: number;
  lastUsedAt: number;
}

export interface HostStore {
  load(): Promise<HostRecord[]>;
  save(hosts: HostRecord[]): Promise<void>;
}

export class FileHostStore implements HostStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  static inDir(dir: string): FileHostStore { return new FileHostStore(join(dir, 'vast-hosts.json')); }
  async load(): Promise<HostRecord[]> {
    try {
      return (JSON.parse(await readFile(this.path, 'utf8')) as { hosts?: HostRecord[] }).hosts ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
  save(hosts: HostRecord[]): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, hosts }, null, 2);
    this.chain = this.chain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.chain;
  }
}

const blank = (host: number): HostRecord => ({
  host, location: null, bootsOk: 0, bootsFailed: 0, bootMs: null, rttMs: null, baselineMs: null, rttAt: null, udp: null, udpAt: null,
  lastError: null, lastErrorAt: null, avoidUntil: 0, lastUsedAt: 0,
});

export class HostReputation {
  private readonly hosts = new Map<number, HostRecord>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly opts: { store?: HostStore; max: number; now: () => number; log?: (msg: string, data?: Record<string, unknown>) => void },
  ) {}

  load(): Promise<void> {
    this.loading ??= (async () => {
      for (const h of await this.opts.store?.load() ?? []) if (!this.hosts.has(h.host)) this.hosts.set(h.host, { ...blank(h.host), ...h });
    })().catch((err) => this.opts.log?.('deployments: host reputation not loaded', { error: err instanceof Error ? err.message : String(err) }));
    return this.loading;
  }

  get(host: number | undefined): HostRecord | undefined {
    return host === undefined ? undefined : this.hosts.get(host);
  }

  list(): HostRecord[] {
    return [...this.hosts.values()].map(h => ({ ...h }));
  }

  note(host: number, patch: Partial<HostRecord>): void {
    const next = { ...(this.hosts.get(host) ?? blank(host)), ...patch, lastUsedAt: this.opts.now() };
    this.hosts.delete(host);
    this.hosts.set(host, next);
    for (const oldest of this.hosts.keys()) {
      if (this.hosts.size <= this.opts.max) break;
      this.hosts.delete(oldest);
    }
    void this.opts.store?.save(this.list()).catch((err) => this.opts.log?.('deployments: host reputation not saved', { error: err instanceof Error ? err.message : String(err) }));
  }
}
