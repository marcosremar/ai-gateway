#!/usr/bin/env bun
/**
 * R2 vs HuggingFace CDN download benchmark
 *
 * Tests whether Cloudflare R2 is meaningfully faster than HuggingFace's
 * CloudFront-backed CDN for downloading model files from a GPU datacenter
 * (Vast.ai). The hypothesis being tested:
 *
 *   "R2 is fast enough that lazy-loading model files at runtime via R2
 *    beats pre-baking them into a 14 GB Docker image."
 *
 * If R2 wins by >25%, we proceed to the next phase (registry on R2 + lazy
 * model loads). If it doesn't, we abandon the R2 angle and look elsewhere.
 *
 * ── How it works ─────────────────────────────────────────────────────────
 *
 * This script runs locally on your laptop. It:
 *
 *   1. Reads R2 credentials from env (or hardcoded fallback for the
 *      `parle-models-bench` bucket).
 *   2. Uses `createR2Store()` from `@parle/ai-gateway/object-storage` to
 *      generate two presigned URLs (PUT for upload, GET for download).
 *      Both have a 2-hour expiry to comfortably outlast the bench.
 *   3. Writes a self-contained `bench.sh` to `/tmp/r2-vs-hf-bench.sh` with
 *      the URLs embedded.
 *   4. Prints instructions for running it on a Vast.ai pod (no rclone or
 *      other deps needed — just curl + python3 which ubuntu:22.04 has).
 *
 * The generated bench.sh:
 *   • Downloads the GGUF from HuggingFace 3 times, recording MB/s each run
 *   • Uploads it once to R2 via the presigned PUT URL
 *   • Downloads it from R2 3 times via the presigned GET URL
 *   • Prints a JSON results block on stdout
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *     bun scripts/r2-vs-hf-bench.ts
 *
 * Then follow the printed instructions to scp+ssh+run on your Vast.ai pod.
 */

import { createR2Store } from '../src/object-storage';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────

const R2 = {
  accountId: process.env.R2_ACCOUNT_ID ?? '142ed673a5cc1a9e91519c099af3d791',
  bucket: process.env.R2_BUCKET ?? 'parle-models-bench',
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? 'f0a6f424064e46c903c76a447f5e73d2',
  secretAccessKey:
    process.env.R2_SECRET_ACCESS_KEY ??
    '1dcf325fe8556fca221cf8b383e277e7af6660a246148d5e11e4fc67e822c9b5',
};

// Public r2.dev URL — only the GET path uses this. The PUT (upload) still
// goes through the presigned S3 endpoint because r2.dev is read-only.
// Set R2_PUBLIC_BASE='' to fall back to presigned-S3 for both directions.
const R2_PUBLIC_BASE =
  process.env.R2_PUBLIC_BASE ?? 'https://pub-66fbf9c8e6e2491e8664ec286d18cbe4.r2.dev';

// The model we benchmark with — same one babelcast-subtitle pre-bakes today.
// Q8_0 GGUF is ~5 GB, large enough to be CDN-bound rather than handshake-bound.
const HF_REPO = 'bullerwins/translategemma-4b-it-GGUF';
const HF_FILE = 'translategemma-4b-it-Q8_0.gguf';
const HF_URL = `https://huggingface.co/${HF_REPO}/resolve/main/${HF_FILE}`;

// Where the file lives in R2. Random suffix avoids collisions across runs.
const R2_KEY = `bench/${Date.now()}/${HF_FILE}`;

// 2-hour presign expiry — long enough for: image pull + apt + 3x HF runs +
// upload + 3x R2 runs + slack.
const EXPIRES_IN = 2 * 60 * 60;

// Output file
const OUT_PATH = '/tmp/r2-vs-hf-bench.sh';

// ── Generate presigned URLs ─────────────────────────────────────────────────

const store = createR2Store(R2);

const putUrl = store.presign(R2_KEY, { method: 'PUT', expiresIn: EXPIRES_IN });
// GET path: prefer the r2.dev public URL (CDN edge fleet) over presigned S3
// (which goes through the bucket origin region — slow when distant from host).
const getUrl = R2_PUBLIC_BASE
  ? `${R2_PUBLIC_BASE}/${R2_KEY}`
  : store.presign(R2_KEY, { method: 'GET', expiresIn: EXPIRES_IN });

// ── Bench script template ───────────────────────────────────────────────────
//
// The bash template lives in a separate file (`r2-vs-hf-bench.sh.tmpl`) to
// avoid template literal escaping wars between JS `${...}` and bash `${...}`.
// We just read it from disk and do straight string replacement on the
// __PLACEHOLDER__ tokens.

const TEMPLATE_PATH = resolve(__dirname, 'r2-vs-hf-bench.sh.tmpl');
const BASH_TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

const bashScript = BASH_TEMPLATE
  .replace(/__GENERATED_AT__/g, new Date().toISOString())
  .replace(/__R2_KEY__/g, R2_KEY)
  .replace(/__EXPIRES_AT__/g, new Date(Date.now() + EXPIRES_IN * 1000).toISOString())
  .replace(/__HF_URL__/g, HF_URL)
  .replace(/__R2_PUT_URL__/g, putUrl)
  .replace(/__R2_GET_URL__/g, getUrl)
  .replace(/__HF_FILE__/g, HF_FILE);

// ── Write the script ────────────────────────────────────────────────────────

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, bashScript, { mode: 0o755 });

// ── Print instructions ──────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log(' R2 vs HF bench — setup complete');
console.log('═══════════════════════════════════════════════════════════════');
console.log();
console.log(' Bucket:    ' + R2.bucket);
console.log(' Object:    ' + R2_KEY);
console.log(' Expires:   ' + new Date(Date.now() + EXPIRES_IN * 1000).toISOString());
console.log(' Bench script written to: ' + OUT_PATH);
console.log();
console.log('━━ Next steps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log();
console.log(' 1. Deploy a Vast.ai pod (any GPU is fine — we only need bandwidth).');
console.log('    The cheapest box on a fast US/EU host with >2 Gb/s downlink is enough.');
console.log();
console.log(' 2. SCP the bench script to the pod:');
console.log('       scp -P <ssh_port> ' + OUT_PATH + ' root@<ssh_host>:/tmp/');
console.log();
console.log(' 3. SSH in and run it:');
console.log('       ssh -p <ssh_port> root@<ssh_host>');
console.log('       bash /tmp/r2-vs-hf-bench.sh');
console.log();
console.log(' 4. Capture the JSON_RESULT block at the bottom for the report.');
console.log();
console.log(' After the bench, delete the R2 object to reclaim space:');
console.log('       bun -e "import {createR2Store} from \'./src/object-storage\'; \\');
console.log('              const s=createR2Store({...}); await s.delete(\'' + R2_KEY + '\')"');
console.log();
