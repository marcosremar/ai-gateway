import type { GpuProviderClient } from './types';

export class GpuProviderRegistry {
  private clients = new Map<string, GpuProviderClient>();

  register(client: GpuProviderClient): void {
    this.clients.set(client.providerId, client);
  }

  get(providerId: string): GpuProviderClient | undefined {
    return this.clients.get(providerId);
  }

  getOrThrow(providerId: string): GpuProviderClient {
    const c = this.get(providerId);
    if (!c) throw new Error(`No GPU provider registered for: ${providerId}`);
    return c;
  }

  /**
   * @deprecated All providers now implement `listInstances` on `GpuProviderClient`.
   * Use `get()` or `getOrThrow()` directly instead.
   */
  getMonitorable(providerId: string): GpuProviderClient | undefined {
    return this.get(providerId);
  }
}
