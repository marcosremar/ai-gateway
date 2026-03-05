/**
 * Vault — AES-256-GCM encrypted credential storage.
 *
 * Uses Node.js crypto. Master key from env or config.
 * Stores {iv, ciphertext, tag, version} as JSON via VaultStore.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { EncryptedBlob, VaultStore } from './types';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class Vault {
  private key: Buffer;
  private _store: VaultStore;
  private keyVersion: number;

  constructor(masterKey: string, store: VaultStore, keyVersion = 1) {
    this.key = Vault.deriveKey(masterKey);
    this._store = store;
    this.keyVersion = keyVersion;
  }

  /** Derive a 32-byte key from hex or base64 input */
  private static deriveKey(masterKey: string): Buffer {
    // Try hex first (64 chars = 32 bytes)
    if (/^[0-9a-f]{64}$/i.test(masterKey)) {
      return Buffer.from(masterKey, 'hex');
    }
    // Try base64 (44 chars = 32 bytes)
    const buf = Buffer.from(masterKey, 'base64');
    if (buf.length === 32) return buf;
    throw new Error('[Vault] masterKey must be 32 bytes (64 hex chars or 44 base64 chars)');
  }

  /** Encrypt plaintext → EncryptedBlob */
  encrypt(plaintext: string): EncryptedBlob {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      ciphertext: encrypted.toString('hex'),
      tag: tag.toString('hex'),
      version: this.keyVersion,
    };
  }

  /** Decrypt EncryptedBlob → plaintext */
  decrypt(blob: EncryptedBlob): string {
    const iv = Buffer.from(blob.iv, 'hex');
    const ciphertext = Buffer.from(blob.ciphertext, 'hex');
    const tag = Buffer.from(blob.tag, 'hex');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  }

  /** Store an encrypted secret */
  async storeSecret(name: string, plaintext: string): Promise<void> {
    const blob = this.encrypt(plaintext);
    await this._store.set(name, JSON.stringify(blob));
  }

  /** Retrieve and decrypt a secret */
  async retrieve(name: string): Promise<string> {
    const raw = await this._store.get(name);
    if (!raw) throw new Error(`[Vault] Secret "${name}" not found`);
    const blob: EncryptedBlob = JSON.parse(raw);
    return this.decrypt(blob);
  }

  /** Delete a secret */
  async delete(name: string): Promise<void> {
    await this._store.delete(name);
  }

  /** List all secret names */
  async list(): Promise<string[]> {
    return this._store.list();
  }

  /** Re-encrypt all secrets with a new master key */
  async rotateKey(newMasterKey: string): Promise<void> {
    const newKey = Vault.deriveKey(newMasterKey);
    const names = await this._store.list();

    for (const name of names) {
      // Decrypt with old key
      const plaintext = await this.retrieve(name);
      // Encrypt with new key
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, newKey, iv, { authTagLength: TAG_LENGTH });
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      const blob: EncryptedBlob = {
        iv: iv.toString('hex'),
        ciphertext: encrypted.toString('hex'),
        tag: tag.toString('hex'),
        version: this.keyVersion + 1,
      };
      await this._store.set(name, JSON.stringify(blob));
    }

    this.key = newKey;
    this.keyVersion += 1;
  }
}
