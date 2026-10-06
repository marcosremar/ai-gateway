/**
 * Unit tests for AuditLogger — tamper-evident audit trail.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { AuditLogger, AUDIT_EVENTS } from '../../src/audit';

const tmpDir = os.tmpdir();
const created: string[] = [];

function tmpFile(): string {
  const path = join(tmpDir, `audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  created.push(path);
  return path;
}

afterEach(() => {
  for (const f of created.splice(0)) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
});

// ── log() ─────────────────────────────────────────────────────────────────────

describe('AuditLogger.log()', () => {
  it('appends a JSONL line to the file', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });
    expect(existsSync(path)).toBe(true);
  });

  it('round-trips basic event fields', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS', actor: 'user1', ip: '1.2.3.4' });

    const events = await logger.read();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('AUTH_SUCCESS');
    expect(events[0].actor).toBe('user1');
    expect(events[0].ip).toBe('1.2.3.4');
  });

  it('auto-injects timestamp when not provided', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    const before = Date.now();
    await logger.log({ event: 'AUTH_SUCCESS' });
    const after = Date.now();

    const events = await logger.read();
    const ts = new Date(events[0].timestamp as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('preserves custom timestamp when provided', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS', timestamp: '2024-01-15T12:00:00.000Z' });

    const events = await logger.read();
    expect(events[0].timestamp).toBe('2024-01-15T12:00:00.000Z');
  });

  it('appends multiple events as separate lines', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });
    await logger.log({ event: 'GPU_DEPLOY', actor: 'admin' });
    await logger.log({ event: 'CONFIG_CHANGE', actor: 'admin' });

    const events = await logger.read();
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('AUTH_SUCCESS');
    expect(events[1].event).toBe('GPU_DEPLOY');
    expect(events[2].event).toBe('CONFIG_CHANGE');
  });

  it('stores arbitrary extra fields', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'GPU_DEPLOY', provider: 'runpod', instanceId: 'abc123', costUsd: 0.42 });

    const events = await logger.read();
    expect(events[0].provider).toBe('runpod');
    expect(events[0].instanceId).toBe('abc123');
    expect(events[0].costUsd).toBe(0.42);
  });

  it('throws when the file path is invalid', async () => {
    const logger = new AuditLogger('/no/such/directory/audit.jsonl');
    await expect(logger.log({ event: 'AUTH_SUCCESS' })).rejects.toThrow('Audit log write failed');
  });

  it('each line includes a _checksum field', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });

    const { readFileSync } = require('fs');
    const raw = readFileSync(path, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    expect(typeof parsed._checksum).toBe('string');
    expect(parsed._checksum).toHaveLength(16);
  });
});

// ── read() ────────────────────────────────────────────────────────────────────

describe('AuditLogger.read()', () => {
  it('returns [] for non-existent file', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    const events = await logger.read();
    expect(events).toEqual([]);
  });

  it('returns [] for empty file', async () => {
    const path = tmpFile();
    writeFileSync(path, '');
    const logger = new AuditLogger(path);
    const events = await logger.read();
    expect(events).toEqual([]);
  });

  it('returns all events when lastN not specified', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    for (let i = 0; i < 5; i++) {
      await logger.log({ event: 'AUTH_SUCCESS', seq: i });
    }
    const events = await logger.read();
    expect(events).toHaveLength(5);
  });

  it('lastN returns only the last N events', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    for (let i = 0; i < 10; i++) {
      await logger.log({ event: 'AUTH_SUCCESS', seq: i });
    }
    const events = await logger.read({ lastN: 3 });
    expect(events).toHaveLength(3);
    expect(events[0].seq).toBe(7);
    expect(events[1].seq).toBe(8);
    expect(events[2].seq).toBe(9);
  });

  it('lastN larger than total returns all events', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });
    await logger.log({ event: 'AUTH_FAILURE' });
    const events = await logger.read({ lastN: 100 });
    expect(events).toHaveLength(2);
  });

  it('lastN=1 returns only the most recent event', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });
    await logger.log({ event: 'GPU_DEPLOY' });
    const events = await logger.read({ lastN: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('GPU_DEPLOY');
  });

  it('verifyChecksum=true (default) accepts valid log', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path, { verifyChecksum: true });
    await logger.log({ event: 'AUTH_SUCCESS', actor: 'alice' });
    await expect(logger.read()).resolves.toHaveLength(1);
  });

  it('detects tampering when a field is modified', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS', actor: 'alice' });

    // Tamper with the file: swap the actor
    const { readFileSync } = require('fs');
    const line = readFileSync(path, 'utf-8').trim();
    const entry = JSON.parse(line);
    entry.actor = 'mallory'; // tamper
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');

    await expect(logger.read()).rejects.toThrow('Audit log tampering detected');
  });

  it('detects tampering when event field is changed', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });

    const { readFileSync } = require('fs');
    const line = readFileSync(path, 'utf-8').trim();
    const entry = JSON.parse(line);
    entry.event = 'AUTH_FAILURE'; // tamper
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');

    await expect(logger.read()).rejects.toThrow('Audit log tampering detected');
  });

  it('detects tampering when _checksum is modified', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });

    const { readFileSync } = require('fs');
    const line = readFileSync(path, 'utf-8').trim();
    const entry = JSON.parse(line);
    entry._checksum = 'deadbeefcafe0000'; // forge checksum
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');

    await expect(logger.read()).rejects.toThrow('Audit log tampering detected');
  });

  it('skips checksum verification when verifyChecksum=false', async () => {
    const path = tmpFile();
    const writer = new AuditLogger(path);
    await writer.log({ event: 'AUTH_SUCCESS', actor: 'alice' });

    // Tamper
    const { readFileSync } = require('fs');
    const line = readFileSync(path, 'utf-8').trim();
    const entry = JSON.parse(line);
    entry.actor = 'mallory';
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');

    const reader = new AuditLogger(path, { verifyChecksum: false });
    const events = await reader.read();
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe('mallory'); // no throw — verification skipped
  });

  it('survives a file with trailing newline', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });
    const { readFileSync } = require('fs');
    const content = readFileSync(path, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    await expect(logger.read()).resolves.toHaveLength(1);
  });

  it('read back preserves event ordering', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    const types = ['AUTH_SUCCESS', 'GPU_DEPLOY', 'GPU_STOP', 'CONFIG_CHANGE', 'AUTH_FAILURE'] as const;
    for (const event of types) {
      await logger.log({ event });
    }
    const events = await logger.read();
    expect(events.map((e) => e.event)).toEqual(types);
  });
});

// ── needsRotation() ───────────────────────────────────────────────────────────

describe('AuditLogger.needsRotation()', () => {
  it('returns false for non-existent file', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    expect(await logger.needsRotation()).toBe(false);
  });

  it('returns false when file is below the size threshold', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path, { maxSizeBytes: 1_000_000 });
    await logger.log({ event: 'AUTH_SUCCESS' });
    expect(await logger.needsRotation()).toBe(false);
  });

  it('returns true when file size meets the threshold', async () => {
    const path = tmpFile();
    // Set a tiny threshold so a single log line exceeds it
    const logger = new AuditLogger(path, { maxSizeBytes: 1 });
    await logger.log({ event: 'AUTH_SUCCESS' });
    expect(await logger.needsRotation()).toBe(true);
  });

  it('returns true when file size equals the threshold exactly', async () => {
    const path = tmpFile();
    // Write known content to get exact size
    writeFileSync(path, 'X');
    const logger = new AuditLogger(path, { maxSizeBytes: 1 });
    expect(await logger.needsRotation()).toBe(true);
  });

  it('uses default 100MB threshold when maxSizeBytes not set', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: 'AUTH_SUCCESS' });
    // File is tiny, far below 100MB
    expect(await logger.needsRotation()).toBe(false);
  });
});

// ── AUDIT_EVENTS constants ────────────────────────────────────────────────────

describe('AUDIT_EVENTS', () => {
  it('exports the expected event type constants', () => {
    expect(AUDIT_EVENTS.AUTH_SUCCESS).toBe('AUTH_SUCCESS');
    expect(AUDIT_EVENTS.AUTH_FAILURE).toBe('AUTH_FAILURE');
    expect(AUDIT_EVENTS.GPU_DEPLOY).toBe('GPU_DEPLOY');
    expect(AUDIT_EVENTS.GPU_STOP).toBe('GPU_STOP');
    expect(AUDIT_EVENTS.GPU_TERMINATE).toBe('GPU_TERMINATE');
    expect(AUDIT_EVENTS.CONFIG_CHANGE).toBe('CONFIG_CHANGE');
    expect(AUDIT_EVENTS.API_KEY_ROTATE).toBe('API_KEY_ROTATE');
    expect(AUDIT_EVENTS.BUDGET_ALERT).toBe('BUDGET_ALERT');
    expect(AUDIT_EVENTS.RATE_LIMIT_HIT).toBe('RATE_LIMIT_HIT');
    expect(AUDIT_EVENTS.PROVIDER_SWITCH).toBe('PROVIDER_SWITCH');
  });

  it('can be used as event values in log()', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    await logger.log({ event: AUDIT_EVENTS.GPU_DEPLOY, actor: 'admin' });

    const events = await logger.read();
    expect(events[0].event).toBe('GPU_DEPLOY');
  });
});

// ── Concurrent writes ─────────────────────────────────────────────────────────

describe('concurrent log()', () => {
  it('all events survive concurrent appends', async () => {
    const path = tmpFile();
    const logger = new AuditLogger(path);
    // Fire 10 concurrent logs
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        logger.log({ event: 'AUTH_SUCCESS', seq: i }),
      ),
    );
    const events = await logger.read();
    expect(events).toHaveLength(10);
  });
});
