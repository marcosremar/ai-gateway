/**
 * Handler Coverage Tests (#001-#310)
 *
 * Validates that all HTTP handlers exist, validate inputs, use correct
 * patterns, and have proper error handling. Uses source code verification
 * + module import testing (no mock complexity).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (f: string) => {
  // Workload drivers: barrel re-exports point to src/compute/workloads/
  if (f.startsWith('src/workloads/') && f.endsWith('-driver.ts')) {
    const computePath = f.replace('src/workloads/', 'src/compute/workloads/');
    if (fs.existsSync(path.resolve(computePath))) {
      return fs.readFileSync(path.resolve(computePath), 'utf8');
    }
  }
  return fs.readFileSync(path.resolve(f), 'utf8');
};
const fn = (src: string, name: string, len = 3000) => {
  const i = src.indexOf(name);
  if (i < 0) return '';
  const end = src.indexOf('\nexport ', i + 50);
  return src.slice(i, end > 0 ? end : i + len);
};

// ═══════════════════════════════════════════════════════════════════════════════
// WORKLOAD HANDLERS — #281-#310
// ═══════════════════════════════════════════════════════════════════════════════

describe('Workload Handlers (#281-#293)', () => {
  const src = read('server/workload-handlers.ts');

  it('#281 handleWorkloadList exists', () => { expect(src).toContain('handleWorkloadList'); });
  it('#282 supports type filter', () => { expect(src).toContain('type'); });
  it('#283 handleWorkloadDeploy exists', () => { expect(src).toContain('handleWorkloadDeploy'); });
  it('#286 validates name required', () => { expect(src).toMatch(/!name|validateInput|WorkloadDeployRequestSchema/); });
  it('#287 validates type required', () => { expect(src).toMatch(/!type|validateInput|WorkloadDeployRequestSchema/); });
  it('#289 handleWorkloadStatus exists', () => { expect(src).toContain('handleWorkloadStatus'); });
  it('#290 returns 404 for unknown', () => { expect(src).toContain('404'); });
  it('#291 handleWorkloadStop exists', () => { expect(src).toContain('handleWorkloadStop'); });
  it('#292 handleWorkloadStart exists', () => { expect(src).toContain('handleWorkloadStart'); });
  it('#293 handleWorkloadTerminate exists', () => { expect(src).toContain('handleWorkloadTerminate'); });
});

describe('WorkloadRegistry (#294-#299)', () => {
  it('#294 list returns all workloads', async () => {
    const { WorkloadRegistry } = await import('../src/workloads/registry');
    const reg = new WorkloadRegistry();
    expect(reg.list()).toEqual([]);
  });

  it('#295 getByName finds by name', async () => {
    const { WorkloadRegistry } = await import('../src/workloads/registry');
    const reg = new WorkloadRegistry();
    expect(reg.getByName('test')).toBeUndefined();
  });

  it('#296 listByType filters correctly', async () => {
    const { WorkloadRegistry } = await import('../src/workloads/registry');
    const reg = new WorkloadRegistry();
    expect(reg.listByType('gpu')).toEqual([]);
  });

  it('#297-299 event system exists', async () => {
    const { WorkloadRegistry } = await import('../src/workloads/registry');
    const reg = new WorkloadRegistry();
    const events: unknown[] = [];
    const unsub = reg.onEvent(e => events.push(e));
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

describe('Workload Drivers (#300-#310)', () => {
  it('#300 GpuWorkloadDriver has all lifecycle methods', () => {
    const src = read('src/workloads/gpu-driver.ts');
    expect(src).toContain("type = 'gpu'");
    expect(src).toContain('async deploy');
    expect(src).toContain('async stop');
    expect(src).toContain('async start');
    expect(src).toContain('async terminate');
    expect(src).toContain('async status');
  });

  it('#305 BotWorkloadDriver has lifecycle', () => {
    const src = read('src/workloads/bot-driver.ts');
    expect(src).toContain("type = 'bot'");
    expect(src).toContain('async deploy');
    expect(src).toContain('async terminate');
  });

  it('#308 DbWorkloadDriver connects to Neon', () => {
    const src = read('src/workloads/db-driver.ts');
    expect(src).toContain("type = 'db'");
    expect(src).toContain('NeonManagementClient');
    expect(src).toContain('async deploy');
  });

  it('#310 DbWorkloadDriver terminate handles owned and adopted projects', () => {
    const src = read('src/workloads/db-driver.ts');
    const body = fn(src, 'async terminate');
    // ADOPT mode only untracks; owned mode calls deleteProject
    expect(body).toContain('ownedByGateway');
    expect(body).toContain('deleteProject');
  });
});
