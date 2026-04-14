#!/usr/bin/env bun
/**
 * Test categorization script.
 *
 * Analyzes all test files in __tests__/ and categorizes them by type:
 * - unit: Tests that don't require external services
 * - integration: Tests that require mock services or local dependencies
 * - e2e: Tests that require running services (gateway, GPU)
 * - load: Load/benchmark tests
 *
 * Creates a manifest file and optionally moves files into subdirectories.
 *
 * Usage:
 *   bun run scripts/categorize-tests.ts --dry-run    # Show plan without moving
 *   bun run scripts/categorize-tests.ts --apply      # Actually move files
 */

import { readdirSync, existsSync, mkdirSync, renameSync, readFileSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = '__tests__';
const MANIFEST_FILE = '__tests__/test-manifest.json';

type TestCategory = 'unit' | 'integration' | 'e2e' | 'load';

interface TestFile {
  name: string;
  category: TestCategory;
  confidence: number; // 0-1, how confident we are in the categorization
}

/**
 * Categorize a test file based on its name and content.
 */
function categorizeTestFile(filename: string, content?: string): TestFile {
  const name = filename.toLowerCase();

  // Heuristics based on filename patterns
  if (name.includes('unit') || name.includes('-unit.')) {
    return { name: filename, category: 'unit', confidence: 0.95 };
  }

  if (name.includes('integration') || name.includes('-integration.')) {
    return { name: filename, category: 'integration', confidence: 0.95 };
  }

  if (name.includes('e2e') || name.includes('-e2e.') || name.includes('real-api')) {
    return { name: filename, category: 'e2e', confidence: 0.9 };
  }

  if (name.includes('load') || name.includes('bench') || name.includes('stress') || name.includes('soak')) {
    return { name: filename, category: 'load', confidence: 0.9 };
  }

  if (name.includes('breaking-point') || name.includes('network-stress')) {
    return { name: filename, category: 'load', confidence: 0.85 };
  }

  // Content-based heuristics
  if (content) {
    if (content.includes('SKIP_GPU_TESTS') && content.includes('SKIP_LIVE_TESTS')) {
      // Uses both skip flags — likely a unit test
      if (content.includes('SKIP_GPU_TESTS: 1') || content.includes("SKIP_GPU_TESTS', '1'")) {
        return { name: filename, category: 'unit', confidence: 0.7 };
      }
    }

    if (content.includes('describe.skipIf') || content.includes('it.skipIf')) {
      // Conditional skip — might be integration
      if (content.includes('GROQ_API_KEY') || content.includes('RUNPOD_API_KEY')) {
        return { name: filename, category: 'integration', confidence: 0.6 };
      }
    }

    if (content.includes('http://localhost') || content.includes('startProxy')) {
      return { name: filename, category: 'integration', confidence: 0.7 };
    }

    if (content.includes('fetch(') && !content.includes('vi.mock') && !content.includes('mockFetch')) {
      return { name: filename, category: 'e2e', confidence: 0.6 };
    }
  }

  // Default: unit (safest assumption for fast CI)
  return { name: filename, category: 'unit', confidence: 0.5 };
}

/**
 * Analyze all test files and return categorized list.
 */
function analyzeTests(): TestFile[] {
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));
  const results: TestFile[] = [];

  for (const file of files) {
    const content = existsSync(join(TESTS_DIR, file))
      ? readFileSync(join(TESTS_DIR, file), 'utf-8')
      : undefined;

    results.push(categorizeTestFile(file, content));
  }

  return results;
}

/**
 * Print categorization summary.
 */
function printSummary(files: TestFile[]): void {
  const categories = { unit: 0, integration: 0, e2e: 0, load: 0 };

  for (const f of files) {
    categories[f.category]++;
  }

  console.log('\n📊 Test Categorization Summary');
  console.log('═'.repeat(40));
  console.log(`  Unit:       ${categories.unit} files`);
  console.log(`  Integration: ${categories.integration} files`);
  console.log(`  E2E:        ${categories.e2e} files`);
  console.log(`  Load:       ${categories.load} files`);
  console.log(`  Total:      ${files.length} files`);
  console.log('═'.repeat(40));

  // Files with low confidence
  const lowConfidence = files.filter((f) => f.confidence < 0.7);
  if (lowConfidence.length > 0) {
    console.log(`\n⚠️  ${lowConfidence.length} files with low confidence (manual review recommended):`);
    for (const f of lowConfidence) {
      console.log(`   ${f.name} (${(f.confidence * 100).toFixed(0)}% confident → ${f.category})`);
    }
  }
}

/**
 * Move files into category directories.
 */
function applyCategorization(files: TestFile[]): void {
  for (const file of files) {
    const src = join(TESTS_DIR, file.name);
    const destDir = join(TESTS_DIR, file.category);
    const dest = join(destDir, file.name);

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    if (existsSync(src) && src !== dest) {
      renameSync(src, dest);
      console.log(`  ${file.name} → ${file.category}/`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || !args.includes('--apply');

  console.log('🔍 Analyzing test files...\n');

  const files = analyzeTests();
  printSummary(files);

  if (dryRun) {
    console.log('\n📋 Dry run — no files moved.');
    console.log('   Run with --apply to actually move files.');
  } else {
    console.log('\n📦 Moving files into category directories...\n');
    applyCategorization(files);
    console.log('\n✅ Done!');
  }

  // Save manifest
  const manifest = {
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    files: files.map((f) => ({
      name: f.name,
      category: f.category,
      confidence: Math.round(f.confidence * 100),
    })),
  };

  const manifestPath = join(TESTS_DIR, MANIFEST_FILE.split('/').pop()!);
  const { writeFileSync } = await import('fs');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n📄 Manifest saved to ${manifestPath}`);
}

main().catch(console.error);
