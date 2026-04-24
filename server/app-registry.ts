// ── App Registry — dynamic, persisted catalog of deployable images ─────────
//
// Replaces the hardcoded DOCKER_IMAGE_NAMES list. Entries can be added or
// removed at runtime via the /v1/apps HTTP routes (see routes/apps.ts) or
// programmatically. State is persisted to $HOME/.ai-gateway/apps.json so
// it survives gateway restarts. When DATABASE_URL is set we ALSO mirror
// the state into prisma.appRegistry for multi-node deploys; the JSON file
// remains the source of truth on single-node setups (no-op prisma).
//
// Design notes:
//   - This is a runtime registry, NOT a compile-time constant. Consumers
//     that used to import DOCKER_IMAGE_NAMES should call listImages().
//   - Boot-time estimates also live here (bootEstimateS) — removes the
//     parallel IMAGE_BOOT_ESTIMATES regex table in gpu-idle-logic.
//   - The seed (first-boot default) matches the pre-refactor hardcoded
//     list, plus musetalk. After that, operators mutate it via API.
//   - Operations are process-local except for the JSON file + optional DB
//     mirror. No cross-process invalidation signal today — acceptable
//     because the gateway is single-process.
//
// See __tests__/app-registry.test.ts for contract coverage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { createLogger } from '../src/logger';
import { prisma } from './state';

const log = createLogger('app-registry');

// ── Types ─────────────────────────────────────────────────────────────────

export interface AppRegistryEntry {
  /** Unique slug (e.g. "musetalk", "wan-i2v"). Used in URLs and logs. */
  name: string;
  /** Docker image WITHOUT tag (e.g. "marcosremar/musetalk"). Tag is appended
   *  from DOCKER_IMAGE_VERSION env by the deploy layer. */
  image: string;
  /** Alternate image to use when the primary GPU is Blackwell architecture
   *  (RTX 5090/5080/5070/etc). Some apps ship a separate build linked against
   *  CUDA 12.8 / sm_120 — declaring it here is enough; the deploy layer
   *  resolves it via resolveDockerImageForGpus() in config.ts. */
  blackwellImage?: string;
  /** Estimated boot time in seconds (cold-start heuristic for idle timeout).
   *  Default 250s — overridden per-image when the operator has better data. */
  bootEstimateS?: number;
  /** Free-form notes shown on the /v1/apps endpoint (UI hint). */
  notes?: string;
  /** Tags used by UI filtering; e.g. ["video","lipsync","realtime"]. */
  tags?: string[];
  /** When the entry was registered (ISO string). */
  createdAt?: string;
}

// ── Persistence paths ─────────────────────────────────────────────────────

const REGISTRY_DIR = process.env.AI_GATEWAY_HOME || join(homedir(), '.ai-gateway');
const REGISTRY_FILE = join(REGISTRY_DIR, 'apps.json');

// ── Default seed (post-refactor source of truth for first-boot state) ─────
//
// Matches the pre-refactor DOCKER_IMAGE_NAMES plus musetalk (the reason for
// this refactor — we want new apps registered without code edits).

const IMAGE_PREFIX = process.env.DOCKER_IMAGE_PREFIX || 'marcosremar';

