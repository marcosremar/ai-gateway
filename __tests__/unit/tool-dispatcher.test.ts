import { describe, it, expect, vi } from 'vitest';
import { ToolDispatcher, type ToolHandler } from '../../src/llm-context';
import type { Message, ToolUseBlock, ToolResultBlock } from '../../src/llm-context';

function asAssistant(blocks: Array<ToolUseBlock | { type: 'text'; text: string }>): Message {
  return { role: 'assistant', content: blocks };
}

describe('ToolDispatcher', () => {
  it('returns empty result when no tool_use blocks', async () => {
    const d = new ToolDispatcher();
    const r = await d.run(asAssistant([{ type: 'text', text: 'hello' }]));
    expect(r.invoked).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.errors).toBe(0);
  });

  it('invokes registered tool and returns tool_result with stringified output', async () => {
    const d = new ToolDispatcher([{
      name: 'get_weather',
      invoke: async (input) => ({ city: input.city, temp_c: 22 }),
    }]);
    const r = await d.run(asAssistant([{
      type: 'tool_use',
      id: 'tu1',
      name: 'get_weather',
      input: { city: 'Lisbon' },
    }]));
    expect(r.invoked).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.results).toHaveLength(1);
    const res = r.results[0] as ToolResultBlock;
    expect(res.toolUseId).toBe('tu1');
    expect(res.content).toContain('Lisbon');
    expect(res.content).toContain('22');
  });

  it('emits error tool_result for unregistered tool', async () => {
    const d = new ToolDispatcher();
    const r = await d.run(asAssistant([{
      type: 'tool_use',
      id: 'tu2',
      name: 'unknown_tool',
      input: {},
    }]));
    expect(r.invoked).toBe(1);
    expect(r.errors).toBe(1);
    const res = r.results[0] as ToolResultBlock;
    expect(res.content).toContain('not registered');
  });

  it('catches handler exceptions as error tool_result (does not throw)', async () => {
    const d = new ToolDispatcher([{
      name: 'broken',
      invoke: async () => { throw new Error('intentional'); },
    }]);
    const r = await d.run(asAssistant([{ type: 'tool_use', id: 'tu3', name: 'broken', input: {} }]));
    expect(r.errors).toBe(1);
    expect((r.results[0] as ToolResultBlock).content).toContain('Error: intentional');
  });

  it('runs multiple tools in parallel', async () => {
    const t0 = Date.now();
    const d = new ToolDispatcher([
      { name: 'a', invoke: async () => { await new Promise(r => setTimeout(r, 50)); return 'A'; } },
      { name: 'b', invoke: async () => { await new Promise(r => setTimeout(r, 50)); return 'B'; } },
    ]);
    const r = await d.run(asAssistant([
      { type: 'tool_use', id: 't1', name: 'a', input: {} },
      { type: 'tool_use', id: 't2', name: 'b', input: {} },
    ]));
    const elapsed = Date.now() - t0;
    expect(r.invoked).toBe(2);
    expect(r.errors).toBe(0);
    // Both ran in parallel (~50ms total, not ~100ms).
    expect(elapsed).toBeLessThan(150);
  });

  it('respects per-tool timeout', async () => {
    vi.useFakeTimers();
    try {
      const d = new ToolDispatcher([{
        name: 'slow',
        timeoutMs: 100,
        invoke: () => new Promise((_, rej) => {
          // Simulate a handler that respects abort signal
          setTimeout(() => rej(new Error('aborted')), 200);
        }),
      }]);
      const promise = d.run(asAssistant([{ type: 'tool_use', id: 'ts', name: 'slow', input: {} }]));
      await vi.advanceTimersByTimeAsync(250);
      const r = await promise;
      expect(r.errors).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('register/unregister adds and removes tools', () => {
    const d = new ToolDispatcher();
    expect(d.getToolNames()).toEqual([]);
    d.register({ name: 'foo', invoke: async () => 'x' });
    expect(d.getToolNames()).toContain('foo');
    expect(d.unregister('foo')).toBe(true);
    expect(d.getToolNames()).toEqual([]);
  });

  it('resultsAsMessage returns tool role message with all results', async () => {
    const d = new ToolDispatcher([
      { name: 'a', invoke: async () => 'A' },
    ]);
    const r = await d.run(asAssistant([{ type: 'tool_use', id: 'x', name: 'a', input: {} }]));
    const msg = d.resultsAsMessage(r);
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe('tool');
    expect(Array.isArray(msg?.content)).toBe(true);
  });

  it('resultsAsMessage returns null when no results', async () => {
    const d = new ToolDispatcher();
    const r = await d.run(asAssistant([]));
    expect(d.resultsAsMessage(r)).toBeNull();
  });
});
