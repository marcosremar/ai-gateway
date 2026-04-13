import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
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
      mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to temp file, then rename
    const tempPath = join(dir, `.vault-${randomBytes(8).toString('hex')}.tmp`);
    const data = JSON.stringify(this.load(), null, 2);
    try {
      writeFileSync(tempPath, data, { encoding: 'utf-8', fsync: true });
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
