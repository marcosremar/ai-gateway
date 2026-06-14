/**
 * Image Catalog — persistent registry of built Docker images
 * Stored at ~/.babelcast/image-catalog.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ImageBuildRecord, ImageCatalog, ImageBuildStatus } from './types';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const CATALOG_FILE = join(BABELCAST_DIR, 'image-catalog.json');

function loadCatalog(): ImageCatalog {
  try {
    if (!existsSync(CATALOG_FILE)) return { version: 1, records: [] };
    const raw = readFileSync(CATALOG_FILE, 'utf-8');
    const data = JSON.parse(raw) as ImageCatalog;
    if (!Array.isArray(data.records)) return { version: 1, records: [] };
    return data;
  } catch {
    return { version: 1, records: [] };
  }
}

function saveCatalog(catalog: ImageCatalog): void {
  mkdirSync(BABELCAST_DIR, { recursive: true });
  const tmp = CATALOG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  // Atomic rename
  const { renameSync } = require('fs');
  renameSync(tmp, CATALOG_FILE);
}

// ── Retention / eviction (#973) ─────────────────────────────────────────────

/** Default max catalog records kept (newest-first). Override via env. */
export const DEFAULT_MAX_CATALOG_RECORDS = 100;
/** Default age (ms) after which terminal records are pruned: 90 days. */
export const DEFAULT_CATALOG_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES: ReadonlySet<ImageBuildStatus> = new Set<ImageBuildStatus>([
  'success',
  'failed',
  'cancelled',
]);

function isTerminal(status: ImageBuildStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Prune a newest-first record list (#973). The catalog grows unbounded as every
 * build appends forever, bloating the file and any list endpoint. Drop terminal
 * records older than `ttlMs`, then hard-cap to `maxRecords`. In-flight records
 * (pending/queued/building) are never pruned by TTL so a long build can't be
 * evicted mid-flight. Pure; exported for tests.
 */
export function pruneCatalogRecords(
  records: ImageBuildRecord[],
  maxRecords = DEFAULT_MAX_CATALOG_RECORDS,
  ttlMs = DEFAULT_CATALOG_TTL_MS,
  now = Date.now(),
): ImageBuildRecord[] {
  const ttlPruned = records.filter((r) => {
    if (!isTerminal(r.status)) return true; // keep in-flight regardless of age
    const ts = r.completedAt ?? r.updatedAt ?? r.createdAt ?? now;
    return now - ts <= ttlMs;
  });
  const cap = Math.max(0, Math.floor(maxRecords));
  return ttlPruned.slice(0, cap);
}

function maxCatalogRecords(): number {
  const raw = process.env.AI_GATEWAY_MAX_CATALOG_RECORDS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_CATALOG_RECORDS;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function addBuildRecord(record: ImageBuildRecord): void {
  const catalog = loadCatalog();
  // Remove old record with same ID if it exists
  catalog.records = catalog.records.filter(r => r.id !== record.id);
  catalog.records.unshift(record); // newest first
  // Evict by TTL + hard cap so the catalog stays small (#973).
  catalog.records = pruneCatalogRecords(catalog.records, maxCatalogRecords());
  saveCatalog(catalog);
}

export function updateBuildRecord(
  id: string,
  updates: Partial<Pick<ImageBuildRecord, 'status' | 'image' | 'error' | 'runId' | 'workflowRunUrl' | 'completedAt' | 'updatedAt'>>,
): ImageBuildRecord | null {
  const catalog = loadCatalog();
  const idx = catalog.records.findIndex(r => r.id === id);
  if (idx === -1) return null;
  catalog.records[idx] = { ...catalog.records[idx], ...updates, updatedAt: Date.now() };
  saveCatalog(catalog);
  return catalog.records[idx];
}

export function getBuildRecord(id: string): ImageBuildRecord | null {
  return loadCatalog().records.find(r => r.id === id) ?? null;
}

export function listBuildRecords(limit = 50): ImageBuildRecord[] {
  return loadCatalog().records.slice(0, limit);
}

export function getReadyImages(): ImageBuildRecord[] {
  return loadCatalog().records.filter(r => r.status === 'success');
}

/** Generate a short unique build ID */
export function generateBuildId(): string {
  return `bld-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
