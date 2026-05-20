/**
 * LLMContextSummarizer — auto-compact conversation context.
 *
 * Triggers summarization when token estimate exceeds threshold or
 * unsummarized message count crosses limit. Replaces older turns with
 * a system-message summary while preserving recent N messages verbatim.
 *
 * Token estimate: 1 token ≈ 4 chars + per-message overhead. Image blocks
 * counted at fixed estimate. Industry-standard heuristic — exact count
 * comes from provider after the call.
 */

import { type Message } from './types';

const SUMMARY_MARKER = '\u200B'; // zero-width space prefix marks auto-generated summary

const CHARS_PER_TOKEN = 4;
const TOKEN_OVERHEAD_PER_MESSAGE = 10;
const IMAGE_TOKEN_ESTIMATE = 500;

export const DEFAULT_SUMMARIZATION_PROMPT = `You are summarizing a conversation between a user and an AI assistant.

Your task:
1. Preserve key facts, decisions, agreements, user preferences, unresolved items.
2. Use clear factual statements, group related info, prioritize what may be referenced later.
3. Omit greetings, small talk, redundant or resolved tangents.

Output only the summary, no other text.`;

export type SummarizeFn = (
  messagesToSummarize: Message[],
  prompt: string,
  maxTokens: number,
) => Promise<string>;

export type AutoSummarizeOptions = {
  maxContextTokens?: number | null;
  maxUnsummarizedMessages?: number | null;
  targetSummaryTokens?: number;
  minMessagesAfterSummary?: number;
  summarizationPrompt?: string;
  summaryMessageTemplate?: string;
};

export class LLMContextSummarizer {
  private readonly maxContextTokens: number | null;
  private readonly maxUnsummarizedMessages: number | null;
  private readonly targetSummaryTokens: number;
  private readonly minMessagesAfterSummary: number;
  private readonly prompt: string;
  private readonly template: string;
  private readonly summarize: SummarizeFn;

  private unsummarizedCount = 0;
  private inflight: Promise<Message[]> | null = null;

  constructor(summarize: SummarizeFn, opts: AutoSummarizeOptions = {}) {
    this.maxContextTokens = opts.maxContextTokens === undefined ? 8000 : opts.maxContextTokens;
    this.maxUnsummarizedMessages =
      opts.maxUnsummarizedMessages === undefined ? 20 : opts.maxUnsummarizedMessages;
    this.targetSummaryTokens = opts.targetSummaryTokens ?? 6000;
    this.minMessagesAfterSummary = opts.minMessagesAfterSummary ?? 4;
    this.prompt = opts.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
    this.template = opts.summaryMessageTemplate ?? 'Conversation summary: {summary}';
    this.summarize = summarize;

    if (this.maxContextTokens === null && this.maxUnsummarizedMessages === null) {
      throw new Error('at least one of maxContextTokens / maxUnsummarizedMessages must be set');
    }
    if (this.maxContextTokens !== null && this.maxContextTokens <= 0) {
      throw new Error('maxContextTokens must be positive');
    }
    if (this.maxUnsummarizedMessages !== null && this.maxUnsummarizedMessages < 1) {
      throw new Error('maxUnsummarizedMessages must be ≥ 1');
    }
    if (this.targetSummaryTokens <= 0) {
      throw new Error('targetSummaryTokens must be positive');
    }
    if (this.minMessagesAfterSummary < 0) {
      throw new Error('minMessagesAfterSummary must be ≥ 0');
    }
  }

  /** Track that a new message was added (for the threshold counter). */
  trackAppended(): void {
    this.unsummarizedCount++;
  }

  /** Whether either threshold is crossed. */
  shouldSummarize(messages: Message[]): boolean {
    if (this.maxUnsummarizedMessages !== null && this.unsummarizedCount >= this.maxUnsummarizedMessages) {
      return true;
    }
    if (this.maxContextTokens !== null && estimateTokens(messages) >= this.maxContextTokens) {
      return true;
    }
    return false;
  }

  /**
   * Compress messages to [originalSystem?, summary, ...recentN]. Idempotent:
   * if thresholds not crossed, returns input unchanged. Replaces any prior
   * auto-generated summary instead of stacking them.
   *
   * Concurrent compact() calls share the in-flight summarization (no duplicate
   * LLM cost) — second caller awaits the same promise.
   */
  async compact(messages: Message[]): Promise<Message[]> {
    if (!this.shouldSummarize(messages)) return messages;
    if (this.inflight) return this.inflight;
    this.inflight = this.doCompact(messages).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doCompact(messages: Message[]): Promise<Message[]> {
    // Strip prior auto-generated summary so successive compactions don't stack.
    const filtered = messages.filter((m) => !isAutoSummary(m));
    const systemMessages = filtered.filter((m) => m.role === 'system');
    const nonSystem = filtered.filter((m) => m.role !== 'system');

    const keepCount = Math.min(this.minMessagesAfterSummary, nonSystem.length);
    const toSummarize = nonSystem.slice(0, nonSystem.length - keepCount);
    const recent = nonSystem.slice(nonSystem.length - keepCount);

    if (toSummarize.length === 0) return messages;

    const summaryText = await this.summarize(toSummarize, this.prompt, this.targetSummaryTokens);
    const summaryMessage: Message = {
      role: 'system',
      content: SUMMARY_MARKER + this.template.replace('{summary}', summaryText),
    };

    this.unsummarizedCount = recent.length;
    return [...systemMessages, summaryMessage, ...recent];
  }
}

/** True if message was generated by this summarizer (zero-width prefix). */
export function isAutoSummary(msg: Message): boolean {
  return msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(SUMMARY_MARKER);
}

/** Strip the auto-summary marker for display / wire serialization. */
export function stripSummaryMarker(content: string): string {
  return content.startsWith(SUMMARY_MARKER) ? content.slice(SUMMARY_MARKER.length) : content;
}

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += TOKEN_OVERHEAD_PER_MESSAGE;
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / CHARS_PER_TOKEN);
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
        } else if (block.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        } else if (block.type === 'tool_result') {
          total += Math.ceil(block.content.length / CHARS_PER_TOKEN);
        } else if (block.type === 'tool_use') {
          total += Math.ceil(JSON.stringify(block.input).length / CHARS_PER_TOKEN);
        }
      }
    }
    total += Math.ceil(msg.role.length / CHARS_PER_TOKEN);
  }
  return total;
}
