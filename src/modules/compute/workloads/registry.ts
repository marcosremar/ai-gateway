/**
 * WorkloadRegistry — in-memory store of active workloads with driver dispatch.
 *
 * Stores all workloads, delegates lifecycle ops to the right WorkloadDriver,
 * and emits events so the UI / WebSocket layer can react.
 */

import { randomUUID } from 'crypto';
import type {
  Workload,
  WorkloadType,
  WorkloadConfig,
  WorkloadDriver,
  WorkloadEvent,
  WorkloadEventHandler,
  WorkloadStatus,
} from './types';

export class WorkloadRegistry {
  private workloads = new Map<string, Workload>();
  private drivers = new Map<WorkloadType, WorkloadDriver>();
  private listeners: WorkloadEventHandler[] = [];

  // ── Driver registration ─────────────────────────────────────────────────

  registerDriver(driver: WorkloadDriver): void {
    this.drivers.set(driver.type, driver);
  }

  private getDriver(type: WorkloadType): WorkloadDriver {
    const d = this.drivers.get(type);
    if (!d) throw new Error(`No workload driver registered for type "${type}"`);
    return d;
  }

  // ── Event system ────────────────────────────────────────────────────────

  onEvent(handler: WorkloadEventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  private emit(event: WorkloadEvent): void {
    for (const h of this.listeners) {
      try { h(event); } catch (e) { console.error('[workloads] event handler error', e); }
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  list(): Workload[] {
    return Array.from(this.workloads.values());
  }

  get(id: string): Workload | undefined {
    return this.workloads.get(id);
  }

  getByName(name: string): Workload | undefined {
    const all = Array.from(this.workloads.values());
    return all.find((w) => w.name === name);
  }

  listByType(type: WorkloadType): Workload[] {
    return this.list().filter((w) => w.type === type);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    // Prevent duplicate names
    const existing = this.getByName(name);
    if (existing && existing.status !== 'error') {
      throw new Error(`Workload "${name}" already exists (status: ${existing.status})`);
    }
    // Remove errored workload with same name so we can redeploy
    if (existing) this.workloads.delete(existing.id);

    const driver = this.getDriver(config.type);
    const workload = await driver.deploy(name, config);
    this.workloads.set(workload.id, workload);
    this.emit({ type: 'created', workload, timestamp: Date.now() });
    return workload;
  }

  async stop(id: string): Promise<Workload> {
    const w = this.requireWorkload(id);
    const driver = this.getDriver(w.type);
    const prev = w.status;
    const updated = await driver.stop(w);
    this.workloads.set(id, updated);
    this.emit({ type: 'status_changed', workload: updated, previousStatus: prev, timestamp: Date.now() });
    return updated;
  }

  async start(id: string): Promise<Workload> {
    const w = this.requireWorkload(id);
    const driver = this.getDriver(w.type);
    const prev = w.status;
    const updated = await driver.start(w);
    this.workloads.set(id, updated);
    this.emit({ type: 'status_changed', workload: updated, previousStatus: prev, timestamp: Date.now() });
    return updated;
  }

  async terminate(id: string): Promise<void> {
    const w = this.requireWorkload(id);
    const driver = this.getDriver(w.type);
    await driver.terminate(w);
    this.workloads.delete(id);
    this.emit({ type: 'terminated', workload: { ...w, status: 'idle' }, timestamp: Date.now() });
  }

  async refreshStatus(id: string): Promise<Workload> {
    const w = this.requireWorkload(id);
    const driver = this.getDriver(w.type);
    const prev = w.status;
    const updated = await driver.status(w);
    this.workloads.set(id, updated);
    if (updated.status !== prev) {
      this.emit({ type: 'status_changed', workload: updated, previousStatus: prev, timestamp: Date.now() });
    }
    return updated;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private requireWorkload(id: string): Workload {
    const w = this.workloads.get(id);
    if (!w) throw new Error(`Workload "${id}" not found`);
    return w;
  }

  /** Import an externally-created workload (e.g. syncing existing GPU deploy state at startup) */
  import(workload: Workload): void {
    this.workloads.set(workload.id, workload);
  }

  /** Generate a new workload ID */
  static newId(): string {
    return randomUUID();
  }
}

/** Singleton shared across the server */
export const workloadRegistry = new WorkloadRegistry();
