/**
 * Real API smoke tests for fine-tune planning.
 *
 * Runs against Backblaze B2, Hugging Face, and MiniMax when credentials exist.
 * It never provisions a GPU. All B2 objects/buckets created here are temporary
 * and cleaned up in finally blocks.
 *
 * Run:
 *   SKIP_LIVE_TESTS=0 bunx vitest run --config vitest.config.ts __tests__/gpu-finetune-planner-real-api.test.ts
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { loadEnv } from './helpers';
import { MinimaxLLMProvider } from '../src/gateway/providers/cloud/minimax/llm';
import { buildFinetunePlan } from '../src/modules/gpu-finetune/planner';
import { preflightChecks } from '../src/modules/gpu-finetune/preflight';

await loadEnv();

const live = process.env.SKIP_LIVE_TESTS !== '1';
const hasB2 = !!(
  process.env.B2_BUCKET &&
  process.env.B2_ENDPOINT &&
  (process.env.B2_APPLICATION_KEY_ID || process.env.B2_KEY_ID || process.env.B2_ACCOUNT_ID) &&
  process.env.B2_APPLICATION_KEY
);
const hasMinimax = !!process.env.MINIMAX_API_KEY;
const hasHf = !!process.env.HF_TOKEN;

function b2Client(): S3Client {
  return new S3Client({
    region: process.env.B2_REGION || 'auto',
    endpoint: process.env.B2_ENDPOINT!,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.B2_APPLICATION_KEY_ID || process.env.B2_KEY_ID || process.env.B2_ACCOUNT_ID || '',
      secretAccessKey: process.env.B2_APPLICATION_KEY || '',
    },
  });
}

async function headObject(bucket: string, key: string): Promise<{ ok: boolean; bytes?: number; detail: string }> {
  try {
    const res = await b2Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { ok: true, bytes: res.ContentLength, detail: 'reachable' };
  } catch (err) {
    const e = err as Error & { name?: string };
    return { ok: false, detail: e.name || e.message || 'not reachable' };
  }
}

async function getText(bucket: string, key: string): Promise<string> {
  const res = await b2Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await res.Body!.transformToString();
}

describe.skipIf(!live || !hasB2)('fine-tune planner / Backblaze B2 real API', { timeout: 45_000 }, () => {
  const bucket = process.env.B2_BUCKET!;
  const prefix = `aigw-real-tests/finetune-planner-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('round-trips a temporary prepared dataset manifest object', async () => {
    const key = `${prefix}/manifest.jsonl`;
    const body = JSON.stringify({
      id: 'utt_00000',
      text: 'Teste rapido do planejador de fine tuning.',
      audio: 'audio/utt_00000.wav',
      sample_rate: 24000,
    }) + '\n';

    try {
      await b2Client().send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/jsonl',
      }));
      const head = await headObject(bucket, key);
      expect(head.ok).toBe(true);
      expect(head.bytes).toBe(body.length);
      expect(await getText(bucket, key)).toBe(body);
    } finally {
      await b2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
    }
  });

  it('passes B2 object checks when manifest/base/vocab exist', async () => {
    const objects = {
      manifest: `${prefix}/dataset/all_manifest.jsonl`,
      ckpt: `${prefix}/ckpts/base/best.pt`,
      vocab: `${prefix}/ckpts/base/phon_vocab.json`,
    };
    try {
      await b2Client().send(new PutObjectCommand({ Bucket: bucket, Key: objects.manifest, Body: '{"path":"x.npy"}\n' }));
      await b2Client().send(new PutObjectCommand({ Bucket: bucket, Key: objects.ckpt, Body: 'fake-ckpt-for-planner-head-test' }));
      await b2Client().send(new PutObjectCommand({ Bucket: bucket, Key: objects.vocab, Body: '{"a":1}' }));

      const plan = await buildFinetunePlan({
        type: 'audio',
        project: 'real-api-smoke',
        r2Bucket: bucket,
        r2Prefix: `${prefix}/out`,
        r2ShardedRoot: `b2aigw:${bucket}/${prefix}/dataset`,
        r2ShardedManifest: `b2aigw:${bucket}/${objects.manifest}`,
        r2BaseCkpt: `b2aigw:${bucket}/${objects.ckpt}`,
        r2BaseVocab: `b2aigw:${bucket}/${objects.vocab}`,
        sampleCount: 3,
        maxSpend: 0.5,
        skipSmoke: false,
      }, { deps: { headObject } });

      expect(plan.storage?.checks).toHaveLength(3);
      expect(plan.storage?.checks.every(c => c.ok)).toBe(true);
      expect(plan.blockers).not.toContain('required B2/R2 dataset or checkpoint objects are missing');
      expect(plan.dataset.needsPreparation).toBe(false);
    } finally {
      await Promise.all(Object.values(objects).map(Key =>
        b2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key })).catch(() => undefined),
      ));
    }
  });

  it('blocks the current route2-cml-tts project before GPU spend if referenced B2 objects are absent', async () => {
    const plan = await buildFinetunePlan({ project: 'route2-cml-tts', type: 'audio' }, { deps: { headObject } });
    expect(plan.blockers).toContain('required B2/R2 dataset or checkpoint objects are missing');
    expect(plan.storage?.checks.some(c => !c.ok)).toBe(true);
  });

  it('can create/delete a temporary B2 bucket when the key has account-level permission', async () => {
    const tempBucket = `aigw-ft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
    let created = false;
    try {
      await b2Client().send(new CreateBucketCommand({ Bucket: tempBucket }));
      created = true;
      await expect(b2Client().send(new HeadBucketCommand({ Bucket: tempBucket }))).resolves.toBeDefined();
    } catch (err) {
      const name = (err as Error & { name?: string }).name || '';
      const msg = (err as Error).message || '';
      expect(`${name} ${msg}`).toMatch(/AccessDenied|Unauthorized|Forbidden|not authorized|InvalidAccessKeyId|MalformedXML/i);
    } finally {
      if (created) {
        await b2Client().send(new DeleteBucketCommand({ Bucket: tempBucket })).catch(() => undefined);
      }
    }
  });
});

describe.skipIf(!live || !hasHf)('fine-tune preflight / Hugging Face real API', { timeout: 30_000 }, () => {
  it('checks a real dataset and reports prep metadata warning without failing the dataset reachability check', async () => {
    const result = await preflightChecks({
      type: 'codec-tts' as 'audio',
      dataset: 'hf://freds0/cml_tts_dataset_portuguese',
    }, process.env);

    const dataset = result.checks.find(c => c.name.startsWith('HF dataset'));
    expect(dataset?.status).toBe('ok');
    expect(result.checks.some(c => c.name === 'dataset prep input')).toBe(true);
  });
});

describe.skipIf(!live || !hasMinimax)('fine-tune planner / MiniMax real API', { timeout: 45_000 }, () => {
  it('calls the live agent and either attaches notes or surfaces provider exhaustion', async () => {
    const minimax = new MinimaxLLMProvider().withApiKey(process.env.MINIMAX_API_KEY!);
    const plan = await buildFinetunePlan({
      type: 'audio',
      dataset: 'hf://freds0/cml_tts_dataset_portuguese',
      r2Bucket: process.env.B2_BUCKET,
      sampleCount: 25,
      maxSpend: 0.5,
    }, {
      includeAgent: true,
      deps: { minimax },
    });

    if (plan.agent === 'minimax') {
      expect(plan.agentNotes?.length).toBeGreaterThan(10);
    } else {
      expect(plan.warnings.join('\n')).toMatch(/Minimax planning agent unavailable/i);
    }
  });
});
