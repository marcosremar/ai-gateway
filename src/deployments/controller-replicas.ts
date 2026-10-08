/**
 * DeploymentController, part 2 of 7 — replica lifecycle: create (placement ladder, € ceiling, back-off), release (and
 * the release of a create that outlived its deployment), probe (readiness + the RTT gate), and an exposed deployment's
 * reserved network. See controller-state.ts for the layout of the parts.
 */

import { replicaCloudInit } from './cloud-init';
import { ControllerState, type Runtime } from './controller-state';
import { packFiles } from './file-pack';
import { placeReplica, PlacementError } from './placement-walk';
import { isOutOfStock } from './placements';
import { DEFAULT_MAX_RTT_MS, gateDecision } from './rtt-gate';
import type { DeploymentBackend, DeploymentRecord, DeploymentSpec, ProbeResult, ReplicaMachine } from './types';

const CREATE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
const NETWORK_RELEASE_RETRY_MS = 15_000;
const ORPHAN_RELEASE_ATTEMPTS = 6;
const SPEND_RETRY_MS = 30_000;

export abstract class ReplicaLifecycle extends ControllerState {
  protected async probeOne(m: ReplicaMachine): Promise<void> {
    const rt = this.deployments.get(m.deployment);
    if (!rt || !m.ip) return;
    if (!(await this.rttGate(rt, m))) return; // still measuring, or released as too far
    const p = this.probes.get(m.id) ?? { everReady: false, readyNow: false, failures: 0 };
    const result = await this.checkReplica(rt, m);
    if (result === 'down') p.downSince ??= this.now(); else delete p.downSince;
    if (result === 'ready') {
      // Replica lifecycle for telemetry (serve.ts maps these log lines to `replica.ready` / `replica.unhealthy`).
      if (!p.readyNow) this.log('deployments: replica ready', { deployment: m.deployment, id: m.id, bootMs: p.everReady ? null : this.now() - m.createdAt });
      p.readyAt ??= this.now(); p.everReady = true; p.readyNow = true; p.failures = 0; p.busy = false; rt.starting.delete(m.id);
    } else if (result === 'busy' && p.everReady && ((rt.perReplica.get(m.id) ?? 0) > 0 || this.servedRecently(p))) {
      // Alive (its front answers) and working: the health check queued behind the work. Keep it serving what it can.
      p.busy = true;
    } else {
      if (p.readyNow) this.log('deployments: replica unhealthy', { deployment: m.deployment, id: m.id, probe: result });
      p.readyNow = false;
      if (p.everReady) p.failures++;
    }
    this.probes.set(m.id, p);
  }

  /** `ProbeResult` of one replica; a probe without `check` answers ready/down, and a throwing probe is `down`. */
  private async checkReplica(rt: Runtime, m: ReplicaMachine): Promise<ProbeResult> {
    const { probe } = this.opts;
    try {
      if (probe.check) return await probe.check(m, rt.record.spec, rt.record.replicaToken);
      return (await probe.ready(m, rt.record.spec, rt.record.replicaToken)) ? 'ready' : 'down';
    } catch {
      return 'down';
    }
  }

