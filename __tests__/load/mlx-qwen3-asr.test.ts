import { describe, it, expect } from 'vitest';
import { makeTestWav } from '../src/benchmarking/bench';
import { MlxQwen3AsrProvider, MLX_QWEN3_ASR_MODELS } from '../src/providers/mlx-qwen3-asr/index';

const DEFAULT_BASE_URL = 'http://localhost:8765/v1';
const provider = new MlxQwen3AsrProvider();

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(DEFAULT_BASE_URL.replace('/v1', '/health'), {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('MLX Qwen3-ASR Provider', () => {
  it('exports MLX_QWEN3_ASR_MODELS with correct structure', () => {
    expect(MLX_QWEN3_ASR_MODELS.length).toBeGreaterThanOrEqual(3);

    const ids = MLX_QWEN3_ASR_MODELS.map(m => m.id);
    expect(ids).toContain('qwen3-asr-0.6b-4bit');
    expect(ids).toContain('qwen3-asr-0.6b');
    expect(ids).toContain('qwen3-asr-1.7b');

    for (const model of MLX_QWEN3_ASR_MODELS) {
      expect(model.capability).toBe('stt');
    }

    const defaultModel = MLX_QWEN3_ASR_MODELS.find(m => m.isDefault);
    expect(defaultModel).toBeTruthy();
    expect(defaultModel!.id).toBe('qwen3-asr-0.6b-4bit');
  });

  it('isConfigured() returns true', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('providerId is mlx-qwen3-asr', () => {
    expect(provider.providerId).toBe('mlx-qwen3-asr');
  });

  it('getModels() returns the MLX models', () => {
    const models = provider.getModels();
    expect(models).toEqual(MLX_QWEN3_ASR_MODELS);
  });

  it('withApiKey() returns a new provider with the key', () => {
    const custom = provider.withApiKey('test-key');
    expect(custom).toBeInstanceOf(MlxQwen3AsrProvider);
    expect(custom).not.toBe(provider);
  });

  it('constructor accepts custom baseURL', () => {
    const custom = new MlxQwen3AsrProvider('http://localhost:9999/v1');
    expect(custom).toBeInstanceOf(MlxQwen3AsrProvider);
    expect(custom.getModels()).toEqual(MLX_QWEN3_ASR_MODELS);
  });

  it('transcribes audio via real server (integration)', async () => {
    const online = await isServerRunning();
    if (!online) {
      console.log('[MLX Qwen3-ASR] Server not running at localhost:8765 — skipping');
      return;
    }

    const audio = makeTestWav(0.5);
    const result = await provider.transcribe({ audio, language: 'en' });

    expect(typeof result.text).toBe('string');
    console.log(`[MLX Qwen3-ASR] Transcription: "${result.text}"`);
  }, 30_000);

  it('transcribe() throws when server is unreachable', async () => {
    const offlineProvider = new MlxQwen3AsrProvider('http://localhost:19999/v1');

    await expect(
      offlineProvider.transcribe({ audio: makeTestWav(0.5) }),
    ).rejects.toThrow();
  }, 10_000);
});
