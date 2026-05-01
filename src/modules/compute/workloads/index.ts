/**
 * Unified Workload management — GPU inference, bots, databases.
 *
 * @example
 * ```typescript
 * import { workloadRegistry, GpuWorkloadDriver, BotWorkloadDriver, DbWorkloadDriver } from '@parle/ai-gateway/workloads';
 *
 * // Register drivers
 * workloadRegistry.registerDriver(new GpuWorkloadDriver());
 * workloadRegistry.registerDriver(new BotWorkloadDriver());
 * workloadRegistry.registerDriver(new DbWorkloadDriver());
 *
 * // Deploy a bot
 * const bot = await workloadRegistry.deploy('teams-bot', {
 *   type: 'bot',
 *   botKind: 'teams',
 * });
 *
 * // List all workloads
 * const all = workloadRegistry.list();
 * ```
 */

export * from './types';
export { registerWorkloadServerRuntime } from './server-runtime';
export type { WorkloadServerRuntime } from './server-runtime';
export { WorkloadRegistry, workloadRegistry } from './registry';
export { GpuWorkloadDriver } from './gpu-driver';
export { BotWorkloadDriver } from './bot-driver';
export { DbWorkloadDriver } from './db-driver';