  /**
   * RTT gate (`rtt-gate.ts`): true once the replica may serve. A fresh replica on a backend that measures RTT (Vast)
   * is kept only if the median from the gateway is within `maxRttMs`; otherwise it is released as `too-far` (the
   * backend avoids the host) and the next create picks another offer. Passed once = never measured again.
   */
  protected async rttGate(rt: Runtime, m: ReplicaMachine): Promise<boolean> {
    const backend = this.backends[this.providerOf(m)];
    if (!backend?.measureRtt) return true;
    const now = this.now();
    const gate = this.gates.get(m.id) ?? { status: 'pending', firstSeenAt: now, rttMs: null };
    this.gates.set(m.id, gate);
    if (gate.status !== 'pending') return true;
    let rtt: number | null = null;
    try { rtt = await backend.measureRtt(m); } catch { rtt = null; }
    if (rtt != null) gate.rttMs = rtt;
    if (m.createdAt < this.startedAt) { // adopted after a restart: it may be serving a class, never cut it here
      if (rtt != null) gate.status = 'adopted';
      return true;
    }
    const maxRttMs = rt.record.spec.maxRttMs ?? DEFAULT_MAX_RTT_MS;
    const decision = gateDecision({ rttMs: rtt, maxRttMs, firstSeenAt: gate.firstSeenAt, now });
    if (decision === 'wait') return false;
    const measured = rtt != null ? `RTT ${rtt} ms` : 'no RTT answer';
    if (decision === 'pass') {
      gate.status = 'passed';
      rt.lastPlacement = `${rt.lastPlacement ?? m.zone}; ${measured} ≤ maxRttMs ${maxRttMs}: kept`;
      rt.rejected = [];
      return true;
    }
    const note = `host ${m.zone || m.id}: ${measured} > maxRttMs ${maxRttMs}: released (too-far)`;
    rt.rejected = [...rt.rejected.slice(-4), note]; // the last few are enough to see a pattern
    rt.lastPlacement = `${rt.lastPlacement ?? m.zone}; ${note}`;
    this.log('deployments: replica too far', { deployment: m.deployment, id: m.id, rttMs: rtt, maxRttMs });
    await this.release(m, 'too-far');
    return false;
  }

