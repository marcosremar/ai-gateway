/**
 * Vault types — AES-256-GCM encrypted secret management.
 */

/** Encrypted blob stored by the VaultStore */
export interface EncryptedBlob {
  iv: string;        // hex-encoded 12-byte IV
  ciphertext: string; // hex-encoded ciphertext
  tag: string;        // hex-encoded 16-byte auth tag
  version: number;    // key version for rotation
}

/** DI interface for vault persistence (Redis, KV, Prisma, etc.) */
export interface VaultStore {
  get(name: string): Promise<string | null>;
  set(name: string, encrypted: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Vault configuration */
export interface VaultConfig {
  masterKey: string;       // 32-byte hex or base64 key
  store: VaultStore;
  keyVersion?: number;     // default 1
}
