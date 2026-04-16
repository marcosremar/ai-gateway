/**
 * Unit tests for server/latency-db-migrate.ts.
 * Mocks: fs, bun:sqlite (dynamic import), and ../server/state (prisma).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks — must be defined before any imports ────────────────────────

const { mockPrisma, sqliteState } = vi.hoisted(() => {
  const mockPrisma = {
    hostLatency: {
      upsert: vi.fn(),
    },
    hostLatencyHistory: {
      create: vi.fn(),
    },
  };

  // Mutable state for the SQLite mock — tests set these before each run
  const sqliteState = {
    shouldThrow: false,
    hostRows: [] as unknown[],
    historyRows: [] as unknown[],
  };

  return { mockPrisma, sqliteState };
});

// Mock fs module
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

// Mock bun:sqlite — the dynamic import in migrateLatencyDbIfNeeded uses
// `await import('bun:sqlite' as string)`, which Vitest intercepts via this mock.
vi.mock('bun:sqlite', () => {
  class MockDatabase {
    constructor(_path: string, _opts?: unknown) {
      if (sqliteState.shouldThrow) {
        throw new Error('bun:sqlite not available');
      }
    }
    query(sql: string) {
      const rows = sql.includes('host_latency_history')
        ? sqliteState.historyRows
        : sqliteState.hostRows;
      return { all: () => rows };
    }
    close() {}
  }
  return { Database: MockDatabase };
});

vi.mock('../../server/state', () => ({
  prisma: mockPrisma,
  deployState:          { status: 'idle' },
  deploymentSM:         {},
  latencyRing:          [],
  latencyRingIdx:       0,
  setLatencyRingIdx:    vi.fn(),
  LATENCY_RING_SIZE:    1000,
  metricsCounters:      { requestsTotal: 0, errorsTotal: 0, dbLogFailures: 0, byStage: {}, byProvider: {}, totalInputTokens: 0, totalOutputTokens: 0 },
  providerMetrics:      {},
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { existsSync, renameSync } from 'fs';
import { migrateLatencyDbIfNeeded } from '../../server/latency-db-migrate';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockRenameSync = renameSync as ReturnType<typeof vi.fn>;

// ── Shared test data ──────────────────────────────────────────────────────────

const HOST_ROW_1 = {
  host_id: 'host-1', host_ip: '10.0.0.1', provider: 'runpod',
  gpu_name: 'RTX 4090', geolocation: 'us-east', price_usd: 0.5,
  direct_port: null, median_ms: 30, p90_ms: 50, stddev_ms: 5,
  success_rate: 1.0, last_probed_at: 1_700_000, probe_count: 10,
  consecutive_failures: 0, monitored: 1,
};
const HOST_ROW_2 = {
  host_id: 'host-2', host_ip: '2.2.2.2', provider: 'vast',
  gpu_name: 'A100', geolocation: 'eu', price_usd: 0.8,
  direct_port: null, median_ms: 20, p90_ms: 35, stddev_ms: 2,
  success_rate: 1.0, last_probed_at: 1_500_000, probe_count: 5,
  consecutive_failures: 0, monitored: 1,
};
const HISTORY_ROW_1 = {
  id: 1, host_id: 'host-1', probed_at: 1_700_000, median_ms: 30, p90_ms: 50, samples: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset sqlite state to clean defaults
  sqliteState.shouldThrow = false;
  sqliteState.hostRows    = [];
  sqliteState.historyRows = [];
  // Suppress console noise in tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('migrateLatencyDbIfNeeded', () => {
  it('skips if DB_PATH does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await migrateLatencyDbIfNeeded();

    expect(mockPrisma.hostLatency.upsert).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it('skips if .migrated marker already exists', async () => {
    // DB_PATH exists, but DONE_MARKER also exists → skip
    mockExistsSync
      .mockReturnValueOnce(true)   // DB_PATH
      .mockReturnValueOnce(true);  // DONE_MARKER

    await migrateLatencyDbIfNeeded();

    expect(mockPrisma.hostLatency.upsert).not.toHaveBeenCalled();
  });

  it('returns early gracefully if bun:sqlite throws on Database construction', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    sqliteState.shouldThrow = true;

    await migrateLatencyDbIfNeeded();

    // No prisma calls — function returned early after catching sqlite error
    expect(mockPrisma.hostLatency.upsert).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it('upserts hosts and creates history rows from mock SQLite data', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    sqliteState.hostRows    = [HOST_ROW_1];
    sqliteState.historyRows = [HISTORY_ROW_1];

    mockPrisma.hostLatency.upsert.mockResolvedValue({});
    mockPrisma.hostLatencyHistory.create.mockResolvedValue({});
    mockRenameSync.mockReturnValue(undefined);

    await migrateLatencyDbIfNeeded();

    expect(mockPrisma.hostLatency.upsert).toHaveBeenCalledOnce();
    const upsertCall = mockPrisma.hostLatency.upsert.mock.calls[0][0];
    expect(upsertCall.where).toEqual({ hostId: 'host-1' });
    expect(upsertCall.create.hostId).toBe('host-1');
    expect(upsertCall.create.provider).toBe('runpod');
    expect(upsertCall.create.monitored).toBe(true);     // 1 → true
    expect(upsertCall.create.lastProbedAt).toBe(BigInt(1_700_000));

    expect(mockPrisma.hostLatencyHistory.create).toHaveBeenCalledOnce();
    const histCall = mockPrisma.hostLatencyHistory.create.mock.calls[0][0];
    expect(histCall.data.hostId).toBe('host-1');
    expect(histCall.data.samples).toBe(5);

    expect(mockRenameSync).toHaveBeenCalledOnce();
  });

  it('skips a failing host and continues migrating other hosts', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    sqliteState.hostRows    = [HOST_ROW_1, HOST_ROW_2];
    sqliteState.historyRows = [];

    // First host fails, second succeeds
    mockPrisma.hostLatency.upsert
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValueOnce({});
    mockRenameSync.mockReturnValue(undefined);

    await migrateLatencyDbIfNeeded();

    // Both hosts were attempted
    expect(mockPrisma.hostLatency.upsert).toHaveBeenCalledTimes(2);
    // Rename still happens — migration completes despite partial failure
    expect(mockRenameSync).toHaveBeenCalledOnce();
  });

  it('does not insert history rows for skipped hosts', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    // Only one host — it will fail
    sqliteState.hostRows = [{
      host_id: 'host-fail', host_ip: '1.1.1.1', provider: 'vast',
      gpu_name: 'A100', geolocation: 'us', price_usd: 1.0,
      direct_port: null, median_ms: null, p90_ms: null, stddev_ms: null,
      success_rate: 0, last_probed_at: 0, probe_count: 0,
      consecutive_failures: 0, monitored: 0,
    }];
    sqliteState.historyRows = [
      { id: 1, host_id: 'host-fail', probed_at: 1000, median_ms: 20, p90_ms: 30, samples: 3 },
    ];

    // The host fails to upsert → hostsDone stays 0
    mockPrisma.hostLatency.upsert.mockRejectedValueOnce(new Error('error'));
    mockRenameSync.mockReturnValue(undefined);

    await migrateLatencyDbIfNeeded();

    // migratedHostIds = hostRows.slice(0, 0) = [] → no history inserted
    expect(mockPrisma.hostLatencyHistory.create).not.toHaveBeenCalled();
  });
});
