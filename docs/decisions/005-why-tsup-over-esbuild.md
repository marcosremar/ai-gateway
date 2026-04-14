# ADR-005: Why tsup Over Raw esbuild

**Status:** Accepted
**Date:** 2026-02-10
**Deciders:** Marcos

## Context

We needed a bundler for the library with ESM + CJS dual output, TypeScript compilation, and declaration generation. esbuild is fast but minimal; tsup wraps it with better ergonomics.

## Decision

**Use tsup** as the bundler.

### Reasons

1. **Zero-config TypeScript** — tsup handles TypeScript compilation, `.d.ts` generation, and source maps automatically.
2. **Multiple entry points** — We have 20+ entry points (`index`, `providers`, `autoscaler`, etc.) — tsup handles this via a simple `entry` config.
3. **Dual format output** — ESM + CJS in one command.
4. **esbuild speed** — tsup uses esbuild under the hood, so we get the speed.
5. **Tree-shaking** — Built-in `treeshake: true`.
6. **Clean builds** — `clean: true` removes old output automatically.

```typescript
// tsup.config.ts
export default defineConfig({
  entry: { index: 'src/index.ts', providers: 'src/providers/index.ts', ... },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
```

## Consequences

### Positive
- Fast builds (~2s for full bundle)
- Clean config for 20+ entry points
- Declaration files generated automatically

### Negative
- Slightly slower than raw esbuild (but still <5s)
- One more dependency in the chain

## Alternatives Considered

1. **Raw esbuild** — Faster but requires manual `.d.ts` generation (tsc)
2. **Rollup** — Better tree-shaking but much slower and complex config
3. **Webpack** — Overkill for a library, slow
4. **tsc --build** — No bundling, outputs mirror source tree

## References

- `tsup.config.ts`
- `package.json` (`build` script)
