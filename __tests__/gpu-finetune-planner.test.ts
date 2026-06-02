import { describe, expect, it } from 'vitest';

import { buildFinetunePlan, parseRcloneUri } from '../src/modules/gpu-finetune/planner';

describe('fine-tune planner', () => {
  it('parses rclone remote paths', () => {
    expect(parseRcloneUri('b2aigw:bucket/path/to/manifest.jsonl')).toEqual({
      remote: 'b2aigw',
      bucket: 'bucket',
      key: 'path/to/manifest.jsonl',
    });
    expect(parseRcloneUri('r2://bucket/path')).toBeNull();
  });

  it('blocks before GPU spend when required B2 objects are missing', async () => {
    const plan = await buildFinetunePlan({
      type: 'audio',
      project: 'route2-cml-tts',
      r2Bucket: 'tts-ptbr-training',
      r2ShardedManifest: 'b2aigw:tts-ptbr-training/datasets/missing/all_manifest.jsonl',
      r2BaseCkpt: 'b2aigw:tts-ptbr-training/ckpts/v12/best.pt',
    }, {
      env: {
        B2_APPLICATION_KEY_ID: 'id',
        B2_APPLICATION_KEY: 'secret',
        B2_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
        AIGW_EXPECT_STORAGE_PROVIDER: 'backblaze',
      },
      deps: {
        headObject: async () => ({ ok: false, detail: 'NotFound' }),
      },
    });

    expect(plan.storage?.provider).toBe('backblaze-b2');
    expect(plan.storage?.checks.every(c => !c.ok)).toBe(true);
    expect(plan.blockers).toContain('required B2/R2 dataset or checkpoint objects are missing');
  });

  it('recommends the cheapest dataset prep option and keeps training estimate separate', async () => {
    const plan = await buildFinetunePlan({
      type: 'audio',
      dataset: 'hf://owner/dataset',
      r2Bucket: 'omni-speech-dataset',
      sampleCount: 1000,
      maxSamples: 1000,
      workers: 4,
    }, {
      env: {
        B2_APPLICATION_KEY_ID: 'id',
        B2_APPLICATION_KEY: 'secret',
        B2_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
        AIGW_DATASET_CPU_PRICE_PER_HOUR: '0.01',
        AIGW_DATASET_CPU_SAMPLES_PER_SEC: '1',
        AIGW_DATASET_CHEAP_GPU_PRICE_PER_HOUR: '0.25',
      },
    });

    expect(plan.dataset.needsPreparation).toBe(true);
    expect(plan.economics.recommended.kind).toBe('cheap-gpu');
    expect(plan.training.totalUsd).toBeGreaterThan(0);
    expect(plan.nextSteps.some(step => step.includes('prepare dataset'))).toBe(true);
  });

  it('uses MiniMax agent notes when injected', async () => {
    const plan = await buildFinetunePlan({ type: 'audio', sampleCount: 10 }, {
      includeAgent: true,
      deps: {
        minimax: {
          async chat() {
            return { content: 'Use CPU fanout, upload manifest to B2, then run smoke.' };
          },
        },
      },
    });

    expect(plan.agent).toBe('minimax');
    expect(plan.agentNotes).toContain('CPU fanout');
  });
});