export const SEED_ENTRIES: AppRegistryEntry[] = [
  { name: 'babelcast-subtitle',                      image: `${IMAGE_PREFIX}/babelcast-subtitle`,                      bootEstimateS: 180, tags: ['speech','subtitle'] },
  { name: 'babelcast-translategemma',                image: `${IMAGE_PREFIX}/babelcast-translategemma`,                bootEstimateS: 180, tags: ['speech','translation'] },
  { name: 'babelcast-translategemma-only-subtitles', image: `${IMAGE_PREFIX}/babelcast-translategemma-only-subtitles`, bootEstimateS: 180, tags: ['speech','translation','subtitle'] },
  { name: 'babelcast-mistral',                       image: `${IMAGE_PREFIX}/babelcast-mistral`,                       bootEstimateS: 180, tags: ['llm','translation'], blackwellImage: `${IMAGE_PREFIX}/babelcast-blackwell-mistral` },
  { name: 'babelcast-groq',                          image: `${IMAGE_PREFIX}/babelcast-groq`,                          bootEstimateS: 120, tags: ['speech','cloud-relay'] },
  { name: 'babelcast-qwen3-tts',                     image: `${IMAGE_PREFIX}/babelcast-qwen3-tts`,                     bootEstimateS: 180, tags: ['tts'] },
  { name: 'hybrik-x',                                image: `${IMAGE_PREFIX}/hybrik-x`,                                bootEstimateS: 300, tags: ['vision','pose'] },
  { name: 'hy-motion',                               image: `${IMAGE_PREFIX}/hy-motion`,                               bootEstimateS: 300, tags: ['vision','motion'] },
  { name: 'wan-i2v',                                 image: `${IMAGE_PREFIX}/wan-i2v`,                                 bootEstimateS: 300, tags: ['video','i2v'] },
  { name: 'musetalk',                                image: `${IMAGE_PREFIX}/musetalk`,                                bootEstimateS: 300, tags: ['video','lipsync','realtime'] },
  { name: 'fbx2glb',                                 image: `${IMAGE_PREFIX}/fbx2glb`,                                 bootEstimateS:  60, tags: ['3d','conversion','fbx','glb'] },
];

// ── In-memory state ───────────────────────────────────────────────────────

let cache: Map<string, AppRegistryEntry> | null = null;

function ensureDir(): void {
  if (!existsSync(REGISTRY_DIR)) mkdirSync(REGISTRY_DIR, { recursive: true });
}

function loadFromDisk(): Map<string, AppRegistryEntry> {
  ensureDir();
  if (!existsSync(REGISTRY_FILE)) {
    // First boot: seed the file.
    writeFileSync(REGISTRY_FILE, JSON.stringify(SEED_ENTRIES, null, 2));
    log.log(`Seeded ${SEED_ENTRIES.length} default apps → ${REGISTRY_FILE}`);
    return new Map(SEED_ENTRIES.map(e => [e.name, e]));
  }
  try {
    const raw = readFileSync(REGISTRY_FILE, 'utf8');
    const entries = JSON.parse(raw) as AppRegistryEntry[];
    const map = new Map(entries.map(e => [e.name, e]));

    // Forward-migration: for every seed entry missing on disk or missing a
    // field we now care about, patch it in without overwriting operator
    // edits. This lets a new release add fields (e.g. blackwellImage) and
    // have existing apps.json files pick them up on next boot.
    let migrated = false;
    for (const seed of SEED_ENTRIES) {
      const existing = map.get(seed.name);
      if (!existing) { map.set(seed.name, seed); migrated = true; continue; }
      const merged = { ...seed, ...existing };
      // Missing fields from older on-disk entries — fill from seed only
      // when the current on-disk value is undefined (preserve operator edits).
      if (existing.blackwellImage === undefined && seed.blackwellImage) {
        merged.blackwellImage = seed.blackwellImage;
        migrated = true;
      }
      if (existing.bootEstimateS === undefined && seed.bootEstimateS) {
        merged.bootEstimateS = seed.bootEstimateS;
        migrated = true;
      }
      if (!existing.tags && seed.tags) {
        merged.tags = seed.tags;
        migrated = true;
      }
      map.set(seed.name, merged);
    }
    if (migrated) {
      try { saveToDisk(map); log.log('Registry auto-migrated — new seed fields merged'); }
      catch (e) { log.warn(`Registry migration save failed: ${(e as Error).message}`); }
    }
    return map;
  } catch (err) {
    log.warn(`Failed to parse ${REGISTRY_FILE}: ${(err as Error).message} — falling back to seed`);
    return new Map(SEED_ENTRIES.map(e => [e.name, e]));
  }
}

function saveToDisk(entries: Map<string, AppRegistryEntry>): void {
  ensureDir();
  const arr = Array.from(entries.values());
  writeFileSync(REGISTRY_FILE, JSON.stringify(arr, null, 2));
}

function ensureLoaded(): Map<string, AppRegistryEntry> {
  if (!cache) cache = loadFromDisk();
  return cache;
}

