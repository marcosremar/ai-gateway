/**
 * Vault — AES-256-GCM encrypted credential storage.
 *
 * Uses Node.js crypto. Master key from env or config.
 * Stores {iv, ciphertext, tag, version} as JSON via VaultStore.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type { EncryptedBlob, VaultStore } from './types';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Derive a 32-byte AES key from an arbitrary-length passphrase via scrypt.
 *
 * `Vault`'s constructor requires a raw 32-byte key (64 hex / 44 base64) and
 * throws on anything else — deliberately, because silently hashing a typo'd
 * key would make blobs undecryptable. This helper is the explicit, opt-in path
 * for operators who *want* to key the vault from a human passphrase: run it
 * once, feed the result to `new Vault(...)`. It is a pure function (no I/O, no
 * on-disk format change) so adding it is safe.
 *
 * NOTE: scrypt params are fixed here; changing them changes the derived key,
 * so a passphrase-keyed vault must pin a stable salt + params (pass your own
 * salt — do NOT use a random one, or you can never re-derive the same key).
 */
export function deriveVaultKeyFromPassphrase(
  passphrase: string,
  salt: string,
  opts: { keyLength?: number } = {},
): string {
  if (!passphrase) throw new Error('[Vault] passphrase must be non-empty');
  if (!salt) throw new Error('[Vault] salt must be non-empty (a stable, per-deployment value)');
  const keyLength = opts.keyLength ?? 32;
  // N=16384, r=8, p=1 — standard interactive scrypt cost.
  const key = scryptSync(passphrase, salt, keyLength, { N: 16384, r: 8, p: 1 });
  return key.toString('hex');
}

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

  /** Decrypt EncryptedBlob → plaintext. Throws on tampered ciphertext/tag or wrong key. */
  decrypt(blob: EncryptedBlob): string {
    const iv = Buffer.from(blob.iv, 'hex');
    const ciphertext = Buffer.from(blob.ciphertext, 'hex');
    const tag = Buffer.from(blob.tag, 'hex');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    // Concatenate as Buffers and decode once at the end. Doing
    // `update(buf) + final('utf8')` triggers an implicit Buffer→string
    // conversion that splits any multi-byte UTF-8 character whose bytes
    // straddle the update/final boundary, replacing them with U+FFFD.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Store an encrypted secret */
  async storeSecret(name: string, plaintext: string): Promise<void> {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('[Vault] plaintext must be a non-empty string');
    }
    const blob = this.encrypt(plaintext);
    const serialized = JSON.stringify(blob);
    if (!serialized) {
      throw new Error('[Vault] Failed to serialize encrypted blob');
    }
    await this._store.set(name, serialized);
  }

  /** Retrieve and decrypt a secret */
  async retrieve(name: string): Promise<string> {
    const raw = await this._store.get(name);
    if (!raw) throw new Error(`[Vault] Secret "${name}" not found`);
    // A truncated/corrupt entry would otherwise throw a raw `SyntaxError`,
    // which is indistinguishable from a wrong-key auth failure (the GCM
    // `decrypt` throws too). Surface a distinct, named error so operators can
    // tell "vault file is damaged" apart from "wrong master key".
    let blob: EncryptedBlob;
    try {
      blob = JSON.parse(raw) as EncryptedBlob;
    } catch {
      throw new Error(`[Vault] Secret "${name}" is corrupt (invalid JSON blob)`);
    }
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

    // Snapshot the ORIGINAL serialized blob of every secret up front. Rollback
    // then restores these exact bytes verbatim — no decrypt/re-encrypt round
    // trip. The previous rollback re-encrypted with the old key, so if the
    // rollback path itself threw (e.g. a corrupt intermediate blob) a secret
    // could be left written under `newKey` while `this.key` stays old →
    // permanently undecryptable. Restoring the captured originals makes
    // rollback I/O-only and side-effect-free on the crypto state.
    const originals = new Map<string, string>();
    for (const name of names) {
      const raw = await this._store.get(name);
      if (raw != null) originals.set(name, raw);
    }

    const reEncrypted: string[] = [];

    try {
      for (const name of names) {
        const plaintext = await this.retrieve(name);
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
        reEncrypted.push(name);
      }

      this.key = newKey;
      this.keyVersion += 1;
    } catch (err) {
      // Atomic rollback: write back the captured original bytes for every blob
      // we touched. No key state changes (this.key is untouched on the failure
      // path), so the vault is exactly as it was before the rotation attempt.
      for (const name of reEncrypted) {
        const original = originals.get(name);
        if (original == null) continue;
        try {
          await this._store.set(name, original);
        } catch (rollbackErr) {
          console.error(`[Vault] Rollback failed for "${name}", data may be inconsistent:`, rollbackErr);
        }
      }
      throw err;
    }
  }
}
