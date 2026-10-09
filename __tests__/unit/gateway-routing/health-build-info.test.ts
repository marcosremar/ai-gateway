import { describe, expect, it } from 'vitest';
import { DEFAULT_EDGE_IMAGE } from '../../../src/deployments/cloud-init';
import { buildImages } from '../../../src/deployments/build-images';
import { minimalHealth } from '../../../src/gateway/proxy/health-view';

describe('GET /health says which code runs', () => {
  it('an unstamped build reports null, never a guess', () => {
    expect(minimalHealth({})).toMatchObject({ status: 'ok', version: null, commit: null, builtAt: null });
  });

  it('a stamped build reports its commit and build time; GATEWAY_VERSION still names the version', () => {
    const build = { commit: '72552d689faa969f7d1379406fe1407079e795a4', builtAt: '2026-10-08T20:00:00.000Z' };
    expect(minimalHealth({}, build)).toMatchObject({ version: '72552d689faa', ...build });
    expect(minimalHealth({ GATEWAY_VERSION: 'v9' }, build)).toMatchObject({ version: 'v9', commit: build.commit });
    expect(minimalHealth({ RAILWAY_GIT_COMMIT_SHA: 'abc123' })).toMatchObject({ commit: 'abc123', builtAt: null });
  });

  it('the admin details carry the image tags the build points at: edge sidecar, profiles, declared deployments (SPEECH_IMAGE honoured)', () => {
    const images = (env: Record<string, string>) => buildImages(env) as { edge: string; profiles: Record<string, string>; declared: Record<string, string> };
    expect(images({}).edge).toBe(DEFAULT_EDGE_IMAGE);
    expect(images({}).profiles['speech-stack']).toMatch(/^rg\.fr-par\.scw\.cloud\/aigw\/speech-stack:\d{8}-\d{4}$/);
    expect(images({}).declared['parle-speech']).toMatch(/speech-stack:/);
    expect(images({ SPEECH_IMAGE: '20991231-0000' }).declared['parle-speech']).toBe('rg.fr-par.scw.cloud/aigw/speech-stack:20991231-0000');
    expect(minimalHealth({})).not.toHaveProperty('images');
  });
});
