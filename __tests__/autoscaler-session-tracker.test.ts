/**
 * Tests for autoscaler/session-tracker.ts
 * - SessionTracker.reportSessionHeartbeat()
 * - SessionTracker.removeSessionHeartbeat()
 * - SessionTracker.countActiveSessions()
 * - Teacher aggregation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTracker } from '../src/autoscaler/session-tracker';
import type { HashStore, SessionResolver, Logger } from '../src/deps';

function makeHashStore() {
  const hashes = new Map<string, Record<string, string>>();
  return {
    hashes,
    async hset(key: string, field: string, value: string) {
      if (!hashes.has(key)) hashes.set(key, {});
      hashes.get(key)![field] = value;
    },
    async hdel(key: string, field: string) {
      if (hashes.has(key)) delete hashes.get(key)![field];
    },
    async hgetall(key: string) {
      return hashes.get(key) ?? {};
    },
  } satisfies HashStore & { hashes: Map<string, Record<string, string>> };
}

function makeSessionResolver(
  dbSessions = 0,
  teacherMap: Record<string, string | null> = {},
): SessionResolver {
  return {
    async countDbSessions(_userId, _windowMinutes) { return dbSessions; },
    async resolveTeacher(studentId) { return teacherMap[studentId] ?? null; },
  };
}

const silentLogger: Logger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('SessionTracker', () => {
  let store: ReturnType<typeof makeHashStore>;
  let resolver: SessionResolver;
  let tracker: SessionTracker;

  beforeEach(() => {
    store = makeHashStore();
    resolver = makeSessionResolver(0);
    tracker = new SessionTracker(store, resolver, silentLogger);
  });

  describe('reportSessionHeartbeat()', () => {
    it('stores heartbeat timestamp', async () => {
      const before = Date.now();
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      const key = 'autoscaler:heartbeats:user-1';
      const val = Number(store.hashes.get(key)?.['session-A']);
      expect(val).toBeGreaterThanOrEqual(before);
      expect(val).toBeLessThanOrEqual(Date.now());
    });

    it('stores multiple heartbeats per user', async () => {
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      await tracker.reportSessionHeartbeat('user-1', 'session-B');
      const key = 'autoscaler:heartbeats:user-1';
      expect(Object.keys(store.hashes.get(key) ?? {})).toHaveLength(2);
    });

    it('updates existing heartbeat', async () => {
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      const ts1 = Number(store.hashes.get('autoscaler:heartbeats:user-1')?.['session-A']);
      await new Promise(r => setTimeout(r, 5));
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      const ts2 = Number(store.hashes.get('autoscaler:heartbeats:user-1')?.['session-A']);
      expect(ts2).toBeGreaterThanOrEqual(ts1);
    });
  });

  describe('removeSessionHeartbeat()', () => {
    it('removes heartbeat', async () => {
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      await tracker.removeSessionHeartbeat('user-1', 'session-A');
      const key = 'autoscaler:heartbeats:user-1';
      expect(store.hashes.get(key)?.['session-A']).toBeUndefined();
    });

    it('is no-op when heartbeat does not exist', async () => {
      // Should not throw
      await expect(tracker.removeSessionHeartbeat('user-1', 'nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('countActiveSessions()', () => {
    it('counts active heartbeats within window', async () => {
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      await tracker.reportSessionHeartbeat('user-1', 'session-B');

      const count = await tracker.countActiveSessions('user-1', 10);
      expect(count).toBe(2);
    });

    it('returns 0 when no sessions', async () => {
      const count = await tracker.countActiveSessions('user-1', 10);
      expect(count).toBe(0);
    });

    it('skips expired heartbeats', async () => {
      // Inject an old heartbeat (2 hours ago)
      const oldTs = Date.now() - 2 * 60 * 60 * 1000;
      store.hashes.set('autoscaler:heartbeats:user-1', {
        'old-session': String(oldTs),
      });

      const count = await tracker.countActiveSessions('user-1', 10);
      expect(count).toBe(0);
    });

    it('returns DB count when higher than heartbeats', async () => {
      resolver = makeSessionResolver(5);
      tracker = new SessionTracker(store, resolver, silentLogger);

      // Only 1 heartbeat
      await tracker.reportSessionHeartbeat('user-1', 'session-A');

      const count = await tracker.countActiveSessions('user-1', 10);
      expect(count).toBe(5); // max(1, 5)
    });

    it('returns heartbeat count when higher than DB', async () => {
      resolver = makeSessionResolver(1);
      tracker = new SessionTracker(store, resolver, silentLogger);

      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      await tracker.reportSessionHeartbeat('user-1', 'session-B');
      await tracker.reportSessionHeartbeat('user-1', 'session-C');

      const count = await tracker.countActiveSessions('user-1', 10);
      expect(count).toBe(3); // max(3, 1)
    });

    it('continues when DB throws (logs warning)', async () => {
      const failingResolver: SessionResolver = {
        async countDbSessions() { throw new Error('DB error'); },
        async resolveTeacher() { return null; },
      };
      tracker = new SessionTracker(store, failingResolver, silentLogger);
      await tracker.reportSessionHeartbeat('user-1', 'session-A');

      const count = await tracker.countActiveSessions('user-1', 10);
      expect(count).toBe(1); // fallback to heartbeats
    });

    it('isolates sessions per user', async () => {
      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      await tracker.reportSessionHeartbeat('user-1', 'session-B');
      await tracker.reportSessionHeartbeat('user-2', 'session-C');

      const count1 = await tracker.countActiveSessions('user-1', 10);
      const count2 = await tracker.countActiveSessions('user-2', 10);
      expect(count1).toBe(2);
      expect(count2).toBe(1);
    });
  });

  describe('teacher aggregation', () => {
    it('stores student heartbeat under teacher', async () => {
      resolver = makeSessionResolver(0, { 'student-1': 'teacher-1' });
      tracker = new SessionTracker(store, resolver, silentLogger);

      await tracker.reportSessionHeartbeat('student-1', 'session-S');

      // Wait for the fire-and-forget aggregation
      await new Promise(r => setTimeout(r, 20));

      const teacherKey = 'autoscaler:heartbeats:teacher-1';
      const teacherData = store.hashes.get(teacherKey);
      expect(teacherData).toBeDefined();
      // Should have the student's session stored under teacher
      const hasSomeStudentEntry = Object.keys(teacherData ?? {}).some(k => k.includes('student-1'));
      expect(hasSomeStudentEntry).toBe(true);
    });

    it('does not aggregate when user is their own teacher', async () => {
      resolver = makeSessionResolver(0, { 'user-1': 'user-1' });
      tracker = new SessionTracker(store, resolver, silentLogger);

      await tracker.reportSessionHeartbeat('user-1', 'session-A');
      await new Promise(r => setTimeout(r, 20));

      // user-1's heartbeat key should exist
      const userKey = 'autoscaler:heartbeats:user-1';
      expect(store.hashes.has(userKey)).toBe(true);
      // Should NOT have a duplicate key (no extra key added since teacherId === userId)
      // Check that there's only one key in the hashes map
      const allKeys = [...store.hashes.keys()];
      expect(allKeys.filter(k => k.startsWith('autoscaler:heartbeats:user-1')).length).toBe(1);
    });

    it('caches teacher lookup', async () => {
      let calls = 0;
      const countingResolver: SessionResolver = {
        async countDbSessions() { return 0; },
        async resolveTeacher() { calls++; return 'teacher-1'; },
      };
      tracker = new SessionTracker(store, countingResolver, silentLogger);

      await tracker.reportSessionHeartbeat('student-1', 'session-A');
      await tracker.reportSessionHeartbeat('student-1', 'session-B');
      await new Promise(r => setTimeout(r, 20));

      // Should only call resolveTeacher once due to cache
      expect(calls).toBe(1);
    });
  });
});
