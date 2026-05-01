import { describe, expect, it } from 'vitest';
import {
  isModalDeployScriptReference,
  validateDockerImageReference,
} from '../../src/preflight-checks';

describe('Docker image reference validation', () => {
  it('accepts valid Docker image references', () => {
    const refs = [
      'ubuntu',
      'python:3.11-slim',
      'marcosremar/hunyuan3d:latest',
      'ghcr.io/parle/ai-gateway:2026.05.01',
      'localhost:5000/team/image:tag',
      `owner/image@sha256:${'a'.repeat(64)}`,
    ];

    for (const ref of refs) {
      expect(validateDockerImageReference(ref), ref).toEqual({ ok: true });
    }
  });

  it('rejects malformed or unsafe image references before deploy', () => {
    const refs = [
      'https://docker.io/marcosremar/hunyuan3d:latest',
      'Owner/Image:latest',
      'owner/image:bad tag',
      'owner/image:latest;rm -rf /',
      `owner/image@sha256:${'z'.repeat(64)}`,
      '/owner/image:latest',
    ];

    for (const ref of refs) {
      const result = validateDockerImageReference(ref);
      expect(result.ok, ref).toBe(false);
      if (!result.ok) expect(result.error).toContain('Invalid dockerImage');
    }
  });

  it('allows Modal deploy scripts only when explicitly enabled', () => {
    expect(isModalDeployScriptReference('dockers/modal/babelcast.py')).toBe(true);
    expect(validateDockerImageReference('dockers/modal/babelcast.py').ok).toBe(false);
    expect(validateDockerImageReference('dockers/modal/babelcast.py', { allowModalDeployScript: true })).toEqual({ ok: true });
  });
});
