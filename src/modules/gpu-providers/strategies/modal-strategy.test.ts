import { describe, expect, it } from 'bun:test';
import { resolve } from 'path';
import { modalStrategy } from './modal-strategy';

describe('modalStrategy.resolveImage', () => {
  it('keeps a caller-provided .py path verbatim', () => {
    const out = modalStrategy.resolveImage('/abs/path/custom.py');
    expect(out).toBe('/abs/path/custom.py');
  });

  it('maps a known registry image to its Modal app script', () => {
    const out = modalStrategy.resolveImage('marcosremar/trellis2:latest');
    expect(out).toBe(resolve(process.cwd(), 'dockers/modal/sceneforge_trellis2.py'));
  });

  it('strips the :tag suffix before lookup', () => {
    const tagged = modalStrategy.resolveImage('marcosremar/trellis2:dev');
    const untagged = modalStrategy.resolveImage('marcosremar/trellis2');
    expect(tagged).toBe(untagged);
  });

  it('strips a @sha256:... digest suffix before lookup', () => {
    const out = modalStrategy.resolveImage('marcosremar/trellis2@sha256:deadbeef');
    expect(out).toBe(resolve(process.cwd(), 'dockers/modal/sceneforge_trellis2.py'));
  });

  it('falls back to babelcast.py for unknown images and emits a warning', () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (line: string) => {
      warned.push(line);
    };
    try {
      const out = modalStrategy.resolveImage('marcosremar/qwen3-tts:latest');
      expect(out).toBe(resolve(process.cwd(), 'dockers/modal/babelcast.py'));
      expect(warned.some((l) => l.includes('no Modal app mapped'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it('does not strip a registry port (host:5000/img is not a tag)', () => {
    // localhost:5000/marcosremar/trellis2 should NOT collapse to just
    // "localhost:5000/marcosremar" — that would never match a mapping.
    const out = modalStrategy.resolveImage('localhost:5000/marcosremar/trellis2');
    expect(out).toBe(resolve(process.cwd(), 'dockers/modal/babelcast.py'));
    // (no mapping defined for the port-prefixed form — fallback is correct)
  });

  it('returns the babelcast fallback for an empty image string', () => {
    const out = modalStrategy.resolveImage('');
    expect(out).toBe(resolve(process.cwd(), 'dockers/modal/babelcast.py'));
  });
});
