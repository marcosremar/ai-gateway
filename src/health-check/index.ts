/**
 * Health Check Aggregator — unified health checking for all components.
 *
 * Fixes: #791 (deployment health checks), #834 (production monitoring)
 *
 * Usage:
 * ```ts
 * import { healthChecker, registerCheck } from './health-check';
 *
 * // Register checks
 * registerCheck('database', async () => {
 *   await prisma.$queryRaw`SELECT 1`;
 *   return { healthy: true };
 * });
 *
 * // Run all checks
 * const result = await healthChecker.runAll();
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('health-check');

export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export type HealthCheckFn = () => Promise<HealthCheckResult>;

export interface RegisteredCheck {
  name: string;
  fn: HealthCheckFn;
  timeoutMs: number;
  critical: boolean;
}

export class HealthChecker {
  private checks = new Map<string, RegisteredCheck>();
  private lastResults = new Map<string, HealthCheckResult & { timestamp: string }>();

  /**
   * Register a health check.
   */
  register(name: string, fn: HealthCheckFn, options: { timeoutMs?: number; critical?: boolean } = {}): void {
    this.checks.set(name, {
      name,
      fn,
      timeoutMs: options.timeoutMs ?? 5000,
      critical: options.critical ?? false,
    });
  }

  /**
   * Run all registered health checks.
   */
  async runAll(): Promise<{
    overall: boolean;
    checks: Record<string, HealthCheckResult & { timestamp: string }>;
    durationMs: number;
  }> {
    const start = Date.now();
    const results: Record<string, HealthCheckResult & { timestamp: string }> = {};
    let overallHealthy = true;

    await Promise.all(
      Array.from(this.checks.entries()).map(async ([name, check]) => {
        const result = await this.runCheck(name, check);
        results[name] = result;
        this.lastResults.set(name, result);

        if (!result.healthy) {
          if (check.critical) {
            overallHealthy = false;
          }
          log.warn({ name, message: result.message }, 'Health check failed');
        }
      }),
    );

    const durationMs = Date.now() - start;

    return {
      overall: overallHealthy,
      checks: results,
      durationMs,
    };
  }

  /**
   * Run a single health check.
   */
  async runOne(name: string): Promise<HealthCheckResult & { timestamp: string }> {
    const check = this.checks.get(name);
    if (!check) {
      return { healthy: false, message: `Unknown health check: ${name}`, timestamp: new Date().toISOString() };
    }
    return this.runCheck(name, check);
  }

  /**
   * Get last results without running checks.
   */
  getLastResults(): Record<string, HealthCheckResult & { timestamp: string }> {
    return Object.fromEntries(this.lastResults.entries());
  }

  /**
   * Get registered check names.
   */
  getCheckNames(): string[] {
    return Array.from(this.checks.keys());
  }

  private async runCheck(
    name: string,
    check: RegisteredCheck,
  ): Promise<HealthCheckResult & { timestamp: string }> {
    const start = Date.now();

    try {
      const result = await Promise.race([
        check.fn(),
        new Promise<HealthCheckResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Health check timed out after ${check.timeoutMs}ms`)), check.timeoutMs),
        ),
      ]);

      return {
        ...result,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

/**
 * Global health checker instance.
 */
export const healthChecker = new HealthChecker();

/**
 * Convenience function to register a health check.
 */
export function registerCheck(
  name: string,
  fn: HealthCheckFn,
  options: { timeoutMs?: number; critical?: boolean } = {},
): void {
  healthChecker.register(name, fn, options);
}

/**
 * Standard health checks to register.
 */
export function registerStandardChecks(): void {
  registerCheck('process', async () => ({
    healthy: true,
    message: `Uptime: ${Math.round(process.uptime())}s`,
    details: {
      memoryUsage: process.memoryUsage(),
      nodeVersion: process.version,
    },
  }));
}
