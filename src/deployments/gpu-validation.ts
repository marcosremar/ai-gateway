import { classWindowOpen } from './autoscale';
import { DeploymentError, type DeploymentController } from './controller';
import { contentCheck, replicaCaller, type StageTarget } from './gpu-probe';
import { countryOf } from './placements';
import { readStateFile, writeStateFile } from './state-file';
import type { DeploymentView, ReplicaView } from './types';

const VALIDATION_STABLE_MS = 3 * 60_000;
const VALIDATION_CHECK_EVERY_MS = 60_000;
export const VALIDATION_FAILS = 3;
const TRIAL_EXPECTED_MINUTES = 25;
export const TRIAL_DEADLINE_MINUTES = 40;
const TICK_MS = 15_000;
const CHECK_TIMEOUT_MS = 60_000;
const CLASS_LOOKAHEAD_STEP_MS = 5 * 60_000;
const LOG_LINES_KEPT = 20;

interface GpuValidated { at: number; deployment: string; country: string | null; checkMs: number | null; seed?: string }
interface GpuFailed { at: number; deployment: string; reason: string; lines: string[] }
interface GpuTrial {
  family: string; deployment: string; machineType: string; image: string; by: string; startedAt: number; deadline: number; previous: string | null;
}
interface State { validated: Record<string, GpuValidated>; failed: Record<string, GpuFailed>; trial: GpuTrial | null }

export interface GpuTypeValidation {
  machineType: string;
  maxEurPerHour: number;
  validated: { at: string; deployment: string; country: string | null; checkMs: number | null; seed: string | null } | null;
  failed: { at: string; deployment: string; reason: string; lines: string[] } | null;
}

export interface GpuValidationView {
  family: string;
  image: string;
  gated: boolean;
  testCopy: string | null;
  types: GpuTypeValidation[];
  trial: { machineType: string; deployment: string; by: string; startedAt: string; deadline: string } | null;
  trialRefusal: string | null;
  trialMinutes: number;
}

const validationKey = (family: string, image: string, machineType: string) => `${family}|${image}|${machineType}`;
const familyOf = (view: Pick<DeploymentView, 'name' | 'spec'>) => view.spec.testFor ?? view.name;
const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

const GPU_VALIDATION_SEEDS: Array<GpuValidated & { family: string; image: string; machineType: string }> = [{
  family: 'parle-speech', image: 'ghcr.io/marcosremar/speech-stack:20261011-0200', machineType: 'RTX 3090',
  at: Date.parse('2026-10-14T01:20:45Z'), deployment: 'parle-speech-test', country: 'CZ', checkMs: 1730,
  seed: 'docs/deployments.md (PR #164): 10 turnos STT → LLM → voz clonada, p50 1,73 s; 24 turnos simultâneos sem erro',
}];

type Controller = Pick<DeploymentController, 'get' | 'list' | 'setGpuType' | 'warm' | 'park' | 'tokenOf' | 'gpuSlotTaken' | 'bootLog'>;
type Check = (view: DeploymentView, replica: ReplicaView, stages: StageTarget[]) => Promise<string | null>;

interface GpuValidationOptions {
  controller: Controller;
  stages: (deployment: string) => StageTarget[];
  path?: string;
  check?: Check;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

interface Watch { okSince: number | null; at: number; fails: number; done: boolean }

export class GpuValidation {
  private state: State = { validated: {}, failed: {}, trial: null };
  private readonly watched = new Map<string, Watch>();
  private readonly now: () => number;
  private readonly check: Check;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: GpuValidationOptions) {
    this.now = opts.now ?? Date.now;
    this.check = opts.check ?? ((view, r, stages) => contentCheck(replicaCaller(opts.controller, view, r, CHECK_TIMEOUT_MS, opts.fetchImpl), stages));
    this.seed();
  }

  async load(): Promise<void> {
    if (!this.opts.path) return;
    const read = await readStateFile<State>(this.opts.path);
    if (read.data) this.state = { validated: read.data.validated ?? {}, failed: read.data.failed ?? {}, trial: read.data.trial ?? null };
    this.seed();
  }

  private seed(): void {
    for (const { family, image, machineType, ...record } of GPU_VALIDATION_SEEDS) this.state.validated[validationKey(family, image, machineType)] ??= record;
  }

  private validatedFor(view: DeploymentView, machineType: string): GpuValidated | null {
    return this.state.validated[validationKey(familyOf(view), view.spec.image, machineType)] ?? null;
  }

  private testCopyOf(view: DeploymentView): DeploymentView | null {
    return this.opts.controller.list().find(d => d.spec.testFor === view.name && d.app === view.app) ?? null;
  }

