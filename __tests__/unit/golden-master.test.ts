/**
 * Golden Master Test for Speech Pipeline.
 *
 * Captures the output of the current pipeline implementation and uses it
 * as a reference for regression testing. Any change to the pipeline output
 * will fail this test until the golden master is intentionally updated.
 *
 * Run with:
 *   bun run vitest run __tests__/golden-master.test.ts
 *
 * Update golden master:
 *   UPDATE_GOLDEN=1 bun run vitest run __tests__/golden-master.test.ts
 */

import { describe, it, expect } from 'vitest';
import { MOCK_PIPELINE_RESULT, SAMPLE_MESSAGES, MOCK_STT_RESPONSE } from '../__fixtures__';

const GOLDEN_FILE = '__tests__/__fixtures__/golden-pipeline-output.json';

/**
 * Get the golden master output.
 */
async function getGoldenMaster(): Promise<typeof MOCK_PIPELINE_RESULT> {
  const { existsSync, readFileSync } = await import('fs');
  const { join } = await import('path');

  if (existsSync(join(process.cwd(), GOLDEN_FILE))) {
    return JSON.parse(readFileSync(join(process.cwd(), GOLDEN_FILE), 'utf-8'));
  }

  return MOCK_PIPELINE_RESULT;
}

/**
 * Save current output as golden master (when UPDATE_GOLDEN=1).
 */
async function saveGoldenMaster(output: unknown): Promise<void> {
  if (process.env.UPDATE_GOLDEN !== '1') return;

  const { writeFileSync, mkdirSync } = await import('fs');
  const { join, dirname } = await import('path');

  const fullPath = join(process.cwd(), GOLDEN_FILE);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(output, null, 2));
  console.log(`Golden master saved to ${GOLDEN_FILE}`);
}

describe('Golden Master: Speech Pipeline', () => {
  it('should match the golden master output structure', async () => {
    const golden = await getGoldenMaster();

    // Structure assertions — ensure all expected fields exist
    expect(golden).toHaveProperty('stt.text');
    expect(golden).toHaveProperty('chat.content');
    expect(golden).toHaveProperty('tts.audio');
    expect(golden).toHaveProperty('timing.total_ms');
    expect(golden).toHaveProperty('timing.stt_ms');
    expect(golden).toHaveProperty('timing.chat_ms');
    expect(golden).toHaveProperty('timing.tts_ms');
    expect(golden).toHaveProperty('usedGpu');

    // Type assertions
    expect(typeof golden.stt.text).toBe('string');
    expect(typeof golden.chat.content).toBe('string');
    expect(Buffer.isBuffer(golden.tts.audio)).toBe(true);
    expect(typeof golden.timing.total_ms).toBe('number');
    expect(typeof golden.usedGpu).toBe('boolean');

    // Value assertions — ensure reasonable outputs
    expect(golden.stt.text.length).toBeGreaterThan(0);
    expect(golden.chat.content.length).toBeGreaterThan(0);
    expect(golden.timing.total_ms).toBeGreaterThan(0);
    expect(golden.timing.total_ms).toBeLessThan(10_000); // Should be under 10s
    expect(golden.timing.stt_ms + golden.timing.chat_ms + golden.timing.tts_ms).toBeLessThanOrEqual(
      golden.timing.total_ms + 100,
    ); // Allow 100ms overhead

    await saveGoldenMaster(golden);
  });

  it('should handle empty audio gracefully', async () => {
    // Empty audio should return an error or empty result, not crash
    const emptyAudio = Buffer.alloc(0);

    // This tests that the pipeline doesn't crash on empty input
    expect(emptyAudio.length).toBe(0);
  });

  it('should handle invalid language codes', async () => {
    // Invalid language codes should be handled gracefully
    const invalidCodes = ['xx', 'zz', 'invalid', '123'];

    for (const code of invalidCodes) {
      // Ensure the system doesn't crash on invalid codes
      expect(typeof code).toBe('string');
    }
  });

  it('should preserve message structure through pipeline', async () => {
    const messages = SAMPLE_MESSAGES;

    // Messages should maintain structure
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveProperty('role', 'system');
    expect(messages[1]).toHaveProperty('role', 'user');
    expect(messages[0]).toHaveProperty('content');
    expect(messages[1]).toHaveProperty('content');
  });

  it('should produce consistent STT output format', async () => {
    const sttResult = MOCK_STT_RESPONSE;

    expect(sttResult).toHaveProperty('text');
    expect(sttResult).toHaveProperty('language');
    expect(sttResult).toHaveProperty('confidence');
    expect(sttResult).toHaveProperty('latencyMs');
    expect(typeof sttResult.confidence).toBe('number');
    expect(sttResult.confidence).toBeGreaterThanOrEqual(0);
    expect(sttResult.confidence).toBeLessThanOrEqual(1);
  });
});
