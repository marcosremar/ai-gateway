// Bundle size ratchet — pure comparison logic (no I/O), unit-tested in __tests__/unit/bundle-size-ratchet.test.ts.
//
// Why a ratchet instead of a fixed budget: the old CI step capped dist/index.js at 512 KB, a number with no stated
// origin, while the library entry (src/index.ts re-exports createGateway, the autoscaler and every GPU/cloud provider)
// had already grown to ~1.4 MB. A cap every PR fails catches nothing. The ratchet records what each entry weighs today
// and fails when one grows past a small tolerance, so unexpected growth (a stray heavy import) shows up in the PR that
// caused it; shrinking tightens the baseline, and deliberate growth must be accepted with a written reason.

export interface EntrySize {
  /** Uncompressed bytes of dist/<entry>.js (ESM). */
  raw: number;
  /** gzip -9 bytes of the same file: closer to what a consumer downloads. */
  gzip: number;
}

export interface BaselineEntry extends EntrySize {
  /** Why the entry was allowed to grow (set by --accept-growth); absent when it only ever shrank. */
  reason?: string;
}

export type Baseline = Record<string, BaselineEntry>;

/** Relative growth tolerated without a baseline change (build noise, tiny fixes). */
export const GROWTH_TOLERANCE = 0.02;
/** …but never fail for less than this absolute growth: a 3 KB entry growing 100 bytes is not a regression. */
export const MIN_GROWTH_BYTES = 8 * 1024;

export interface Problem {
  entry: string;
  kind: 'grew' | 'missing-baseline' | 'stale-baseline' | 'missing-build';
  message: string;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function grewTooMuch(before: number, after: number): boolean {
  return after - before > MIN_GROWTH_BYTES && after > before * (1 + GROWTH_TOLERANCE);
}

/** Every reason the measured build does not match the baseline. Empty = pass. */
export function compareSizes(baseline: Baseline, measured: Record<string, EntrySize | null>): Problem[] {
  const problems: Problem[] = [];
  for (const [entry, size] of Object.entries(measured)) {
    const base = baseline[entry];
    if (!size) {
      problems.push({ entry, kind: 'missing-build', message: `dist/${entry}.js was not built (run \`bun run build\` first)` });
      continue;
    }
    if (!base) {
      problems.push({ entry, kind: 'missing-baseline',
        message: `new entry ${entry} (${kb(size.raw)}) has no baseline: run \`bun run quality:bundle:update -- --accept-growth "<why>"\`` });
      continue;
    }
    for (const field of ['raw', 'gzip'] as const) {
      if (grewTooMuch(base[field], size[field])) {
        problems.push({ entry, kind: 'grew',
          message: `${entry} ${field} grew ${kb(base[field])} → ${kb(size[field])} (+${kb(size[field] - base[field])}); `
            + 'find the import that pulled it in, or accept it with `bun run quality:bundle:update -- --accept-growth "<why>"`' });
      }
    }
  }
  for (const entry of Object.keys(baseline)) {
    if (!(entry in measured)) {
      problems.push({ entry, kind: 'stale-baseline', message: `baseline lists ${entry}, which is no longer a tsup entry: run \`bun run quality:bundle:update\`` });
    }
  }
  return problems;
}

/**
 * The next baseline. Without `acceptGrowth` it only tightens: each entry keeps the smaller of baseline and measured
 * (an entry that shrank locks in its gain), stale entries are dropped, and new or grown entries are refused (returned
 * in `refused`). With `acceptGrowth` the measured size is taken as is and the reason is recorded on what grew.
 */
export function nextBaseline(baseline: Baseline, measured: Record<string, EntrySize>, acceptGrowth?: string):
  { baseline: Baseline; refused: string[] } {
  const next: Baseline = {};
  const refused: string[] = [];
  for (const entry of Object.keys(measured).sort()) {
    const size = measured[entry];
    const base = baseline[entry];
    if (!base) {
      if (acceptGrowth) next[entry] = { ...size, reason: acceptGrowth };
      else refused.push(entry);
      continue;
    }
    const grew = size.raw > base.raw || size.gzip > base.gzip;
    if (grew && acceptGrowth) {
      next[entry] = { ...size, reason: acceptGrowth };
    } else {
      next[entry] = { raw: Math.min(base.raw, size.raw), gzip: Math.min(base.gzip, size.gzip), ...(base.reason ? { reason: base.reason } : {}) };
      if (grew && grewTooMuch(base.raw, size.raw)) refused.push(entry);
    }
  }
  return { baseline: next, refused };
}

export function formatTable(baseline: Baseline, measured: Record<string, EntrySize | null>): string {
  const rows = Object.keys(measured).sort().map((entry) => {
    const size = measured[entry];
    const base = baseline[entry];
    const delta = size && base ? size.raw - base.raw : null;
    return `${entry.padEnd(16)} ${size ? kb(size.raw).padStart(10) : '—'.padStart(10)} ${size ? kb(size.gzip).padStart(10) : ''}`
      + `  ${base ? `baseline ${kb(base.raw)}` : 'no baseline'}${delta !== null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${kb(delta)})` : ''}`;
  });
  return [`${'entry'.padEnd(16)} ${'raw'.padStart(10)} ${'gzip'.padStart(10)}`, ...rows].join('\n');
}
