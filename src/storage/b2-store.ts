/**
 * Backblaze B2 convenience constructor.
 *
 * B2's S3-compatible API exposes endpoints like
 *   https://s3.<region>.backblazeb2.com
 * where region is one of: us-west-000, us-west-001, us-west-002, us-west-004,
 * eu-central-003, etc. The region is the part of your bucket's S3 endpoint
 * URL between "s3." and ".backblazeb2.com".
 *
 * Application keys are created under
 *   B2 Cloud Storage → Application Keys → "Add a New Application Key"
 *
 * @example
 * import { createB2Store } from '@parle/ai-gateway/object-storage';
 *
 * const b2 = createB2Store({
 *   region: 'eu-central-003',
 *   bucket: 'parle-recordings',
 *   keyId: process.env.B2_KEY_ID!,
 *   applicationKey: process.env.B2_APPLICATION_KEY!,
 * });
 */

import type { ObjectStore } from './types';
import { createS3Store } from './s3-store';

export interface B2StoreConfig {
  /** B2 region, e.g. "us-west-000", "eu-central-003". */
  region: string;
  /** Bucket name. */
  bucket: string;
  /** B2 application key ID (S3 access key ID equivalent). */
  keyId: string;
  /** B2 application key (S3 secret access key equivalent). */
  applicationKey: string;
  /** Override endpoint URL. Default builds from region. */
  endpoint?: string;
}

export function createB2Store(config: B2StoreConfig): ObjectStore {
  return createS3Store({
    bucket: config.bucket,
    endpoint: config.endpoint ?? `https://s3.${config.region}.backblazeb2.com`,
    accessKeyId: config.keyId,
    secretAccessKey: config.applicationKey,
    region: config.region,
  });
}
