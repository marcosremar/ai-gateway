import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { validateBuildContextPath } from '../../src/compute/image-builder/image-build-service';
import { collectFiles, isSensitiveBuildPath } from '../../src/compute/image-builder/github-repo';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('image builder security hardening', () => {
  it('rejects build contexts outside the allowed roots', () => {
    const allowedRoot = makeTempDir('ai-gateway-build-root-');
    const disallowedRoot = makeTempDir('ai-gateway-build-disallowed-');
    const disallowedChild = join(disallowedRoot, 'context');
    mkdirSync(disallowedChild, { recursive: true });

    try {
      expect(() => validateBuildContextPath(disallowedChild, [allowedRoot])).toThrow('allowed build root');
    } finally {
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(disallowedRoot, { recursive: true, force: true });
    }
  });

  it('excludes sensitive files from collected build context', () => {
    const root = makeTempDir('ai-gateway-build-sensitive-');
    mkdirSync(join(root, '.ssh'), { recursive: true });
    mkdirSync(join(root, '.babelcast'), { recursive: true });
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(root, 'app.txt'), 'hello\n');
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=secret\n');
    writeFileSync(join(root, '.ssh', 'id_rsa'), 'secret\n');
    writeFileSync(join(root, '.babelcast', 'github_token.json'), '{"token":"secret"}\n');

    try {
      const files = collectFiles(root).map((entry) => entry.path).sort();
      expect(files).toEqual(['Dockerfile', 'app.txt']);
      expect(isSensitiveBuildPath('.env')).toBe(true);
      expect(isSensitiveBuildPath('.ssh/id_rsa')).toBe(true);
      expect(isSensitiveBuildPath('.babelcast/github_token.json')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinks in the build context', () => {
    const root = makeTempDir('ai-gateway-build-symlink-');
    const external = makeTempDir('ai-gateway-build-external-');
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(external, 'secret.txt'), 'do-not-follow\n');
    symlinkSync(join(external, 'secret.txt'), join(root, 'linked-secret.txt'));

    try {
      expect(() => collectFiles(root)).toThrow('Symlinks are not allowed');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