  protected async release(m: ReplicaMachine, reason: string): Promise<void> {
    this.log('deployments: releasing replica', { deployment: m.deployment, id: m.id, reason });
    try {
      await this.backendOf(this.providerOf(m)).releaseReplica(m, reason);
      this.machines = this.machines.filter(x => x.id !== m.id);
      this.probes.delete(m.id);
    } catch (err) {
      const rt = this.deployments.get(m.deployment);
      if (rt) rt.lastError = `release ${m.id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** The reserved IP and firewall go with the deployment; the IP detaches some time after its server is deleted. */
  protected async releaseNetwork(name: string, network: NonNullable<DeploymentRecord['network']>): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this.backendOf('scaleway').releaseNetwork?.(network);
        this.log('deployments: released network', { deployment: name, ip: network.ip });
        return;
      } catch (err) {
        if (attempt === 9) this.log('deployments: release network failed', { deployment: name, error: err instanceof Error ? err.message : String(err) });
        await new Promise(r => setTimeout(r, NETWORK_RELEASE_RETRY_MS));
      }
    }
  }

  /** The spec as the machine sees it: the provider's own registry credentials when the caller sent none. */
  protected withRegistryAuth(backend: DeploymentBackend, spec: DeploymentSpec): DeploymentSpec {
    if (spec.registryAuth || spec.bootScript) return spec;
    const auth = backend.registryAuthFor?.(spec.image);
    return auth ? { ...spec, registryAuth: auth } : spec;
  }

  protected createReplica(rt: Runtime): void {
    const spec = rt.record.spec;
    if (this.now() < rt.backoffUntil) return;
    const refusal = this.capRefusal(0);
    if (refusal) {
      rt.lastError = refusal;
      return;
    }
    rt.creating++;
    rt.spendNote = null;
    const created: { id?: string } = {};
    const spend = { cost: 0 };
    this.pendingSpend.add(spend);
    void (async () => {
      try {
        const { machine, price, placement } = await placeReplica({
          spec, log: this.log, backendFor: (p) => this.backends[p],
          create: (backend, placed) => this.createOn(rt, backend, placed, created),
          // The place's price (the cap on a market-priced Vast offer) must fit under the € ceiling with what already runs.
          admit: (cost) => {
            spend.cost = 0;
            const why = this.spendRefusal(cost);
            if (why) rt.spendNote = why; else spend.cost = cost;
            return why;
          },
        });
        if (this.deployments.get(spec.name) !== rt) {
          await this.releaseOrphanedCreate(machine); // deleted while creating
          return;
        }
        this.machines = [...this.machines.filter(m => m.id !== machine.id), { ...machine, pricePerHour: machine.pricePerHour ?? price }];
        rt.lastPlacement = rt.rejected.length ? `${placement}; earlier: ${rt.rejected.join('; ')}` : placement;
        rt.createFailures = 0;
        rt.stockOut = null;
        rt.lastError = rt.spendNote ? `create: ${rt.spendNote}` : null;
      } catch (err) {
        if (err instanceof PlacementError) rt.lastPlacement = err.placement;
        rt.lastError = `create: ${err instanceof Error ? err.message : String(err)}`;
        // The € ceiling frees up as soon as something idles: retry soon, without the escalating back-off of a broken create.
        if (rt.spendNote && err instanceof PlacementError) rt.backoffUntil = this.now() + SPEND_RETRY_MS;
        else {
          // Out of stock everywhere is the provider's capacity, not a broken spec: same escalating ladder (bounded retry
          // rate, ≤ 1 create per 10 min once it persists), counted apart so the view says what blocks and for how long.
          rt.backoffUntil = this.now() + CREATE_BACKOFF_MS[Math.min(rt.createFailures, CREATE_BACKOFF_MS.length - 1)];
          rt.createFailures++;
          if (isOutOfStock(err)) rt.stockOut = { since: rt.stockOut?.since ?? this.now(), failures: (rt.stockOut?.failures ?? 0) + 1 };
        }
        this.log('deployments: create failed', { deployment: spec.name, error: rt.lastError });
      } finally {
        // A failed create cleans its own server up; anything left behind is listed again and planned as usual.
        if (created.id) this.creatingIds.delete(created.id);
        this.pendingSpend.delete(spend);
        rt.creating--;
      }
    })();
  }

  /**
   * The deployment was deleted while this machine was created: release it at once. The provider refuses while the server
   * is still starting (`resource_still_in_use`), so retry a bounded number of times — otherwise it would run until the
   * orphan sweep (QA 2026-10-06: ~20 s billed). A last failure is left to that sweep.
   */
  protected async releaseOrphanedCreate(machine: ReplicaMachine): Promise<void> {
    const backend = this.backendOf(this.providerOf(machine));
    for (let attempt = 1; ; attempt++) {
      try {
        await backend.releaseReplica(machine, 'deleted');
        return;
      } catch (err) {
        if (attempt >= ORPHAN_RELEASE_ATTEMPTS) {
          this.log('deployments: release after delete-during-create failed', { id: machine.id, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        await new Promise<void>(r => setTimeout(r, this.opts.releaseRetryMs ?? 2_000));
      }
    }
  }

  /** One create on one backend, the spec already narrowed to one place (zone, type, cap). */
  protected async createOn(rt: Runtime, backend: DeploymentBackend, spec: DeploymentSpec, created: { id?: string }): Promise<ReplicaMachine> {
    this.log('deployments: creating replica', { deployment: spec.name, provider: backend.provider, type: spec.machineType, zone: spec.zone });
    const network = spec.exposure ? await this.networkOf(rt, backend) : undefined;
    const machine = await backend.createReplica({
      spec, replicaToken: rt.record.replicaToken, namespace: this.namespace, ...(network ? { network } : {}),
      // Vast builds its own init (`vastReplicaInit`) from spec + token; Scaleway takes this cloud-init as user_data.
      cloudInit: backend.provider === 'scaleway' ? replicaCloudInit(this.withRegistryAuth(backend, spec), rt.record.replicaToken) : '',
      ...(spec.files ? { files: packFiles(Object.fromEntries(Object.entries(spec.files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]))).chunks } : {}),
      onCreated: (id) => { created.id = id; this.creatingIds.add(id); },
    });
    return { ...machine, provider: backend.provider };
  }

  /** Reserved IP + firewall of an exposed deployment, created once and kept in the record (it outlives replicas). */
  protected async networkOf(rt: Runtime, backend: DeploymentBackend): Promise<NonNullable<DeploymentRecord['network']>> {
    if (!backend.ensureNetwork) throw new Error(`provider ${backend.provider} cannot expose a deployment`);
    const network = await backend.ensureNetwork(rt.record.spec, this.namespace, rt.record.network);
    if (JSON.stringify(network) !== JSON.stringify(rt.record.network)) {
      rt.record = { ...rt.record, network };
      await this.opts.store.saveDeployment(rt.record);
    }
    return network;
  }
}
