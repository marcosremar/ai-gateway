/**
 * @ai-gateway/llm-context — universal LLM context management.
 *
 * Ported from pipecat-ai/pipecat (BSD 2-Clause). Provides:
 *   - SentenceAggregator       streaming token → sentence chunking for TTS
 *   - PatternPairAggregator    extract <thinking> / structured blocks
 *   - LLMContextSummarizer     auto-compact long conversations
 *   - GatedContext             buffer until external signal (e.g. Smart Turn)
 *   - adapters/                Anthropic / OpenAI / Gemini format converters
 */

export type {
  Role,
  Message,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  Aggregation,
  AggregationType,
  PatternMatch,
} from './types';
export { SENTENCE_ENDING, messageText, parseDataUrl, assertToolMessageValid } from './types';

export { SentenceAggregator } from './sentence-aggregator';
export type { SentenceAggregatorOptions } from './sentence-aggregator';

export { PatternPairAggregator } from './pattern-pair-aggregator';
export type { MatchAction, PatternHandler, PatternPairOptions } from './pattern-pair-aggregator';

export {
  LLMContextSummarizer,
  estimateTokens,
  isAutoSummary,
  stripSummaryMarker,
  DEFAULT_SUMMARIZATION_PROMPT,
} from './context-summarizer';
export type { SummarizeFn, AutoSummarizeOptions } from './context-summarizer';

export { GatedContext } from './gated-context';
export type { CommitFn } from './gated-context';

export { IncompleteTurnFilter } from './incomplete-turn-filter';
export type {
  TurnCompleteness,
  TurnDecision,
  IncompleteTurnFilterOptions,
  StreamGateDecision,
} from './incomplete-turn-filter';

export { ToolDispatcher } from './tool-dispatcher';
export type { ToolHandler, ToolDispatchResult } from './tool-dispatcher';

export * as adapters from './adapters';
