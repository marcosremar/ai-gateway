import type { HashStore, SessionResolver, Logger } from '../deps';
import { defaultLogger } from '../logger';

const TEACHER_CACHE_TTL_MS = 5 * 60_000;

/** Heartbeat TTL in Redis: entries auto-expire after 30 min of no updates */
const HEARTBEAT_TTL_SECS = 30 * 60;

export class SessionTracker {
  private stateStore: HashStore;
  private sessionResolver: SessionResolver;
  private logger: Logger;
  /** Cache: studentId → teacherId (TTL: 5 min). Avoids repeated DB lookups. */
  private teacherCache = new Map<string, { teacherId: string | null; expiresAt: number }>();
  private lastTeacherCacheClean = Date.now();

  constructor(stateStore: HashStore, sessionResolver: SessionResolver, logger?: Logger) {
    this.stateStore = stateStore;
    this.sessionResolver = sessionResolver;
    this.logger = logger ?? defaultLogger;
  }

  /** Evict expired teacherCache entries to prevent unbounded growth. */
  private cleanTeacherCache(): void {
    const now = Date.now();
    if (now - this.lastTeacherCacheClean < 2 * 60_000) return; // every 2 min max
    this.lastTeacherCacheClean = now;
    for (const [key, entry] of this.teacherCache) {
      if (entry.expiresAt < now) this.teacherCache.delete(key);
    }
    // Hard cap: if cache exceeds 10k entries, evict oldest half
    if (this.teacherCache.size > 10_000) {
      const entries = Array.from(this.teacherCache.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < entries.length / 2; i++) {
        this.teacherCache.delete(entries[i][0]);
      }
    }
  }

  private key(userId: string): string {
    return `autoscaler:heartbeats:${userId}`;
  }

  /**
   * Report a heartbeat from an active conversation.
   * Heartbeats expire after windowMinutes of inactivity.
   */
  async reportSessionHeartbeat(userId: string, sessionKey: string): Promise<void> {
    await this.stateStore.hset(this.key(userId), sessionKey, String(Date.now()));
    // Also aggregate under teacher if this user is a student
    void this.aggregateToTeacher(userId, sessionKey).catch(e => console.warn('[session] teacher aggregation failed:', e instanceof Error ? e.message : e));
  }

  /**
   * Remove a heartbeat session (e.g. after a test completes).
   */
  async removeSessionHeartbeat(userId: string, sessionKey: string): Promise<void> {
    await this.stateStore.hdel(this.key(userId), sessionKey);
  }

  /**
   * Count active sessions: DB assigned activities + in-memory heartbeats.
   * Returns the maximum of DB sessions and heartbeat sessions.
   */
  async countActiveSessions(userId: string, windowMinutes: number): Promise<number> {
    const heartbeats = await this.countHeartbeatSessions(userId, windowMinutes);

    let dbSessions = 0;
    try {
      dbSessions = await this.sessionResolver.countDbSessions(userId, windowMinutes);
    } catch (err) {
      this.logger.warn('[autoscaler] Failed to count DB sessions:', err);
    }

    return Math.max(heartbeats, dbSessions);
  }

  private async countHeartbeatSessions(userId: string, windowMinutes: number): Promise<number> {
    const cutoff = Date.now() - windowMinutes * 60_000;
    const all = await this.stateStore.hgetall(this.key(userId));
    let count = 0;
    for (const [field, tsStr] of Object.entries(all)) {
      const ts = Number(tsStr);
      if (ts < cutoff) {
        // Cleanup expired — fire and forget
        void this.stateStore.hdel(this.key(userId), field).catch(e => console.warn('[session] expired session cleanup failed:', e instanceof Error ? e.message : e));
        continue;
      }
      count++;
    }
    return count;
  }

  /**
   * Resolve student→teacher and double-store heartbeat under teacher's ID.
   */
  private async aggregateToTeacher(userId: string, sessionKey: string): Promise<void> {
    this.cleanTeacherCache();
    const cached = this.teacherCache.get(userId);
    let teacherId: string | null;

    if (cached && cached.expiresAt > Date.now()) {
      teacherId = cached.teacherId;
    } else {
      try {
        teacherId = await this.sessionResolver.resolveTeacher(userId);
      } catch {
        teacherId = null;
      }
      this.teacherCache.set(userId, { teacherId, expiresAt: Date.now() + TEACHER_CACHE_TTL_MS });
    }

    if (!teacherId || teacherId === userId) return;

    // Store the student's heartbeat under the teacher's map (prefixed to avoid key collision)
    const teacherKey = `student:${userId}:${sessionKey}`;
    await this.stateStore.hset(this.key(teacherId), teacherKey, String(Date.now()));
  }
}
