import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EDGE_IMAGE, replicaCloudInit, vastReplicaInit } from '../../../src/deployments/cloud-init';
import { BUILTIN_PROFILES, COTURN_IMAGE } from '../../../src/deployments/profiles';
import { buildSpec } from '../../../src/deployments/spec';

const ROOT = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const PIPE_TO_SHELL = /curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/;
const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));

describe('S13: supply chain', () => {
  it('CI installs a fixed Bun, never latest', () => {
    for (const file of readdirSync(join(ROOT, '.github/workflows'))) {
      for (const [, version] of read(`.github/workflows/${file}`).matchAll(/bun-version:\s*(\S+)/g)) expect(version, file).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('production images build from bases pinned by digest', () => {
    for (const file of ['Dockerfile', 'Dockerfile.production', 'docker/aigw-edge/Dockerfile', 'docker/speech-stack/Dockerfile', 'docker/whisper-stt/Dockerfile']) {
      const froms = [...read(file).matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);
      expect(froms.length, file).toBeGreaterThan(0);
      for (const ref of froms) expect(ref, `${file}: ${ref}`).toMatch(/@(sha256:[0-9a-f]{64}|\$\{[A-Z_]+_DIGEST\})$/);
    }
    expect(DEFAULT_EDGE_IMAGE).toMatch(DIGEST);
    expect(COTURN_IMAGE).toMatch(DIGEST);
  });

  it('no machine boot pipes a download into a shell', () => {
    const speech = buildSpec('s', { image: 'me/app:1', port: 8000, machineType: 'L4-1-24G', gpu: true }, { profiles });
    const vast = buildSpec('v', { provider: 'vast', image: 'vastai/base', bootScript: 'serve', port: 8010, machineType: 'RTX 5090' }, { profiles });
    const boots = [
      replicaCloudInit(speech, 'x'.repeat(32)), replicaCloudInit({ ...speech, realtime: {} }, 'x'.repeat(32)), vastReplicaInit(vast, 'x'.repeat(32)),
      ...BUILTIN_PROFILES.map(p => p.bootScript ?? ''), read('scripts/build-image-on-scaleway.ts'),
    ];
    for (const boot of boots) expect(boot).not.toMatch(PIPE_TO_SHELL);
  });

  it('baked Hugging Face models are pinned to a commit, the GGUF to its sha256', () => {
    for (const file of ['docker/speech-stack/Dockerfile', 'docker/whisper-stt/Dockerfile']) {
      const text = read(file);
      expect(text, file).toMatch(/^ARG LLM_REVISION=[0-9a-f]{40}$/m);
      expect(text, file).toMatch(/^ARG LLM_SHA256=[0-9a-f]{64}$/m);
      expect(text, file).toContain('echo "$LLM_SHA256  /models/llm/$LLM_FILE" | sha256sum -c -');
      expect(text, file).toMatch(/^ARG STT_REVISION=[0-9a-f]{40}$/m);
    }
    expect(read('docker/speech-stack/Dockerfile')).toMatch(/^ARG TTS_REVISION=[0-9a-f]{40}$/m);
  });

  it('context-mode (unused) is not a production dependency', () => {
    expect(JSON.parse(read('package.json')).dependencies).not.toHaveProperty('context-mode');
  });
});
