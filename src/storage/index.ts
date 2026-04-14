/**
 * @parle/ai-gateway/object-storage
 *
 * Generic object storage abstraction. Implementations: S3 (with R2 / B2 /
 * AWS / MinIO / DigitalOcean Spaces helpers).
 */

export type {
  ObjectStore,
  ObjectMetadata,
  PresignOptions,
  PutOptions,
  PutBody,
  ListOptions,
  ListEntry,
  ListResult,
} from './types';

export { createS3Store } from './s3-store';
export type { S3StoreConfig } from './s3-store';

export { createR2Store } from './r2-store';
export type { R2StoreConfig } from './r2-store';

export { createB2Store } from './b2-store';
export type { B2StoreConfig } from './b2-store';
