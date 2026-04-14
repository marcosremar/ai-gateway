#!/usr/bin/env bun
/**
 * Dead Code Detector — finds unused test files and dead code.
 *
 * Fixes: #28 (remove dead test code)
 *
 * Usage:
 *   bun run scripts/detect-dead-code.ts --dry-run
 *   bun run scripts/detect-dead-code.ts --remove
 */

import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = '__tests__';
const SRC_DIR = 'src';

interface DeadFile {
  path: string;
  reason: string;
  sizeBytes: number;
}

const deadFiles: DeadFile[] = [];

// 1. Find empty test files
function findEmptyTests(dir: string) {
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      findEmptyTests(fullPath);
    } else if (file.endsWith('.test.ts') && stat.size < 100) {
      deadFiles.push({ path: fullPath, reason: 'Empty test file (<100 bytes)', sizeBytes: stat.size });
    }
  }
}

// 2. Find test files without corresponding source files
function findOrphanTests(dir: string) {
  const files = readdirSync(dir);
  for (const file of files) {
    if (!file.endsWith('.test.ts')) continue;
    const baseName = file.replace('.test.ts', '');
    // Check if source file exists
    const srcPath = join(SRC_DIR, `${baseName}.ts`);
    if (!existsSync(srcPath)) {
      deadFiles.push({ path: join(dir, file), reason: 'No corresponding source file', sizeBytes: statSync(join(dir, file)).size });
    }
  }
}

findEmptyTests(TESTS_DIR);
findOrphanTests(TESTS_DIR);

// Report
console.log(`\n🔍 Dead Code Detection Results`);
console.log('═'.repeat(50));
console.log(`Found ${deadFiles.length} potentially dead files:\n`);

let totalBytes = 0;
for (const file of deadFiles) {
  console.log(`  ${file.path}`);
  console.log(`    Reason: ${file.reason}`);
  console.log(`    Size: ${file.sizeBytes} bytes\n`);
  totalBytes += file.sizeBytes;
}

console.log(`Total dead code: ${(totalBytes / 1024).toFixed(1)} KB`);

if (process.argv.includes('--remove')) {
  console.log('\n🗑️  Removing dead files...');
  const { rmSync } = require('fs');
  for (const file of deadFiles) {
    rmSync(file.path);
    console.log(`  Removed: ${file.path}`);
  }
  console.log(`\n✅ Removed ${deadFiles.length} files`);
} else {
  console.log('\n💡 Run with --remove to delete these files');
}
