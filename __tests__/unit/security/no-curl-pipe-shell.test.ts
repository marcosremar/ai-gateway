import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../../src');
const PIPE_TO_SHELL = /(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|sh|py)$/.test(name) ? [path] : [];
  });
}

describe('no boot script pipes a download into a shell', () => {
  it('src/ installs from distro or pinned packages, never curl | sh', () => {
    const offenders = files(SRC).flatMap(path => readFileSync(path, 'utf8').split('\n')
      .map((line, i) => (PIPE_TO_SHELL.test(line) ? `${path.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}` : null))
      .filter((hit): hit is string => hit !== null));
    expect(offenders).toEqual([]);
  });
});
