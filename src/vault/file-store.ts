import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
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
      this.cache = JSON.parse(raw);
      this.loaded = true;
      return this.cache;
    } catch {
      this.loaded = true;
      return this.cache;
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.load(), null, 2), 'utf-8');
  }

  async get(name: string): Promise<string | null> {
    return this.load()[name] ?? null;
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
