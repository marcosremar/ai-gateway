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

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function addBuildRecord(record: ImageBuildRecord): void {
  const catalog = loadCatalog();
  // Remove old record with same ID if it exists
  catalog.records = catalog.records.filter(r => r.id !== record.id);
  catalog.records.unshift(record); // newest first
  // Keep last 100 records
  if (catalog.records.length > 100) catalog.records = catalog.records.slice(0, 100);
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
