/**
 * Lightweight Dependency Injection Container.
 *
 * Provides a simple, type-safe DI container for managing service dependencies
 * without the complexity of a full IoC framework.
 *
 * @example
 * ```ts
 * import { createContainer } from './di-container';
 *
 * const container = createContainer();
 *
 * // Register services
 * container.register('logger', () => createLogger('app'));
 * container.register('db', () => new DatabaseService());
 * container.register('userService', (c) => new UserService(c.get('db')));
 *
 * // Resolve (lazy, singleton by default)
 * const users = container.get('userService');
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('di-container');

export type ServiceFactory<T> = (container: DIContainer) => T;

export interface ServiceRegistration {
  factory: ServiceFactory<unknown>;
  singleton: boolean;
  instance?: unknown;
}

/**
 * Simple DI container with singleton support.
 */
export class DIContainer {
  private registrations = new Map<string, ServiceRegistration>();
  private resolving = new Set<string>(); // Cycle detection

  /**
   * Register a service factory.
   *
   * @param name Service name
   * @param factory Factory function that creates the service
   * @param singleton If true, service is created once and cached (default: true)
   */
  register<T>(name: string, factory: ServiceFactory<T>, singleton = true): void {
    this.registrations.set(name, { factory: factory as ServiceFactory<unknown>, singleton });
    log.log({ name, singleton }, 'Service registered');
  }

  /**
   * Register a pre-created instance.
   */
  registerInstance<T>(name: string, instance: T): void {
    this.registrations.set(name, {
      factory: () => instance,
      singleton: true,
      instance,
    });
    log.log({ name }, 'Service instance registered');
  }

  /**
   * Resolve a service by name.
   *
   * Throws if the service is not registered or if there's a circular dependency.
   */
  get<T>(name: string): T {
    const registration = this.registrations.get(name);

    if (!registration) {
      throw new Error(`Service not registered: "${name}". Registered: ${this.list().join(', ')}`);
    }

    // Return cached singleton
    if (registration.singleton && registration.instance !== undefined) {
      return registration.instance as T;
    }

    // Cycle detection
    if (this.resolving.has(name)) {
      throw new Error(`Circular dependency detected: "${name}"`);
    }

    try {
      this.resolving.add(name);
      const instance = registration.factory(this);

      if (registration.singleton) {
        registration.instance = instance;
      }

      return instance as T;
    } finally {
      this.resolving.delete(name);
    }
  }

  /**
   * Check if a service is registered.
   */
  has(name: string): boolean {
    return this.registrations.has(name);
  }

  /**
   * List all registered service names.
   */
  list(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Reset a specific service (clears singleton cache).
   */
  reset(name: string): void {
    const registration = this.registrations.get(name);
    if (registration) {
      registration.instance = undefined;
    }
  }

  /**
   * Reset all services (clears singleton cache).
   */
  resetAll(): void {
    for (const registration of this.registrations.values()) {
      registration.instance = undefined;
    }
  }

  /**
   * Create a child container that inherits parent registrations.
   * Useful for scoped dependencies (per-request, per-test, etc.).
   */
  createChild(): DIContainer {
    const child = new DIContainer();

    // Inherit registrations (not instances)
    for (const [name, registration] of this.registrations.entries()) {
      child.registrations.set(name, { ...registration });
    }

    return child;
  }
}

/**
 * Create a new DI container.
 */
export function createContainer(): DIContainer {
  return new DIContainer();
}

/**
 * Create a container pre-configured with common gateway services.
 */
export function createGatewayContainer(): DIContainer {
  const container = createContainer();

  // Register core services
  container.register('logger', () => createLogger('gateway'));

  // Add more services as needed:
  // container.register('db', () => new DatabaseService());
  // container.register('cache', () => new CacheService());
  // container.register('autoscaler', (c) => createAutoscaler({
  //   logger: c.get('logger'),
  //   stateStore: c.get('stateStore'),
  // }));

  return container;
}
