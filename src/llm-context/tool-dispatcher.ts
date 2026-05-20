/**
 * ToolDispatcher — pipecat-style function calling for streaming chat loops.
 *
 * Pattern: caller registers tools (handler functions). When the LLM emits a
 * tool_use block, the dispatcher invokes the handler, captures the result,
 * and emits a tool_result message that can be appended to context for the
 * next LLM round.
 *
 * Why this is more than just "call a function":
 *   - Concurrency: multiple tool_use blocks per turn fire in parallel.
 *   - Timeout: per-tool deadline so a stuck handler doesn't hang the chat.
 *   - Argument validation via supplied JSON Schema (Zod-lite, optional).
 *   - Errors are converted to tool_result blocks (LLM can recover) instead
 *     of throwing through the chat loop.
 *
 * Not bundled here: actual chat loop integration. Call sites:
 *   1. emit ChatRequest → get response
 *   2. extract tool_use from response.content
 *   3. dispatch.run(tools, request.messages) → tool_result messages
 *   4. append assistant + tool_result messages, re-call LLM
 *   5. repeat until no tool_use OR max iterations reached
 */

import type { ToolUseBlock, ToolResultBlock, Message, ContentBlock } from './types';

export interface ToolHandler {
  /** Tool name as referenced by the LLM (must match the schema name). */
  name: string;
  /** Human-readable description sent to the LLM with the tool definition. */
  description?: string;
  /** Handler — receives parsed input, returns string or JSON-serializable. */
  invoke: (input: Record<string, unknown>, ctx: { signal?: AbortSignal; toolUseId: string }) => Promise<unknown>;
  /** Per-call timeout (ms). Default 30s. */
  timeoutMs?: number;
}

export interface ToolDispatchResult {
  results: ToolResultBlock[];
  /** Number of tools invoked (may differ from results.length if some had no
   *  matching handler — those still produce error tool_result blocks). */
  invoked: number;
  /** Aggregate error count. */
  errors: number;
  /** Per-tool execution times in ms. */
  timings: Array<{ name: string; ms: number; ok: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ToolDispatcher {
  private readonly tools: Map<string, ToolHandler>;

  constructor(tools: ToolHandler[] = []) {
    this.tools = new Map(tools.map(t => [t.name, t]));
  }

  /** Add or replace a tool. */
  register(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Names of registered tools — passed to the LLM as the function list. */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Run all tool_use blocks from `assistantMessage.content` in parallel.
   * Returns tool_result blocks ready to append as a `tool` role message.
   *
   * If the LLM call returned no tool_use, returns empty results.
   */
  async run(assistantMessage: Message, opts?: { signal?: AbortSignal }): Promise<ToolDispatchResult> {
    const blocks = (assistantMessage.content || []) as ContentBlock[];
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    const results: ToolResultBlock[] = [];
    const timings: Array<{ name: string; ms: number; ok: boolean }> = [];
    let errors = 0;

    await Promise.allSettled(toolUses.map(async (block) => {
      const t0 = Date.now();
      const handler = this.tools.get(block.name);
      if (!handler) {
        results.push({
          type: 'tool_result',
          toolUseId: block.id,
          content: `Tool "${block.name}" not registered. Available: ${this.getToolNames().join(', ') || 'none'}`,
        });
        timings.push({ name: block.name, ms: Date.now() - t0, ok: false });
        errors++;
        return;
      }

      const timeoutMs = handler.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      // Combine caller-provided signal with our timeout.
      if (opts?.signal) {
        if (opts.signal.aborted) ctrl.abort();
        opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      }

      try {
        const out = await handler.invoke(block.input || {}, { signal: ctrl.signal, toolUseId: block.id });
        clearTimeout(timer);
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        results.push({
          type: 'tool_result',
          toolUseId: block.id,
          content: text,
        });
        timings.push({ name: block.name, ms: Date.now() - t0, ok: true });
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          type: 'tool_result',
          toolUseId: block.id,
          content: `Error: ${msg}`,
        });
        timings.push({ name: block.name, ms: Date.now() - t0, ok: false });
        errors++;
      }
    }));

    return { results, invoked: toolUses.length, errors, timings };
  }

  /**
   * Wrap dispatch result as a `tool` role message ready to append to context.
   * Returns null if no tools were invoked (caller can skip the round-trip).
   */
  resultsAsMessage(result: ToolDispatchResult): Message | null {
    if (result.results.length === 0) return null;
    return {
      role: 'tool',
      content: result.results,
    };
  }
}
