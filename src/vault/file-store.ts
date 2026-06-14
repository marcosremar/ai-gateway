import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import type { VaultStore } from './types';

export class FileVaultStore implements VaultStore {
  private filePath: string;
  private cache: Record<string, string> = {};
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private load(): Record<string, string> {
    if (this.loaded) return this.cache;
    if (!existsSync(this.filePath)) {
      this.loaded = true;
      return this.cache;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn('[vault] Invalid vault file format, starting fresh');
        this.cache = {};
      } else {
        this.cache = parsed as Record<string, string>;
      }
      this.loaded = true;
      return this.cache;
    } catch {
      this.loaded = true;
      this.cache = {};
      return this.cache;
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      // Vault directory holds encrypted secrets — keep it owner-only so a
      // misconfigured umask can't leave the contents world-readable.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // `mkdirSync(...0o700)` only applies the mode when *creating* the dir.
      // If the directory already exists with a permissive mode (e.g. created
      // by another tool under a lax umask), the encrypted vault would sit in
      // a world-readable directory. Re-assert owner-only on every save.
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Best-effort: a chmod failure (e.g. not the owner) must not block
        // persisting the secret; the file itself is still written 0o600.
      }
    }
    // Atomic write: write to temp file, then rename.
    // Serialize the live in-memory cache directly rather than calling
    // `this.load()` again: `load()` returns the cache today, but routing the
    // write through the loader is fragile — a future change to `load` (e.g.
    // re-reading from disk) could silently persist stale data over fresh
    // mutations. Pass the source of truth explicitly.
    const tempPath = join(dir, `.vault-${randomBytes(8).toString('hex')}.tmp`);
    const data = JSON.stringify(this.cache, null, 2);
    try {
      // 0o600 — only the owning user can read or write the vault file.
      writeFileSync(tempPath, data, { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, this.filePath);
    } catch (err) {
      // Clean up temp file if it exists
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {}
      throw err;
    }
  }

  async get(name: string): Promise<string | null> {
    const val = this.load()[name] ?? null;
    if (val === null) return null;
    if (typeof val !== 'string') return JSON.stringify(val);
    return val;
  }

  async set(name: string, encrypted: string): Promise<void> {
    this.load()[name] = encrypted;
    this.save();
  }

  async delete(name: string): Promise<void> {
    delete this.load()[name];
    this.save();
  }

  async list(): Promise<string[]> {
    return Object.keys(this.load());
  }
}
