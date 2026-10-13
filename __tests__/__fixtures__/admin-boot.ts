import type { AdminSnapshot } from '../../src/admin-page';
import { bootStates, phaseDurations, type BootLogLine, type BootPhase, type BootRecord, type PhaseMark } from '../../src/deployments/boot-track';
import type { DeploymentView, ReplicaView } from '../../src/deployments/types';

const MIN = 60_000;

function boot(now: number, steps: Array<[BootPhase, number]>): PhaseMark[] {
  return steps.map(([phase, minutesAgo]) => ({ phase, at: now - minutesAgo * MIN }));
}

function readyBoot(replicaId: string, now: number, startedMinAgo: number, minutes: Array<[BootPhase, number]>): BootRecord {
  let at = now - startedMinAgo * MIN;
  const phases = minutes.map(([phase, m]) => {
    const mark = { phase, at };
    at += m * MIN;
    return mark;
  });
  return { replicaId, startedAt: phases[0]!.at, endedAt: at, result: 'ready', reason: null, phases: [...phases, { phase: 'ready', at }] };
}

function bootView(now: number, active: Array<{ replicaId: string | null; phases: PhaseMark[] }>, past: BootRecord[], timeout: number,
  extra: Partial<DeploymentView['boot']> = {}): DeploymentView['boot'] {
  return {
    active: bootStates(active, past, now, timeout).map(b => ({ ...b, phases: phaseDurations(b.phases, now) })),
    past: past.map(b => ({ ...b, phases: phaseDurations(b.phases, b.endedAt) })),
    retryAt: null, expectedBootSeconds: null, ...extra,
  };
}

const booting = (id: string, extra: Partial<ReplicaView>): ReplicaView => ({
  id, phase: 'booting', ip: null, providerState: 'starting', provider: 'vast', zone: 'Lyon, FR', machineType: 'RTX 3090', pricePerHour: 0.181,
  ageSeconds: 300, inflight: 0, busy: false, draining: false, stagesOut: [], rttMs: null, rttBaselineMs: null, udp: null,
  hostEndsInMinutes: null, expiresInMinutes: null, ...extra,
});

const line = (now: number, minutesAgo: number, replicaId: string | null, text: string): BootLogLine => ({ at: now - minutesAgo * MIN, replicaId, text });

