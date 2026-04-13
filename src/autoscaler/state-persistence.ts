import type { GpuTierState, IdleTierState, BootingTierState, ReadyTierState, ScaleTrigger } from '../types';
import type { KvStore, Logger } from '../deps';
import { defaultLogger } from '../logger';

/** Redis key prefix for GPU tier states */
const KEY_PREFIX = 'gpu:tiers:';
/** TTL: 2 hours — longer than any reasonable idle grace period */
const TTL_SECS = 2 * 60 * 60;

function redisKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export class StatePersistence {
  private stateStore: KvStore;
  private logger: Logger;

  constructor(stateStore: KvStore, logger?: Logger) {
    this.stateStore = stateStore;
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Persist GPU tier states to Redis.
   * Only call on state transitions (idle↔booting↔ready) to avoid excessive writes.
   * TTL ensures orphaned keys are auto-cleaned if watchdog never runs.
   */
  async persistTierStates(userId: string, states: GpuTierState[]): Promise<void> {
    try {
      const hasActive = states.some((ts) => ts.state !== 'idle');
      if (!hasActive || states.length === 0) {
        await this.stateStore.del(redisKey(userId));
        return;
      }

      const serializable = states.map((ts): Record<string, unknown> => {
        if (ts.state === 'idle') {
          return {
            state: 'idle',
            tierIndex: ts.tierIndex,
            ...(ts.bootFailCount !== undefined ? { bootFailCount: ts.bootFailCount } : {}),
            ...(ts.cooldownUntil !== undefined ? { cooldownUntil: ts.cooldownUntil } : {}),
            ...(ts.unhealthy ? { unhealthy: ts.unhealthy } : {}),
          };
        }
        if (ts.state === 'booting') {
          return {
            state: 'booting',
            tierIndex: ts.tierIndex,
            endpoint: ts.endpoint,
            bootTriggeredAt: ts.bootTriggeredAt,
            trigger: ts.trigger,
            prevBootFailCount: ts.prevBootFailCount,
            ...(ts.discoveredInstanceId ? { discoveredInstanceId: ts.discoveredInstanceId } : {}),
            ...(ts.sshHost ? { sshHost: ts.sshHost } : {}),
            ...(ts.sshPort ? { sshPort: ts.sshPort } : {}),
          };
        }
        // ready
        return {
          state: 'ready',
          tierIndex: ts.tierIndex,
          endpoint: ts.endpoint,
          lastHealthyAt: ts.lastHealthyAt,
          ...(ts.activeGpuType ? { activeGpuType: ts.activeGpuType } : {}),
          ...(ts.trigger ? { trigger: ts.trigger } : {}),
          ...(ts.bootedAt !== undefined ? { bootedAt: ts.bootedAt } : {}),
          ...(ts.sshHost ? { sshHost: ts.sshHost } : {}),
          ...(ts.sshPort ? { sshPort: ts.sshPort } : {}),
        };
      });

      await this.stateStore.set(redisKey(userId), JSON.stringify(serializable), TTL_SECS);
    } catch (err) {
      this.logger.warn('[state-persistence] Failed to persist tier states:', err);
    }
  }

  /**
   * Load persisted tier states from Redis.
   * Returns null if no persisted state exists.
   */
  async loadPersistedTierStates(userId: string): Promise<GpuTierState[] | null> {
    try {
      const raw = await this.stateStore.get(redisKey(userId));
      if (!raw) return null;

      let persisted: unknown;
      try {
        persisted = JSON.parse(raw);
      } catch (parseErr) {
        this.logger.warn('[state-persistence] Corrupted JSON in state store, discarding:', parseErr);
        await this.stateStore.del(redisKey(userId));
        return null;
      }
      if (!Array.isArray(persisted) || persisted.length === 0) return null;

      return (persisted as Array<Record<string, unknown>>).map((p): GpuTierState => {
        const tierIndex = typeof p.tierIndex === 'number' ? p.tierIndex : 0;
        if (p.state === 'booting') {
          const booting: BootingTierState = {
            state: 'booting',
            tierIndex,
            endpoint: p.endpoint as string,
            bootTriggeredAt: p.bootTriggeredAt as number,
            trigger: p.trigger as ScaleTrigger,
            prevBootFailCount: (p.prevBootFailCount as number) ?? 0,
            ...(p.discoveredInstanceId ? { discoveredInstanceId: p.discoveredInstanceId as string } : {}),
            ...(p.sshHost ? { sshHost: p.sshHost as string } : {}),
            ...(p.sshPort ? { sshPort: p.sshPort as number } : {}),
          };
          return booting;
        }
        if (p.state === 'ready') {
          const ready: ReadyTierState = {
            state: 'ready',
            tierIndex,
            endpoint: p.endpoint as string,
            lastHealthyAt: p.lastHealthyAt as number,
            ...(p.activeGpuType ? { activeGpuType: p.activeGpuType as string } : {}),
            ...(p.trigger ? { trigger: p.trigger as ScaleTrigger } : {}),
            ...(p.bootedAt !== undefined ? { bootedAt: p.bootedAt as number } : {}),
            ...(p.sshHost ? { sshHost: p.sshHost as string } : {}),
            ...(p.sshPort ? { sshPort: p.sshPort as number } : {}),
          };
          return ready;
        }
        // idle (or unknown legacy state)
        const idle: IdleTierState = {
          state: 'idle',
          tierIndex,
          ...(p.bootFailCount !== undefined ? { bootFailCount: p.bootFailCount as number } : {}),
          ...(p.cooldownUntil !== undefined ? { cooldownUntil: p.cooldownUntil as number } : {}),
          ...(p.unhealthy ? { unhealthy: p.unhealthy as boolean } : {}),
        };
        return idle;
      });
    } catch (err) {
      this.logger.warn('[state-persistence] Failed to load tier states:', err);
      return null;
    }
  }

  /**
   * Find all userIds with active (non-idle) persisted tier states.
   * Uses StateStore SCAN to iterate keys matching the prefix pattern.
   */
  async findUsersWithActiveGpus(): Promise<string[]> {
    try {
      const userIds = new Set<string>();
      await this.stateStore.scan(`${KEY_PREFIX}*`, (keys) => {
        for (const key of keys) {
          const userId = key.slice(KEY_PREFIX.length);
          if (userId) userIds.add(userId);
        }
        return true;
      });
      return Array.from(userIds);
    } catch (err) {
      this.logger.warn('[state-persistence] Failed to find users with active GPUs:', err);
      return [];
    }
  }
}
