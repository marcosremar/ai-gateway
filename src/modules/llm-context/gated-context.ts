/**
 * GatedContext — buffer messages until external gate signal opens.
 *
 * Use case: VAD says user might still be talking. Don't commit to LLM
 * context until Smart Turn confirms COMPLETE. Mirrors pipecat
 * processors/aggregators/gated_llm_context.py.
 *
 * Pattern:
 *   gate.append(...partial messages while user mid-thought...)
 *   if (smartTurnComplete) await gate.openAndDrain(commit)
 *   else gate.discard()  // user retracted
 */

import { type Message } from './types';

export type CommitFn = (messages: Message[]) => Promise<void> | void;

export class GatedContext {
  private buffer: Message[] = [];
  private open = false;

  /** Add messages to the gate. Released to commit only when openAndDrain() called. */
  append(...messages: Message[]): void {
    for (const m of messages) {
      if (m == null || typeof m !== 'object' || typeof m.role !== 'string') {
        throw new TypeError(`GatedContext.append: invalid message (got ${m === null ? 'null' : typeof m})`);
      }
      this.buffer.push(m);
    }
  }

  /** Buffered messages (read-only snapshot). */
  get pending(): readonly Message[] {
    return this.buffer;
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * Commit all buffered messages via the provided sink, then clear.
   *
   * If commit throws, buffered messages are restored so caller can retry —
   * avoids data loss on transient sink failures (e.g. LLM downtime).
   */
  async openAndDrain(commit: CommitFn): Promise<Message[]> {
    this.open = true;
    const drained = this.buffer.slice();
    this.buffer = [];
    try {
      await commit(drained);
      return drained;
    } catch (err) {
      // Restore drained messages at the front of the (possibly newly-appended)
      // buffer so the conversation order is preserved on retry.
      this.buffer = [...drained, ...this.buffer];
      throw err;
    } finally {
      this.open = false;
    }
  }

  /** Drop buffered messages without committing. Used when user retracts mid-thought. */
  discard(): Message[] {
    const dropped = this.buffer.slice();
    this.buffer = [];
    return dropped;
  }

  /** Number of buffered messages. */
  size(): number {
    return this.buffer.length;
  }
}
