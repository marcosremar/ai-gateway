import { describe, expect, it } from 'vitest';
import {
  buildKokoroDatasetPlan,
  buildKokoroWorkerScript,
  generatePortugueseTemplatePhrases,
  parseGatewayPhraseList,
  r2ToS3Uri,
  runKokoroDatasetFanout,
  shardKokoroPhrases,
  validateKokoroRunRequest,
  type DaytonaLike,
} from '../src/modules/gpu-finetune/kokoro-dataset.js';

describe('Kokoro dataset prep tool', () => {
  it('generates 100 deterministic Portuguese template phrases', () => {
    const phrases = generatePortugueseTemplatePhrases(100);

    expect(phrases).toHaveLength(100);
    expect(new Set(phrases.map(p => p.text)).size).toBe(100);
    expect(phrases[0].id).toBe('utt_00000');
    expect(phrases.some(p => p.text.includes('croissants'))).toBe(true);
  });

  it('splits 100 phrases into 20 CPU worker shards', () => {
    const shards = shardKokoroPhrases(generatePortugueseTemplatePhrases(100), 20);

    expect(shards).toHaveLength(20);
    expect(new Set(shards.map(s => s.phrases.length))).toEqual(new Set([5]));
    expect(shards[19].phrases.at(-1)?.id).toBe('utt_00099');
  });

  it('builds a GPU-free dataset prep plan', () => {
    const plan = buildKokoroDatasetPlan(generatePortugueseTemplatePhrases(100), {
      workers: 20,
      voice: 'pf_dora',
      r2Uri: 'r2://kokoro-datasets/pf_dora/pt-br-smoke',
    });

    expect(plan).toMatchObject({
      voice: 'pf_dora',
      language: 'pt-BR',
      phraseCount: 100,
      workerCount: 20,
      gpuRequired: false,
      trainingEnabled: false,
    });
    expect(plan.shards[0]).toMatchObject({
      phraseCount: 5,
      r2Uri: 'r2://kokoro-datasets/pf_dora/pt-br-smoke/shards/00',
    });
  });

  it('parses fenced LLM phrase JSON', () => {
    expect(parseGatewayPhraseList('```json\n["Bom dia.", "Muito obrigado."]\n```')).toEqual([
      'Bom dia.',
      'Muito obrigado.',
    ]);
  });

  it('builds CPU-only Kokoro worker script that uploads to R2', () => {
    const [shard] = shardKokoroPhrases(generatePortugueseTemplatePhrases(5), 1);
    const script = buildKokoroWorkerScript(shard, {
      voice: 'pf_dora',
      r2Uri: 'r2://bucket/kokoro/pf_dora',
    });

    expect(script).toContain('KPipeline(lang_code="p", device="cpu")');
    expect(script).toContain('voice = "pf_dora"');
    expect(script).toContain('https://download.pytorch.org/whl/cpu');
    expect(script).toContain('aws --endpoint-url "$R2_ENDPOINT_URL" s3 sync');
    expect(script).toContain('s3://bucket/kokoro/pf_dora/shards/00');
    expect(script).not.toContain('R2_SECRET_ACCESS_KEY=');
  });

  it('requires --yes, R2 env, and Daytona env before real execution', () => {
    expect(() => validateKokoroRunRequest({ yes: false })).toThrow('without --yes');
    expect(() => validateKokoroRunRequest({
      yes: true,
      workers: 21,
      maxWorkers: 20,
      env: {},
    })).toThrow('refusing workers=21');
    expect(() => validateKokoroRunRequest({
      yes: true,
      env: {},
    })).toThrow('missing R2 env vars');
  });

  it('runs fanout through injected Daytona client', async () => {
    const calls: string[] = [];
    let next = 0;
    const fake: DaytonaLike = {
      async create() { const id = `sid-${next++}`; calls.push(`create:${id}`); return { id }; },
      async setAutoDelete(id) { calls.push(`autodelete:${id}`); },
      async start(id) { calls.push(`start:${id}`); },
      async stop(id) { calls.push(`stop:${id}`); },
      async exec(id, command) { calls.push(`exec:${id}:${command.slice(0, 24)}`); return { exitCode: 0, result: '' }; },
      async execDetached(id, command) { calls.push(`detached:${id}:${command.includes('pf_dora')}`); },
      async execWait(id) { calls.push(`wait:${id}`); return 'uploaded'; },
    };

    const result = await runKokoroDatasetFanout({
      yes: true,
      workers: 2,
      phrases: 4,
      voice: 'pf_dora',
      r2Uri: 'r2://bucket/kokoro',
      daytona: fake,
      env: {
        R2_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'id',
        R2_SECRET_ACCESS_KEY: 'secret',
        DAYTONA_API_KEY: 'daytona',
      },
    });

    expect(result.status).toBe('done');
    expect(result.results).toHaveLength(2);
    expect(calls).toContain('detached:sid-0:true');
    expect(calls).toContain('stop:sid-1');
  });

  it('converts r2 uri to s3 uri for aws cli', () => {
    expect(r2ToS3Uri('r2://bucket/path')).toBe('s3://bucket/path');
    expect(() => r2ToS3Uri('s3://bucket/path')).toThrow('r2Uri must start');
  });
});
