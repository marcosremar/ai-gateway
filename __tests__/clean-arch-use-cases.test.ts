/**
 * Clean Architecture use cases — validate use cases drive entity transitions
 * through ports without caring about concrete adapters.
 */

import { describe, it, expect } from 'vitest';
import { ProvisionGpu } from '../src/gateway/use-cases/provision-gpu';
import { StopDeployment } from '../src/gateway/use-cases/stop-deployment';
import { RunTranslationPipeline } from '../src/gateway/use-cases/run-translation-pipeline';
import { Budget, BudgetExceededError } from '../src/gateway/entities/value-objects/budget';
import type {
  GpuProvisioner,
  ProvisionedInstance,
  DeploymentRepository,
  EventPublisher,
  DomainEvent,
  SttPort,
  LlmPort,
  TtsPort,
} from '../src/gateway/ports';
import type { Deployment } from '../src/gateway/entities/deployment';

// ── Fakes / stubs ──────────────────────────────────────────────────────────

class InMemoryDeploymentRepo implements DeploymentRepository {
  private active: Deployment | null = null;
  async loadActive() { return this.active; }
  async load() { return this.active; }
  async save(d: Deployment) { this.active = d; }
  async clearActive() { this.active = null; }
}

class CollectingEvents implements EventPublisher {
  public events: DomainEvent[] = [];
  publish(e: DomainEvent) { this.events.push(e); }
}

function makeProvisioner(override: Partial<ProvisionedInstance> = {}): GpuProvisioner {
  return {
    async provision() {
      return {
        podId: 'pod-xyz',
        endpoint: 'https://pod-xyz.test.io',
        provider: 'runpod',
        gpuType: 'RTX 4090',
        costPerHr: 0.5,
        metadata: {},
        ...override,
      };
    },
    async stop() {},
    async terminate() {},
  };
}

// ── ProvisionGpu ───────────────────────────────────────────────────────────

describe('ProvisionGpu use case', () => {
  it('happy path: budget ok → deploys → emits events → ready', async () => {
    const repo = new InMemoryDeploymentRepo();
    const events = new CollectingEvents();
    const usecase = new ProvisionGpu({
      provisioner: makeProvisioner(),
      repository: repo,
      events,
      budget: () => Budget.unlimited(),
    });

    const out = await usecase.execute({
      provider: 'runpod',
      gpuType: 'RTX 4090',
      dockerImage: 'marcosremar/test:latest',
      apiKey: 'k',
    });

    expect(out.deployment.isReady).toBe(true);
    expect(out.deployment.endpoint).toBe('https://pod-xyz.test.io');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);

    const types = events.events.map(e => e.type);
    expect(types).toContain('deploy.started');
    expect(types).toContain('deploy.ready');
  });

  it('refuses deploy when budget is exceeded', async () => {
    const repo = new InMemoryDeploymentRepo();
    const events = new CollectingEvents();
    const usecase = new ProvisionGpu({
      provisioner: makeProvisioner(),
      repository: repo,
      events,
      budget: () => Budget.of(10, 9.8), // soft limit exceeded
    });

    await expect(
      usecase.execute({
        provider: 'runpod',
        gpuType: 'RTX 4090',
        dockerImage: 'x',
        apiKey: 'k',
      }),
    ).rejects.toThrow(BudgetExceededError);

    expect(events.events.some(e => e.type === 'deploy.rejected')).toBe(true);
    expect(events.events.some(e => e.type === 'deploy.started')).toBe(false);
  });

  it('provisioner failure → deployment ends in error phase', async () => {
    const repo = new InMemoryDeploymentRepo();
    const events = new CollectingEvents();
    const failingProvisioner: GpuProvisioner = {
      async provision() { throw new Error('API 500'); },
      async stop() {}, async terminate() {},
    };
    const usecase = new ProvisionGpu({
      provisioner: failingProvisioner,
      repository: repo,
      events,
      budget: () => Budget.unlimited(),
    });

    await expect(usecase.execute({
      provider: 'vast', gpuType: 'A100', dockerImage: 'x', apiKey: 'k',
    })).rejects.toThrow('API 500');

    const stored = await repo.loadActive();
    expect(stored?.phase).toBe('error');
    expect(events.events.some(e => e.type === 'deploy.failed')).toBe(true);
  });
});

// ── StopDeployment ─────────────────────────────────────────────────────────

describe('StopDeployment use case', () => {
  it('stops a ready deployment and emits event', async () => {
    const repo = new InMemoryDeploymentRepo();
    const events = new CollectingEvents();

    // Seed a ready deployment by running ProvisionGpu first
    await new ProvisionGpu({
      provisioner: makeProvisioner(),
      repository: repo,
      events,
      budget: () => Budget.unlimited(),
    }).execute({ provider: 'runpod', gpuType: 'x', dockerImage: 'y', apiKey: 'k' });

    const stopUsecase = new StopDeployment({
      provisioner: makeProvisioner(),
      repository: repo,
      events,
    });

    const stopped = await stopUsecase.execute({ apiKey: 'k' });
    expect(stopped.phase).toBe('stopped');
    expect(events.events.some(e => e.type === 'deploy.stopped')).toBe(true);
  });

  it('refuses to stop when no active deployment', async () => {
    const repo = new InMemoryDeploymentRepo();
    const events = new CollectingEvents();
    const uc = new StopDeployment({
      provisioner: makeProvisioner(),
      repository: repo,
      events,
    });
    await expect(uc.execute({ apiKey: 'k' })).rejects.toThrow(/No active/);
  });
});

// ── RunTranslationPipeline ─────────────────────────────────────────────────

describe('RunTranslationPipeline use case', () => {
  const stt: SttPort = {
    async transcribe() {
      return { text: 'hello world', language: 'en', latencyMs: 50, model: 'test-stt' };
    },
  };
  const llm: LlmPort = {
    async chat() { throw new Error('chat not used here'); },
    async translate(req) {
      return { text: `[${req.to}] ${req.text}`, from: req.from, to: req.to, latencyMs: 70, model: 'test-llm' };
    },
  };
  const tts: TtsPort = {
    async synthesize() {
      return {
        audio: Buffer.from('fake audio'),
        format: 'wav',
        sampleRate: 16000,
        latencyMs: 120,
        model: 'test-tts',
      };
    },
  };

  it('runs STT → LLM → TTS and returns aggregate result', async () => {
    const events = new CollectingEvents();
    const uc = new RunTranslationPipeline({ stt, llm, tts, events });

    const out = await uc.execute({
      audio: Buffer.from('fake wav'),
      sourceLang: 'en',
      targetLang: 'pt',
      voice: 'autumn',
      sessionId: 'sess-1',
    });

    expect(out.transcription.text).toBe('hello world');
    expect(out.translation.text).toBe('[pt] hello world');
    expect(out.synthesized.audio.length).toBeGreaterThan(0);
    expect(out.stageLatencies.stt).toBe(50);
    expect(out.stageLatencies.llm).toBe(70);
    expect(out.stageLatencies.tts).toBe(120);
  });

  it('emits start+completed event per stage plus pipeline.completed', async () => {
    const events = new CollectingEvents();
    await new RunTranslationPipeline({ stt, llm, tts, events }).execute({
      audio: Buffer.from('x'),
      sourceLang: 'en',
      targetLang: 'es',
      voice: 'v',
    });

    const types = events.events.map(e => e.type);
    expect(types.filter(t => t === 'pipeline.stage.started')).toHaveLength(3);
    expect(types.filter(t => t === 'pipeline.stage.completed')).toHaveLength(3);
    expect(types).toContain('pipeline.completed');
  });
});