// ── Public API ────────────────────────────────────────────────────────────

export function listImages(): AppRegistryEntry[] {
  return Array.from(ensureLoaded().values());
}

export function getImage(name: string): AppRegistryEntry | undefined {
  return ensureLoaded().get(name);
}

/** Resolve the Blackwell-variant image for a given base image, or null
 *  when no variant is declared. Used by resolveDockerImageForGpus() to
 *  swap images when the primary GPU is a Blackwell card. Takes an
 *  image WITH or WITHOUT tag — the tag is preserved in the return. */
export function blackwellImageFor(imageWithOptionalTag: string): string | null {
  const [base, tag] = imageWithOptionalTag.includes(':')
    ? [imageWithOptionalTag.split(':')[0]!, imageWithOptionalTag.split(':')[1]!]
    : [imageWithOptionalTag, undefined];
  for (const entry of ensureLoaded().values()) {
    if (entry.image === base && entry.blackwellImage) {
      return tag ? `${entry.blackwellImage}:${tag}` : entry.blackwellImage;
    }
  }
  return null;
}

/** Resolve boot estimate for a given docker image name. Checks registry
 *  first (most accurate, operator-declared), falls back to the default
 *  250s when unknown. */
export function bootEstimateForImage(imageName: string): number {
  const c = ensureLoaded();
  // imageName may include :tag; match on base.
  const base = imageName.includes(':') ? imageName.split(':')[0]! : imageName;
  for (const entry of c.values()) {
    if (entry.image === base || entry.name === base) {
      return entry.bootEstimateS ?? 250;
    }
  }
  return 250;
}

/** Register (or update) an app entry. Persists to disk + optional DB. */
export async function registerImage(entry: AppRegistryEntry): Promise<AppRegistryEntry> {
  if (!entry.name || !entry.image) {
    throw new Error('name and image are required');
  }
  const c = ensureLoaded();
  const existing = c.get(entry.name);
  const merged: AppRegistryEntry = {
    ...existing,
    ...entry,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  c.set(entry.name, merged);
  saveToDisk(c);
  await mirrorToDb(merged).catch(e => log.warn(`DB mirror failed (non-fatal): ${e.message}`));
  log.log(`Registered app "${merged.name}" → ${merged.image}`);
  return merged;
}

/** Remove an app entry. Returns true when something was removed. */
export async function unregisterImage(name: string): Promise<boolean> {
  const c = ensureLoaded();
  if (!c.delete(name)) return false;
  saveToDisk(c);
  await mirrorRemovalToDb(name).catch(e => log.warn(`DB mirror removal failed: ${e.message}`));
  log.log(`Unregistered app "${name}"`);
  return true;
}

/** Drops the in-memory cache — forces the next read to re-load from disk.
 *  Useful for tests and for operators editing apps.json manually. */
export function reloadRegistry(): void {
  cache = null;
}

// ── Optional DB mirroring (no-op when Prisma is absent) ───────────────────

async function mirrorToDb(entry: AppRegistryEntry): Promise<void> {
  if (!prisma?.appRegistry) return; // no-op when schema/model missing
  await prisma.appRegistry.upsert({
    where: { name: entry.name },
    update: { image: entry.image, bootEstimateS: entry.bootEstimateS, notes: entry.notes, tags: entry.tags },
    create: { name: entry.name, image: entry.image, bootEstimateS: entry.bootEstimateS, notes: entry.notes, tags: entry.tags },
  });
}

async function mirrorRemovalToDb(name: string): Promise<void> {
  if (!prisma?.appRegistry) return;
  await prisma.appRegistry.delete({ where: { name } }).catch(() => {});
}

// ── Backward-compat helpers for the catalog endpoint ───────────────────────

export function getImageCatalogDynamic(version: string): {
  version: string;
  images: string[];
  latestImages: string[];
  entries: AppRegistryEntry[];
} {
  const entries = listImages();
  return {
    version,
    images: entries.map(e => `${e.image}:${version}`),
    latestImages: entries.map(e => `${e.image}:latest`),
    entries,
  };
}
