import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import type { VaultStore } from './types';

export class FileVaultStore implements VaultStore {
  private filePath: string;
  private cache: Record<string, string> = {};
  private cacheMtime = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private load(): Record<string, string> {
    // Multi-process safety: the previous implementation cached forever,
    // so writes from `ai-gateway secrets set` (CLI process) were invisible
    // to a long-running gateway server. Re-read whenever the file's mtime
    // changes — cheap stat, costs only when another process actually wrote.
    if (!existsSync(this.filePath)) {
      this.cache = {};
      this.cacheMtime = 0;
      return this.cache;
    }
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.filePath).mtimeMs; } catch { /* fall through */ }
    if (this.cacheMtime !== 0 && this.cacheMtime === mtimeMs) {
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
      this.cacheMtime = mtimeMs;
      return this.cache;
    } catch {
      this.cache = {};
      this.cacheMtime = mtimeMs;
      return this.cache;
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      // Vault directory holds encrypted secrets — owner-only.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // Re-tighten dir perms in case it was created externally with default
      // umask (0o755 leaks secret *names* via directory listing).
      try { chmodSync(dir, 0o700); } catch { /* no-op */ }
    }
    // Atomic write: write to temp file, then rename
    const tempPath = join(dir, `.vault-${randomBytes(8).toString('hex')}.tmp`);
    const data = JSON.stringify(this.load(), null, 2);
    try {
      writeFileSync(tempPath, data, { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, this.filePath);
      // mode 0o600 only applies on creation. After rename, ensure perms
      // are tight even if the destination inode existed with different mode.
      try { chmodSync(this.filePath, 0o600); } catch { /* no-op */ }
      // Update mtime cache to our own write so we don't reload on next read.
      try { this.cacheMtime = statSync(this.filePath).mtimeMs; } catch { /* no-op */ }
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