export function withBoots(s: AdminSnapshot, now: number, stuck: boolean): AdminSnapshot {
  const vastPast = [
    readyBoot('31480211', now, 26 * 60, [['placing', 1], ['provisioning', 2], ['pulling', 6], ['starting', 2], ['loading', 4]]),
    readyBoot('31502877', now, 9 * 60, [['placing', 1], ['provisioning', 2], ['pulling', 7], ['starting', 2], ['loading', 5]]),
    { replicaId: '31511904', startedAt: now - 4 * 60 * MIN, endedAt: now - 3.4 * 60 * MIN, result: 'failed' as const, reason: 'boot-timeout',
      phases: boot(now, [['provisioning', 240], ['pulling', 238]]) },
  ];
  const scwPast = [
    readyBoot('fr-par-2/9c41', now, 30 * 60, [['provisioning', 2], ['starting', 5], ['loading', 4]]),
    readyBoot('fr-par-2/a7d2', now, 6 * 60, [['provisioning', 2], ['starting', 6], ['loading', 4]]),
  ];
  const changes: Record<string, (d: DeploymentView) => DeploymentView> = {
    'babelcast-3090': d => ({
      ...d, status: 'warming', lastRequestAt: new Date(now - 7 * MIN).toISOString(),
      spec: { ...d.spec, image: 'ghcr.io/marcosremar/speech-stack:20261011-0200', bootTimeoutMinutes: 35 },
      lastPlacement: 'vast RTX 3090 offer 28817342 @ Lyon, FR (US$0.19/h) near FR',
      replicas: [booting('31544017', { ageSeconds: 5 * 60, providerState: 'starting' })],
      boot: bootView(now, [{ replicaId: '31544017', phases: boot(now, [['placing', 7], ['provisioning', 5], ['pulling', 3]]) }], vastPast, 35, { expectedBootSeconds: 14 * 60 }),
    }),
    'parle-bridge-shadow': d => ({
      ...d, lastError: 'create: out_of_stock: no vast offer for RTX 3090 under €0.30/h near FR',
      boot: bootView(now, [], [
        { replicaId: null, startedAt: now - 9 * MIN, endedAt: now - 8 * MIN, result: 'failed', reason: 'out_of_stock: no vast offer for RTX 3090 under €0.30/h near FR', phases: boot(now, [['placing', 9]]) },
        { replicaId: null, startedAt: now - 12 * MIN, endedAt: now - 11 * MIN, result: 'failed', reason: 'out_of_stock: no vast offer for RTX 3090 under €0.30/h near FR', phases: boot(now, [['placing', 12]]) },
      ], 35, { retryAt: now + 7 * MIN }),
    }),
    ...(stuck ? {
      'speech-stack-test': (d: DeploymentView) => ({
        ...d, status: 'warming' as const, spec: { ...d.spec, image: 'rg.fr-par.scw.cloud/aigw/speech-stack:20261011-0200', bootTimeoutMinutes: 45 },
        replicas: [booting('fr-par-2/c3e9', { provider: 'scaleway', zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.79, providerState: 'running', ip: '51.15.0.12', ageSeconds: 26 * 60 })],
        boot: bootView(now, [{ replicaId: 'fr-par-2/c3e9', phases: boot(now, [['provisioning', 26], ['starting', 20], ['loading', 14]]) }], scwPast, 45, {
          expectedBootSeconds: 11 * 60, retriesExhausted: true,
          retries: [
            { at: now - 50 * MIN, replicaId: 'fr-par-2/a01f', where: 'fr-par-2', phase: 'loading', minutes: 16, attempt: 1, next: { replicaId: 'nl-ams-1/b2c4', where: 'nl-ams-1' } },
            { at: now - 27 * MIN, replicaId: 'nl-ams-1/b2c4', where: 'nl-ams-1', phase: 'starting', minutes: 17, attempt: 2, next: { replicaId: 'fr-par-2/c3e9', where: 'fr-par-2' } },
          ],
        }),
      }),
    } : {}),
  };
  const gpuLogs: Record<string, BootLogLine[]> = {
    'babelcast-3090': [
      line(now, 26 * 60, '31480211', 'replica ready bootMs=900000'),
      line(now, 4 * 60, '31511904', 'releasing replica reason=boot-timeout busy=0'),
      line(now, 7, null, 'creating replica provider=vast type=RTX 3090 zone=fr-par-2'),
      line(now, 5, '31544017', 'phase provisioning'),
      line(now, 5, '31544017', 'provider: created'),
      line(now, 3, '31544017', 'phase pulling'),
      line(now, 3, '31544017', 'provider: Pulling image ghcr.io/marcosremar/speech-stack:20261011-0200'),
      line(now, 1, '31544017', 'provider: 3f2a1c9e: Downloading [=========>          ] 21.4GB/57.1GB'),
    ],
    'parle-bridge-shadow': [
      line(now, 12, null, 'creating replica provider=vast type=RTX 3090 zone=fr-par-2'),
      line(now, 11, null, 'create failed error=create: out_of_stock: no vast offer for RTX 3090 under €0.30/h near FR'),
      line(now, 9, null, 'creating replica provider=vast type=RTX 3090 zone=fr-par-2'),
      line(now, 8, null, 'create failed error=create: out_of_stock: no vast offer for RTX 3090 under €0.30/h near FR'),
    ],
    'speech-stack-test': [
      line(now, 26, null, 'creating replica provider=scaleway type=L4-1-24G zone=fr-par-2'),
      line(now, 26, 'fr-par-2/c3e9', 'phase provisioning'),
      line(now, 20, 'fr-par-2/c3e9', 'phase starting'),
      line(now, 14, 'fr-par-2/c3e9', 'phase loading'),
    ],
  };
  return { ...s, gpus: s.gpus!.map(d => changes[d.name]?.(d) ?? d), gpuLogs };
}
