/**
 * Pipeline Orchestrator — manages multi-stage processing pipelines.
 *
 * Fixes: #933-935 (pipeline pattern, CQRS, event sourcing)
 *
 * Usage:
 * ```ts
 * import { createPipeline } from './pipeline-orchestrator';
 *
 * const pipeline = createPipeline<string, Result>('speech-pipeline');
 *
 * // Add stages
 * pipeline.stage('stt', sttProcessor);
 * pipeline.stage('llm', llmProcessor);
 * pipeline.stage('tts', ttsProcessor);
 *
 * // Execute
 * const result = await pipeline.execute(audioData);
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('pipeline');

export type StageFn<Input, Output> = (input: Input, context: PipelineContext) => Promise<Output>;

export interface PipelineContext {
  /** Unique execution ID */
  executionId: string;
  /** Start timestamp */
  startedAt: Date;
  /** Shared metadata */
  metadata: Record<string, unknown>;
}

export interface StageResult {
  name: string;
  output: unknown;
  durationMs: number;
  status: 'success' | 'skipped' | 'failed';
  error?: Error;
}

export interface PipelineStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  avgDurationMs: number;
}

class Pipeline<Input, Output> {
  private stages: Array<{ name: string; fn: StageFn<unknown, unknown> }> = [];
  private name: string;
  private stats: PipelineStats = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    avgDurationMs: 0,
  };

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Add a stage to the pipeline.
   */
  stage<TIn, TOut>(name: string, fn: StageFn<TIn, TOut>): this {
    this.stages.push({ name, fn: fn as StageFn<unknown, unknown> });
    return this;
  }

  /**
   * Execute the pipeline.
   */
  async execute(input: Input, metadata: Record<string, unknown> = {}): Promise<Output> {
    const start = Date.now();
    this.stats.totalExecutions++;

    const context: PipelineContext = {
      executionId: `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date(),
      metadata,
    };

    const results: StageResult[] = [];
    let currentInput: unknown = input;

    try {
      for (const stage of this.stages) {
        const stageStart = Date.now();

        try {
          const output = await stage.fn(currentInput, context);
          results.push({
            name: stage.name,
            output,
            durationMs: Date.now() - stageStart,
            status: 'success',
          });
          currentInput = output;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          results.push({
            name: stage.name,
            output: null,
            durationMs: Date.now() - stageStart,
            status: 'failed',
            error: err,
          });

          log.error(
            { pipeline: this.name, stage: stage.name, error: err.message, executionId: context.executionId },
            'Pipeline stage failed',
          );

          this.stats.failedExecutions++;
          throw err;
        }
      }

      this.stats.successfulExecutions++;
      this.updateStats(Date.now() - start);

      log.log(
        {
          pipeline: this.name,
          executionId: context.executionId,
          durationMs: Date.now() - start,
          stages: results.length,
        },
        'Pipeline completed',
      );

      return currentInput as Output;
    } finally {
      log.debug(
        {
          pipeline: this.name,
          executionId: context.executionId,
          results: results.map((r) => ({
            name: r.name,
            status: r.status,
            durationMs: r.durationMs,
          })),
        },
        'Pipeline execution details',
      );
    }
  }

  /**
   * Execute with fallback — if pipeline fails, run fallback function.
   */
  async executeWithFallback(
    input: Input,
    fallback: () => Promise<Output>,
    metadata: Record<string, unknown> = {},
  ): Promise<Output> {
    try {
      return await this.execute(input, metadata);
    } catch {
      log.warn({ pipeline: this.name }, 'Pipeline failed, running fallback');
      return fallback();
    }
  }

  /**
   * Get pipeline statistics.
   */
  getStats(): PipelineStats {
    return { ...this.stats };
  }

  /**
   * Get stage names.
   */
  getStageNames(): string[] {
    return this.stages.map((s) => s.name);
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      avgDurationMs: 0,
    };
  }

  private updateStats(durationMs: number): void {
    const n = this.stats.successfulExecutions;
    this.stats.avgDurationMs = this.stats.avgDurationMs + (durationMs - this.stats.avgDurationMs) / n;
  }
}

/**
 * Create a new pipeline.
 */
export function createPipeline<Input, Output>(name: string): Pipeline<Input, Output> {
  return new Pipeline<Input, Output>(name);
}
