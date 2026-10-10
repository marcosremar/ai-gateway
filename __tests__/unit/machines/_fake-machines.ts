import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MachineController } from '../../../src/machines/controller';
import { MachineStore } from '../../../src/machines/store';
import type { CreateMachineInput, MachineBackend, MachineLimits, MachineProvider, MachineRequest, ProviderMachine } from '../../../src/machines/types';

export class FakeMachineCloud implements MachineBackend {
  machines = new Map<string, ProviderMachine & { namespace: string; input?: CreateMachineInput }>();
  released: string[] = [];
  price: number | null = 0.4;
  failCreate: string | null = null;
  failList = false;
  hold: Promise<void> | null = null;
  private seq = 0;

  constructor(readonly provider: MachineProvider = 'vast', private readonly now: () => number = Date.now) {}

  async quote(request: MachineRequest): Promise<number | null> {
    return this.price != null && this.price <= request.maxUsdPerHour ? this.price : null;
  }

  async create(input: CreateMachineInput): Promise<ProviderMachine> {
    if (this.failCreate) throw new Error(this.failCreate);
    const m = this.add(input.namespace, input.machineId, this.now());
    m.input = input;
    if (this.hold) await this.hold;
    return { ...m };
  }

  add(namespace: string, machineId: string, createdAt: number) {
    const m = {
      providerId: `${this.provider}-${++this.seq}`, provider: this.provider, machineId, state: 'running' as const, ip: '203.0.113.7',
      ports: { '22/tcp': 40022 }, usdPerHour: this.price, createdAt, namespace,
    };
    this.machines.set(m.providerId, m);
    return m;
  }

  async list(namespace: string): Promise<ProviderMachine[]> {
    if (this.failList) throw new Error('list failed');
    return [...this.machines.values()].filter(m => m.namespace === namespace).map(({ namespace: _ns, input: _in, ...m }) => m);
  }

  async release(providerId: string): Promise<void> {
    this.released.push(providerId);
    this.machines.delete(providerId);
  }
}

export const LIMITS: MachineLimits = {
  maxHours: 24, maxLifetimeHours: 72, defaultIdleMinutes: 30, maxUsdPerHour: 2, maxRunning: 20,
  ownerUsdPerDay: 10, ownerUsdPerMonth: 150, holderUsdPerDay: 6, globalUsdPerDay: 20, createTimeoutMs: 15 * 60_000,
};

export const HOUR = 3_600_000;

export function clock(start = Date.UTC(2026, 9, 10, 8)) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => { c.t += ms; } };
  return c;
}

export function stateDir(): string {
  return mkdtempSync(join(tmpdir(), 'aigw-machines-'));
}

export function makeController(opts: {
  backends: Partial<Record<MachineProvider, MachineBackend>>; now: () => number; dir?: string; limits?: Partial<MachineLimits>; publicUrl?: string;
}) {
  return new MachineController({
    backends: opts.backends, store: opts.dir ? MachineStore.inDir(opts.dir) : new MachineStore(null), namespace: 'prod',
    limits: { ...LIMITS, ...opts.limits }, now: opts.now, ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
  });
}

export const request = (over: Partial<MachineRequest> = {}): MachineRequest => ({
  provider: 'vast', machineType: 'RTX 4090', maxUsdPerHour: 0.5, image: 'ghcr.io/me/app:1', diskGb: 40, ports: [], env: {}, ...over,
});

export const input = (over: Partial<MachineRequest> = {}, maxHours = 2, extra: { idleMinutes?: number; holder?: string | null } = {}) => ({
  request: request(over), maxHours, idleMinutes: extra.idleMinutes ?? 30, holder: extra.holder ?? null,
});
