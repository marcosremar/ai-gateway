import { describe, expect, it } from 'vitest';
import { compareSizes, GROWTH_TOLERANCE, MIN_GROWTH_BYTES, nextBaseline, type Baseline } from '../../scripts/bundle-size-lib';

const KB = 1024;
const base: Baseline = { index: { raw: 1400 * KB, gzip: 300 * KB }, client: { raw: 50 * KB, gzip: 12 * KB } };

describe('bundle size ratchet', () => {
  it('passes when nothing grew past the tolerance', () => {
    expect(compareSizes(base, { index: { raw: 1405 * KB, gzip: 301 * KB }, client: { raw: 49 * KB, gzip: 12 * KB } })).toEqual([]);
  });

  it('fails an entry that grew past both the relative tolerance and the absolute floor', () => {
    const raw = Math.ceil(1400 * KB * (1 + GROWTH_TOLERANCE)) + MIN_GROWTH_BYTES;
    const problems = compareSizes(base, { index: { raw, gzip: 300 * KB }, client: base.client });
    expect(problems.map((p) => [p.entry, p.kind])).toEqual([['index', 'grew']]);
    expect(problems[0].message).toContain('--accept-growth');
  });

  it('does not fail a small entry for growth under the absolute floor, even if large in percent', () => {
    expect(compareSizes(base, { index: base.index, client: { raw: 50 * KB + MIN_GROWTH_BYTES - 1, gzip: 12 * KB } })).toEqual([]);
  });

  it('checks gzip on its own (a change can bloat gzip without moving raw much)', () => {
    const problems = compareSizes(base, { index: { raw: 1400 * KB, gzip: 340 * KB }, client: base.client });
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('index gzip grew')]);
  });

  it('fails a new entry with no baseline, a stale baseline entry, and an entry that was not built', () => {
    const problems = compareSizes(base, { index: null, deployments: { raw: KB, gzip: KB } });
    expect(problems.map((p) => [p.entry, p.kind])).toEqual([
      ['index', 'missing-build'], ['deployments', 'missing-baseline'], ['client', 'stale-baseline'],
    ]);
  });

  it('update only tightens: a shrunk entry locks in its gain, growth and new entries are refused', () => {
    const { baseline, refused } = nextBaseline(base, {
      index: { raw: 1300 * KB, gzip: 290 * KB },
      client: { raw: 80 * KB, gzip: 20 * KB },
      deployments: { raw: KB, gzip: KB },
    });
    expect(baseline.index).toEqual({ raw: 1300 * KB, gzip: 290 * KB });
    expect(baseline.client).toEqual(base.client);
    expect(baseline.deployments).toBeUndefined();
    expect(refused.sort()).toEqual(['client', 'deployments']);
  });

  it('update with --accept-growth records the reason on what grew and keeps the rest', () => {
    const { baseline, refused } = nextBaseline(base, {
      index: { raw: 1450 * KB, gzip: 310 * KB }, client: { raw: 40 * KB, gzip: 10 * KB }, deployments: { raw: KB, gzip: KB },
    }, 'deployments: Vast backend');
    expect(refused).toEqual([]);
    expect(baseline.index).toEqual({ raw: 1450 * KB, gzip: 310 * KB, reason: 'deployments: Vast backend' });
    expect(baseline.deployments?.reason).toBe('deployments: Vast backend');
    expect(baseline.client).toEqual({ raw: 40 * KB, gzip: 10 * KB });
  });

  it('update drops entries that are no longer built', () => {
    expect(Object.keys(nextBaseline(base, { index: base.index }).baseline)).toEqual(['index']);
  });
});