  gpuTypeRefusal(name: string, machineType: string | null): string | null {
    const view = this.opts.controller.get(name);
    if (!view?.gpuType || view.spec.testFor || machineType === null || machineType === view.gpuType.default) return null;
    if (!view.gpuType.choices.some(c => c.machineType === machineType) || this.validatedFor(view, machineType)) return null;
    return `${machineType} ainda não validada nesta imagem (${view.spec.image}): use «testar nesta GPU» antes de pô-la em produção`;
  }

  async setGpuType(name: string, machineType: string | null, now: boolean, by: string, force = false): Promise<{ view: DeploymentView; forced: boolean }> {
    const refusal = this.gpuTypeRefusal(name, machineType);
    if (refusal && !force) throw new DeploymentError(409, refusal);
    if (refusal) this.opts.log?.('gpu validation: GPU type forced without validation', { deployment: name, machineType, by });
    return { view: await this.opts.controller.setGpuType(name, machineType, now, by), forced: Boolean(refusal) };
  }

  trialRefusal(view: DeploymentView, machineType?: string): string | null {
    if (view.spec.testFor) return 'o teste roda pela cópia de teste do deployment de produção';
    const test = this.testCopyOf(view);
    if (!test) return `${view.name} não tem cópia de teste (testFor)`;
    if (test.spec.image !== view.spec.image) return `a cópia de teste ${test.name} roda outra imagem (${test.spec.image})`;
    const trial = this.state.trial;
    if (trial) return `já há um teste em curso: ${trial.machineType} em ${trial.deployment} até ${hhmm(trial.deadline)}`;
    const now = this.now();
    const views = this.opts.controller.list();
    if (classWindowOpen(views, now)) return 'janela de aula aberta: a GPU do app é dos alunos';
    for (let t = now; t <= now + TRIAL_DEADLINE_MINUTES * 60_000; t += CLASS_LOOKAHEAD_STEP_MS) {
      if (classWindowOpen(views, t)) return `a janela de aula abre antes de o teste terminar (até ${TRIAL_DEADLINE_MINUTES} min)`;
    }
    const up = test.replicas.filter(r => r.phase !== 'halted');
    const slot = this.opts.controller.gpuSlotTaken(test.name) ?? (up.length ? `${test.name} já está ligada (${up[0]!.machineType})` : null);
    if (slot) return `a GPU do app está ocupada: ${slot}`;
    if (machineType === undefined) return null;
    if (!test.gpuType?.choices.some(c => c.machineType === machineType)) return `${machineType} não é um tipo de GPU de ${test.name}`;
    return this.validatedFor(view, machineType) ? `${machineType} já está validada nesta imagem` : null;
  }

