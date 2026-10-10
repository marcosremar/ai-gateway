import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { MachineError } from '../../../src/machines/spec';
import { clock, FakeMachineCloud, HOUR, input, makeController, stateDir } from './_fake-machines';

describe('machines controller', () => {
  it('creates a machine with an owner, persists it atomically (with .bak) and reports cost', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const dir = stateDir();
    const ctl = makeController({ backends: { vast }, now: c.now, dir });
    await ctl.init();
    const m = await ctl.create('palco', input({ sshPublicKey: undefined }, 2, { holder: 'agent-1' }));
    expect(m).toMatchObject({ owner: 'palco', holder: 'agent-1', provider: 'vast', status: 'running', usdPerHour: 0.4 });
    expect(vast.machines.get(m.providerId!)?.input).toMatchObject({ machineId: m.id, namespace: 'prod' });
    await ctl.extend(m.id, null);
    await ctl.stop();
    const saved = JSON.parse(readFileSync(join(dir, 'machines.json'), 'utf8'));
    expect(saved.machines[m.id].status).toBe('running');
    expect(existsSync(join(dir, 'machines.json.bak'))).toBe(true);
    c.advance(HOUR / 2);
    expect(ctl.costs('palco').machines[0].costUsd).toBeCloseTo(0.2, 4);
  });

  it('cheapest: tries providers by quote and falls back to the next on a failure', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const runpod = new FakeMachineCloud('runpod', c.now);
    vast.price = 0.3;
    runpod.price = 0.35;
    vast.failCreate = 'out_of_stock: taken';
    const ctl = makeController({ backends: { vast, runpod }, now: c.now });
    const m = await ctl.create('palco', input({ provider: 'cheapest' }));
    expect(m.provider).toBe('runpod');
    runpod.failCreate = 'out_of_stock: none';
    await expect(ctl.create('palco', input({ provider: 'cheapest' }))).rejects.toMatchObject({ status: 409 });
  });

  it('releases a machine at its deadline and refuses an extend past the lifetime', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now, limits: { maxLifetimeHours: 3 } });
    const m = await ctl.create('palco', input({}, 1, { idleMinutes: 600 }));
    await expect(ctl.extend(m.id, 3)).rejects.toMatchObject({ status: 400 });
    await ctl.extend(m.id, 1);
    c.advance(1.5 * HOUR);
    await ctl.reconcile();
    expect(ctl.get(m.id)!.status).toBe('running');
    c.advance(HOUR);
    await ctl.reconcile();
    expect(ctl.get(m.id)).toMatchObject({ status: 'released', endReason: 'deadline' });
    expect(vast.released).toEqual([m.providerId]);
  });

  it('releases an idle machine (no extend for idleMinutes) and keeps one that is renewed', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now });
    const idle = await ctl.create('palco', input({}, 4, { idleMinutes: 10 }));
    const busy = await ctl.create('palco', input({}, 4, { idleMinutes: 10 }));
    c.advance(6 * 60_000);
    await ctl.extend(busy.id, null);
    c.advance(6 * 60_000);
    await ctl.reconcile();
    expect(ctl.get(idle.id)).toMatchObject({ status: 'released', endReason: 'idle' });
    expect(ctl.get(busy.id)!.status).toBe('running');
  });

  it('refuses with 402 past the owner, holder, month and global caps, saying what to do', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now, limits: { ownerUsdPerDay: 2, holderUsdPerDay: 1, globalUsdPerDay: 3, ownerUsdPerMonth: 2.5 } });
    await ctl.create('palco', input({ maxUsdPerHour: 0.5 }, 1, { holder: 'a' }));
    const holder = await ctl.create('palco', input({ maxUsdPerHour: 0.5 }, 2, { holder: 'a' })).catch((e: unknown) => e);
    expect(holder).toBeInstanceOf(MachineError);
    expect(holder).toMatchObject({ status: 402 });
    expect((holder as Error).message).toMatch(/holder 'a'.*DELETE \/v1\/machines\/:id.*MACHINES_HOLDER_USD_PER_DAY/);
    const day = await ctl.create('palco', input({ maxUsdPerHour: 0.5 }, 4)).catch((e: unknown) => e);
    expect((day as Error).message).toMatch(/app 'palco' in 24 h.*MACHINES_OWNER_USD_PER_DAY/);
    const m = await ctl.create('palco', input({ maxUsdPerHour: 0.5 }, 2));
    await expect(ctl.extend(m.id, 3)).rejects.toMatchObject({ status: 402 });
    await expect(ctl.create('other', input({ maxUsdPerHour: 0.5 }, 4))).rejects.toThrow(/the gateway in 24 h.*MACHINES_USD_PER_DAY/);
  });

  it('releases orphans of its namespace after the grace and never a machine of another namespace', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now });
    const orphan = vast.add('prod', 'm-0123456789ab', c.now());
    const young = vast.add('prod', 'm-ba9876543210', c.now() + 9 * 60_000);
    const foreign = vast.add('dev-x', 'm-aaaaaaaaaaaa', c.now());
    c.advance(11 * 60_000);
    await ctl.reconcile();
    expect(vast.released).toEqual([orphan.providerId]);
    expect(vast.machines.has(young.providerId)).toBe(true);
    expect(vast.machines.has(foreign.providerId)).toBe(true);
  });

  it('gateway crash while a machine is coming up: the next process adopts it, or fails the record when none came up', async () => {
    const c = clock();
    const dir = stateDir();
    const vast = new FakeMachineCloud('vast', c.now);
    let unblock = () => {};
    vast.hold = new Promise<void>((r) => { unblock = r; });
    const crashed = makeController({ backends: { vast }, now: c.now, dir });
    await crashed.init();
    void crashed.create('palco', input()).catch(() => {});
    await new Promise(r => setTimeout(r, 20));
    const lost = makeController({ backends: { vast: new FakeMachineCloud('vast', c.now) }, now: c.now, dir });
    await lost.init();
    const pending = lost.list(null)[0];
    expect(pending.status).toBe('creating');

    const restarted = makeController({ backends: { vast }, now: c.now, dir });
    await restarted.init();
    await restarted.reconcile();
    expect(restarted.get(pending.id)).toMatchObject({ status: 'running', provider: 'vast' });
    c.advance(3 * HOUR);
    await restarted.reconcile();
    expect(restarted.get(pending.id)).toMatchObject({ status: 'released', endReason: 'deadline' });

    c.advance(16 * 60_000);
    await lost.reconcile();
    expect(lost.get(pending.id)).toMatchObject({ status: 'failed', lastError: 'create lost' });
    unblock();
  });

  it('marks a machine lost when the provider no longer lists it, without releasing anything', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now });
    const m = await ctl.create('palco', input());
    vast.machines.clear();
    c.advance(4 * 60_000);
    vast.failList = true;
    await ctl.reconcile();
    expect(ctl.get(m.id)!.status).toBe('running');
    vast.failList = false;
    await ctl.reconcile();
    expect(ctl.get(m.id)).toMatchObject({ status: 'released', endReason: 'lost' });
  });
});
