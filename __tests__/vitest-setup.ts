/**
 * Vitest global setup — runs before each test file is loaded.
 * Populates process.env from .env files and the encrypted vault so that
 * describe.skipIf(!process.env.KEY) checks work correctly.
 */
import { loadEnv } from './helpers';

await loadEnv();