  async startTrial(name: string, machineType: string, by: string): Promise<GpuTrial> {
    const view = this.opts.controller.get(name);
    if (!view) throw new DeploymentError(404, `deployment '${name}' not found`);
    const refusal = this.trialRefusal(view, machineType);
    if (refusal) throw new DeploymentError(409, refusal);
    const test = this.testCopyOf(view)!;
    const previous = test.gpuType && test.gpuType.current !== test.gpuType.default ? test.gpuType.current : null;
    await this.opts.controller.setGpuType(test.name, machineType, false, by);
    try {
      await this.opts.controller.warm(test.name, 1, TRIAL_DEADLINE_MINUTES);
    } catch (err) {
      await this.opts.controller.setGpuType(test.name, previous, false, by).catch(() => {});
      throw err;
    }
    const now = this.now();
    const trial: GpuTrial = {
      family: view.name, deployment: test.name, machineType, image: test.spec.image, by, startedAt: now, deadline: now + TRIAL_DEADLINE_MINUTES * 60_000, previous,
    };
    this.state.trial = trial;
    await this.save();
    this.opts.log?.('gpu validation: trial started', { deployment: test.name, machineType, by });
    return trial;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const views = this.opts.controller.list().filter(v => v.gpuType);
      const ready = views.flatMap(view => view.replicas.filter(r => r.phase === 'ready' && r.ip).map(r => ({ view, r })));
      await Promise.all(ready.map(({ view, r }) => this.watch(view, r)));
      const seen = new Set(ready.map(({ r }) => r.id));
      for (const id of this.watched.keys()) if (!seen.has(id)) this.watched.delete(id);
      await this.trialTick();
    } finally {
      this.running = false;
    }
  }

  private async watch(view: DeploymentView, r: ReplicaView): Promise<void> {
    const key = validationKey(familyOf(view), view.spec.image, r.machineType);
    if (this.state.validated[key]) return;
    const w = this.watched.get(r.id) ?? { okSince: null, at: -Infinity, fails: 0, done: false };
    this.watched.set(r.id, w);
    const at = this.now();
    if (w.done || at - w.at < VALIDATION_CHECK_EVERY_MS) return;
    const own = this.opts.stages(view.name);
    const stages = own.length ? own : this.opts.stages(familyOf(view));
    if (!stages.length) return;
    w.at = at;
    const error = await this.check(view, r, stages).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    const checkMs = this.now() - at;
    if (error) {
      w.okSince = null;
      if (++w.fails < VALIDATION_FAILS) return;
      w.done = true;
      return this.fail(key, view.name, error);
    }
    w.fails = 0;
    w.okSince ??= at;
    if (at - w.okSince < VALIDATION_STABLE_MS) return;
    w.done = true;
    this.state.validated[key] = { at: this.now(), deployment: view.name, country: countryOf(r.zone), checkMs };
    this.opts.log?.('gpu validation: validated', { deployment: view.name, machineType: r.machineType, image: view.spec.image, checkMs });
    await this.save();
  }

  private async fail(key: string, deployment: string, reason: string): Promise<void> {
    const lines = this.opts.controller.bootLog(deployment).slice(-LOG_LINES_KEPT).map(l => l.text);
    this.state.failed[key] = { at: this.now(), deployment, reason, lines };
    this.opts.log?.('gpu validation: failed', { deployment, key, reason });
    await this.save();
  }

  private async trialTick(): Promise<void> {
    const trial = this.state.trial;
    if (!trial) return;
    const key = validationKey(trial.family, trial.image, trial.machineType);
    const ended = [this.state.validated[key], this.state.failed[key]].some(r => r && r.at >= trial.startedAt);
    if (!ended) {
      const now = this.now();
      if (classWindowOpen(this.opts.controller.list(), now)) await this.fail(key, trial.deployment, 'interrompido: a janela de aula abriu');
      else if (now >= trial.deadline) {
        const lastError = this.opts.controller.get(trial.deployment)?.lastError;
        await this.fail(key, trial.deployment, lastError ?? `não ficou pronta e estável em ${TRIAL_DEADLINE_MINUTES} min`);
      } else return;
    }
    this.state.trial = null;
    await this.save();
    await this.opts.controller.park(trial.deployment).catch(err => this.opts.log?.('gpu validation: park failed', { error: String(err) }));
    await this.opts.controller.setGpuType(trial.deployment, trial.previous, false, 'gpu-validation')
      .catch(err => this.opts.log?.('gpu validation: GPU type not restored', { error: String(err) }));
    this.opts.log?.('gpu validation: trial ended, test copy parked', { deployment: trial.deployment, machineType: trial.machineType });
  }

  view(name: string): GpuValidationView | null {
    const view = this.opts.controller.get(name);
    if (!view?.gpuType) return null;
    const family = familyOf(view);
    const trial = this.state.trial?.family === family ? this.state.trial : null;
    return {
      family, image: view.spec.image, gated: !view.spec.testFor, testCopy: view.spec.testFor ? null : this.testCopyOf(view)?.name ?? null,
      types: view.gpuType.choices.map((c) => {
        const key = validationKey(family, view.spec.image, c.machineType);
        const ok = this.state.validated[key];
        const failed = this.state.failed[key];
        return {
          ...c,
          validated: ok ? { at: iso(ok.at), deployment: ok.deployment, country: ok.country, checkMs: ok.checkMs, seed: ok.seed ?? null } : null,
          failed: failed ? { at: iso(failed.at), deployment: failed.deployment, reason: failed.reason, lines: failed.lines } : null,
        };
      }),
      trial: trial && { machineType: trial.machineType, deployment: trial.deployment, by: trial.by, startedAt: iso(trial.startedAt), deadline: iso(trial.deadline) },
      trialRefusal: view.spec.testFor ? null : this.trialRefusal(view),
      trialMinutes: TRIAL_EXPECTED_MINUTES,
    };
  }

  views(): Record<string, GpuValidationView> {
    return Object.fromEntries(this.opts.controller.list().flatMap(d => {
      const v = this.view(d.name);
      return v ? [[d.name, v]] : [];
    }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(err => this.opts.log?.('gpu validation: tick failed', { error: String(err) })), TICK_MS);
    this.timer.unref?.();
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.chain;
  }

  private save(): Promise<void> {
    const path = this.opts.path;
    if (!path) return Promise.resolve();
    const snapshot = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.catch(() => {}).then(() => writeStateFile(path, snapshot));
    return this.chain;
  }
}
