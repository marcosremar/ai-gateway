/**
 * Test cost tracking — tracks $ spent on integration tests that hit real APIs.
 *
 * Use this to monitor and alert on test spending, especially for
 * expensive provider calls (Groq Whisper, OpenAI GPT-4, etc.).
 *
 * @example
 * ```ts
 * import { testCost, recordTestCost } from './test-cost';
 *
 * it('should transcribe audio via Groq', async () => {
 *   recordTestCost('groq-stt', 0.006); // $0.006 per minute of audio
 *   const result = await groqSTT.transcribe({ audio });
 *   expect(result.text).toBeDefined();
 * });
 *
 * afterEach(() => {
 *   const cost = testCost.getTotal();
 *   if (cost > 1.00) {
 *     throw new Error(`Test cost exceeded $1: $${cost.toFixed(2)}`);
 *   }
 * });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('test-cost');

export interface CostEntry {
  /** Provider/service name */
  provider: string;
  /** Cost in USD */
  costUsd: number;
  /** Test name */
  test?: string;
  /** Timestamp */
  timestamp?: string;
}

/** Cost tracking state */
const entries: CostEntry[] = [];
let totalSpent = 0;

/**
 * Estimated costs per provider operation.
 * These are rough estimates — check provider billing for exact rates.
 */
export const ESTIMATED_COSTS: Record<string, number> = {
  // STT (per minute of audio)
  'groq-stt': 0.006, // Whisper-large-v3
  'openai-stt': 0.006, // Whisper-1

  // LLM (per 1K tokens)
  'groq-llm': 0.0009, // LLaMA 70B
  'openai-llm': 0.003, // GPT-4o

  // TTS (per 1K characters)
  'groq-tts': 0.0015, // Orpheus
  'openai-tts': 0.015, // TTS-1

  // GPU (per hour)
  'gpu-runpod': 0.74, // RTX 4090
  'gpu-vast': 0.44, // RTX 4090
  'gpu-modal': 0.0008, // Per second serverless
};

/**
 * Record a test cost.
 */
export function recordTestCost(provider: string, costUsd: number, test?: string): void {
  const entry: CostEntry = {
    provider,
    costUsd,
    test,
    timestamp: new Date().toISOString(),
  };

  entries.push(entry);
  totalSpent += costUsd;

  log.log({ provider, costUsd, test, total: totalSpent }, 'Test cost recorded');
}

/**
 * Record a test cost using estimated provider rates.
 */
export function recordTestOperation(provider: string, operation: string, test?: string): void {
  const key = `${provider}-${operation}`;
  const cost = ESTIMATED_COSTS[key] ?? 0;

  if (cost > 0) {
    recordTestCost(key, cost, test);
  } else {
    log.log({ key }, 'Unknown cost key — recording $0');
  }
}

/**
 * Get cost tracking summary.
 */
export const testCost = {
  /** Total spent in current session */
  getTotal(): number {
    return totalSpent;
  },

  /** Get entries */
  getEntries(): CostEntry[] {
    return [...entries];
  },

  /** Get spending by provider */
  getByProvider(): Record<string, number> {
    const byProvider: Record<string, number> = {};
    for (const entry of entries) {
      byProvider[entry.provider] = (byProvider[entry.provider] ?? 0) + entry.costUsd;
    }
    return byProvider;
  },

  /** Reset tracking */
  reset(): void {
    entries.length = 0;
    totalSpent = 0;
  },

  /** Check if spending exceeds threshold */
  exceeds(thresholdUsd: number): boolean {
    return totalSpent > thresholdUsd;
  },

  /** Log spending summary */
  logSummary(): void {
    log.log(
      { total: totalSpent, byProvider: this.getByProvider(), entries: entries.length },
      'Test cost summary',
    );
  },
};

/**
 * Vitest hook: Fail if test cost exceeds threshold.
 *
 * Add to `vitest-setup.ts`:
 * ```ts
 * import { addCostThresholdHook } from '@ai-gateway/test-cost';
 * addCostThresholdHook(1.00); // $1 max per test run
 * ```
 */
export function addCostThresholdHook(maxCostUsd: number): void {
  if (typeof afterEach === 'function') {
    afterEach(() => {
      if (testCost.exceeds(maxCostUsd)) {
        const summary = testCost.getByProvider();
        throw new Error(
          `Test cost exceeded $${maxCostUsd.toFixed(2)}: $${testCost.getTotal().toFixed(2)}\n` +
            `Breakdown: ${JSON.stringify(summary)}`,
        );
      }
    });
  }
}
