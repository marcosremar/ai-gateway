import { describe, expect, it } from 'vitest';

import { resolveFinetuneOutputForRuntime } from '../server/gpu-finetune-handlers';

describe('fine-tune HTTP runtime output paths', () => {
  it('rewrites macOS output paths when the runner executes on Fly', () => {
    const output = resolveFinetuneOutputForRuntime(
      '/Users/marcos/projects/gemma1b-tts-integration/job_output/whisper-gemma-run',
      { FLY_APP_NAME: 'parle-ai-gateway' } as NodeJS.ProcessEnv,
    );

    expect(output).toBe('/tmp/ai-gateway-finetune/whisper-gemma-run');
  });

  it('keeps already server-local output paths on Fly', () => {
    const output = resolveFinetuneOutputForRuntime(
      '/tmp/ai-gateway-finetune/whisper-gemma-run',
      { FLY_APP_NAME: 'parle-ai-gateway' } as NodeJS.ProcessEnv,
    );

    expect(output).toBe('/tmp/ai-gateway-finetune/whisper-gemma-run');
  });

  it('keeps macOS output paths for local CLI runs', () => {
    const output = resolveFinetuneOutputForRuntime(
      '/Users/marcos/projects/gemma1b-tts-integration/job_output/whisper-gemma-run',
      {} as NodeJS.ProcessEnv,
    );

    expect(output).toBe('/Users/marcos/projects/gemma1b-tts-integration/job_output/whisper-gemma-run');
  });
});
