/**
 * Stryker mutation testing configuration for AI Gateway.
 *
 * Mutation testing verifies that tests catch behavior changes instead of only
 * executing lines. It is intentionally kept out of the default PR gate because
 * it is expensive on this codebase; run it with `bun run quality:mutation` or
 * `bun run quality:ai:deep` before high-risk AI-generated changes.
 *
 * Usage:
 *   bun run quality:mutation
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: 'npm',
  testRunner: 'command',
  commandRunner: {
    command: 'bun run test:unit',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/index.ts',
    '!src/types/**/*',
    '!src/constants/**/*',
    '!src/browser/**/*',
    '!src/modules/browser/**/*',
  ],
  files: [
    'src/**/*.ts',
    '__tests__/**/*.ts',
    'vitest.config.ts',
    'vitest.unit.config.ts',
  ],
  ignorePatterns: [
    '.git',
    'node_modules',
    'dist',
    'coverage',
    '.next',
    '**/*.d.ts',
  ],
  reporters: ['html', 'clear-text', 'json'],
  htmlReporter: {
    baseDir: 'reports/mutation',
  },
  concurrency: 4,
  timeoutMS: 30_000,
  buildCommand: 'bun run build',
  ignoreStatic: true,
  tempDirName: '.stryker-tmp',
};

module.exports = config;
