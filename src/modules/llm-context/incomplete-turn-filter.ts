/**
 * Incomplete-turn filter — LLM-based detection that suppresses bot speech
 * when the user was cut off mid-thought.
 *
 * Ported from pipecat's filter_incomplete_user_turns. The LLM emits a marker
 * as the FIRST character of its response:
 *   ✓ — Complete: user finished, respond normally
 *   ○ — Incomplete-short: user cut off mid-sentence; suppress + wait `shortTimeoutMs`
 *   ◐ — Incomplete-long: user needs thinking time; suppress + wait `longTimeoutMs`
 *
 * Usage:
 *   const filter = new IncompleteTurnFilter();
 *   const enrichedSystemPrompt = filter.augmentSystemPrompt(originalSystem);
 *   // Send enrichedSystemPrompt to LLM, then:
 *   const decision = filter.classify(llmResponseText);
 *   if (decision.kind === 'complete') emit(decision.cleanedText);
 *   else scheduleReprompt(decision.timeoutMs);
 *
 * Why this works without ONNX/audio: the LLM is already trained on
 * conversational data and can recognize incomplete utterances from text
 * alone. Zero new dependencies, ~50ms overhead (one extra emitted token).
 */

export type TurnCompleteness = 'complete' | 'incomplete_short' | 'incomplete_long';

export interface TurnDecision {
  kind: TurnCompleteness;
  /** Response text with the marker stripped — what the caller should emit. */
  cleanedText: string;
  /** Timeout (ms) before re-prompting if incomplete. 0 if complete. */
  timeoutMs: number;
}

export interface IncompleteTurnFilterOptions {
  /** Timeout for `○` short-incomplete (cut off mid-sentence). Default 5000ms. */
  shortTimeoutMs?: number;
  /** Timeout for `◐` long-incomplete (thinking pause). Default 10000ms. */
  longTimeoutMs?: number;
  /** Override marker characters if your LLM trips on Unicode. */
  markers?: { complete: string; short: string; long: string };
}

const DEFAULT_MARKERS = { complete: '✓', short: '○', long: '◐' };

const MARKER_INSTRUCTION = `\n\n## Turn-completeness marker\n\nBefore your reply, emit ONE character indicating whether the user's last message is a complete thought:\n  ✓ — complete (respond normally)\n  ○ — incomplete, cut off mid-sentence (do not respond, just emit ○)\n  ◐ — incomplete, user pausing to think (do not respond, just emit ◐)\n\nThe marker MUST be the very first character. After ✓ continue with your full reply on the same line. After ○ or ◐ output ONLY the marker — no other text.`;

export class IncompleteTurnFilter {
  private readonly shortTimeoutMs: number;
  private readonly longTimeoutMs: number;
  private readonly markers: { complete: string; short: string; long: string };

  constructor(opts: IncompleteTurnFilterOptions = {}) {
    this.shortTimeoutMs = opts.shortTimeoutMs ?? 5000;
    this.longTimeoutMs = opts.longTimeoutMs ?? 10000;
    this.markers = opts.markers ?? DEFAULT_MARKERS;
  }

  /** Append the marker instruction to the operator's system prompt. */
  augmentSystemPrompt(systemPrompt: string): string {
    return `${systemPrompt}${MARKER_INSTRUCTION}`;
  }

  /** Classify a finished LLM response. Strips the marker from cleanedText. */
  classify(response: string): TurnDecision {
    const trimmed = response.trimStart();
    const first = trimmed.charAt(0);
    if (first === this.markers.short) {
      return { kind: 'incomplete_short', cleanedText: '', timeoutMs: this.shortTimeoutMs };
    }
    if (first === this.markers.long) {
      return { kind: 'incomplete_long', cleanedText: '', timeoutMs: this.longTimeoutMs };
    }
    if (first === this.markers.complete) {
      return { kind: 'complete', cleanedText: trimmed.slice(1).trimStart(), timeoutMs: 0 };
    }
    // No marker — treat as complete to fail-open (don't gag a model that
    // ignores the instruction; returning a strict error would deny replies).
    return { kind: 'complete', cleanedText: response, timeoutMs: 0 };
  }

  /**
   * Streaming variant — call with each token as it arrives. Returns:
   *   - { kind: 'pending' } until the first token tells us the disposition
   *   - { kind: 'complete', emit } once the marker is consumed and tokens
   *     should be forwarded
   *   - { kind: 'incomplete_*', timeoutMs } if the leading marker is ○/◐
   *     (caller stops the stream and schedules re-prompt)
   */
  createStreamGate(): {
    feed: (chunk: string) => StreamGateDecision;
    finalize: () => StreamGateDecision;
  } {
    let buffer = '';
    let resolved = false;
    let kind: TurnCompleteness | null = null;
    return {
      feed: (chunk: string): StreamGateDecision => {
        if (resolved && kind === 'complete') return { kind: 'complete', emit: chunk };
        if (resolved && kind !== 'complete') return { kind: 'suppress' };
        buffer += chunk;
        const trimmed = buffer.trimStart();
        if (trimmed.length === 0) return { kind: 'pending' };
        const first = trimmed.charAt(0);
        if (first === this.markers.short) {
          resolved = true;
          kind = 'incomplete_short';
          return { kind: 'incomplete_short', timeoutMs: this.shortTimeoutMs };
        }
        if (first === this.markers.long) {
          resolved = true;
          kind = 'incomplete_long';
          return { kind: 'incomplete_long', timeoutMs: this.longTimeoutMs };
        }
        if (first === this.markers.complete) {
          resolved = true;
          kind = 'complete';
          // Strip the marker plus one optional whitespace, emit the rest.
          const afterMarker = trimmed.slice(1).replace(/^[ \t]/, '');
          return { kind: 'complete', emit: afterMarker };
        }
        // First non-whitespace char is not a marker — fail open. Forward
        // everything buffered so far as-is.
        resolved = true;
        kind = 'complete';
        return { kind: 'complete', emit: buffer };
      },
      finalize: (): StreamGateDecision => {
        if (resolved) return { kind: 'complete', emit: '' };
        // Stream ended before any character arrived — treat as complete
        // (empty response). Don't trigger spurious re-prompt.
        return { kind: 'complete', emit: '' };
      },
    };
  }
}

export type StreamGateDecision =
  | { kind: 'pending' }
  | { kind: 'complete'; emit: string }
  | { kind: 'incomplete_short'; timeoutMs: number }
  | { kind: 'incomplete_long'; timeoutMs: number }
  | { kind: 'suppress' };
