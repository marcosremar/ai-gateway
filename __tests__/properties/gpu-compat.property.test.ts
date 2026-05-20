import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cudaVersionGte, estimateVramFromImage, parseCudaVersion } from '../../src/gpu-compat';

describe('GPU compatibility properties', () => {
  it('parses CUDA major/minor versions without losing numeric ordering', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 99 }),
        (major, minor) => {
          const parsed = parseCudaVersion(`${major}.${minor}`);
          expect(parsed.major).toBe(major);
          expect(parsed.minor).toBe(minor);
          expect(cudaVersionGte(`${major}.${minor}`, `${major}.${minor}`)).toBe(true);
        },
      ),
    );
  });

  it('keeps cudaVersionGte transitive for generated version triples', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 0, max: 99 }),
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 0, max: 99 }),
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 0, max: 99 }),
        ),
        ([majorA, minorA, majorB, minorB, majorC, minorC]) => {
          const versions = [
            { major: majorA, minor: minorA },
            { major: majorB, minor: minorB },
            { major: majorC, minor: minorC },
          ].sort((left, right) => right.major - left.major || right.minor - left.minor);

          const high = `${versions[0].major}.${versions[0].minor}`;
          const mid = `${versions[1].major}.${versions[1].minor}`;
          const low = `${versions[2].major}.${versions[2].minor}`;

          expect(cudaVersionGte(high, mid)).toBe(true);
          expect(cudaVersionGte(mid, low)).toBe(true);
          expect(cudaVersionGte(high, low)).toBe(true);
        },
      ),
    );
  });

  it('always returns a finite non-negative VRAM estimate for arbitrary image hints', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 60 }), { maxKeys: 6 }),
        fc.string({ maxLength: 120 }),
        (imageName, envVars, startCmd) => {
          const estimate = estimateVramFromImage(imageName, envVars, startCmd);
          expect(Number.isFinite(estimate.vramGb)).toBe(true);
          expect(estimate.vramGb).toBeGreaterThanOrEqual(0);
          expect(estimate.hint.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});
