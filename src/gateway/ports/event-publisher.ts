/**
 * EventPublisher — port for broadcasting domain events.
 *
 * Use cases emit events via this port. Concrete implementations wire to the
 * in-memory event bus, WebSocket broadcasts, external webhooks, etc.
 */

export interface DomainEvent {
  type: string;
  timestamp: number;
  /** Arbitrary payload typed by the event name. */
  payload: Record<string, unknown>;
}

export interface EventPublisher {
  publish(event: DomainEvent): void;
}
