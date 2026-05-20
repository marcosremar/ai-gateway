/**
 * DebugLogObserver — verbose frame logger. Useful in dev to see exactly
 * what the pipeline emits.
 *
 * Usage:
 *   attachObserver(new DebugLogObserver({ filter: ['llm_first_token', 'tts_first_audio'] }));
 */

import { BaseObserver, type PipelineFrame, type FrameKind } from './base';

export interface DebugLogObserverOptions {
  /** Only log these frame kinds (default: all). */
  filter?: FrameKind[];
  /** Custom logger (default: console.log). */
  log?: (line: string) => void;
}

export class DebugLogObserver extends BaseObserver {
  readonly name = 'debug-log';
  private readonly filter?: Set<FrameKind>;
  private readonly log: (line: string) => void;

  constructor(opts: DebugLogObserverOptions = {}) {
    super();
    this.filter = opts.filter ? new Set(opts.filter) : undefined;
    this.log = opts.log ?? ((line) => { console.log(line); });
  }

  onFrame(frame: PipelineFrame): void {
    if (this.filter && !this.filter.has(frame.kind)) return;
    const tag = frame.stage ? `[${frame.stage}]` : '';
    const prov = frame.provider ? ` ${frame.provider}` : '';
    const meta = frame.meta ? ` ${JSON.stringify(frame.meta).slice(0, 200)}` : '';
    this.log(`[${frame.ts}] ${tag}${prov} ${frame.kind}${meta}`);
  }
}
