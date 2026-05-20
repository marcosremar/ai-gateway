import { describe, it, expect, vi } from 'vitest';
import { GatedContext } from '../src/llm-context/gated-context';
import type { Message } from '../src/llm-context/types';

const u = (text: string): Message => ({ role: 'user', content: text });

describe('GatedContext', () => {
  it('buffers messages until openAndDrain', async () => {
    const gate = new GatedContext();
    gate.append(u('partial 1'), u('partial 2'));
    expect(gate.size()).toBe(2);
    const sink = vi.fn();
    const drained = await gate.openAndDrain(sink);
    expect(drained).toHaveLength(2);
    expect(sink).toHaveBeenCalledOnce();
    expect(gate.size()).toBe(0);
  });

  it('discard drops buffered without calling sink', () => {
    const gate = new GatedContext();
    gate.append(u('retract me'));
    const dropped = gate.discard();
    expect(dropped).toHaveLength(1);
    expect(gate.size()).toBe(0);
  });

  it('isOpen toggles around drain', async () => {
    const gate = new GatedContext();
    gate.append(u('x'));
    expect(gate.isOpen()).toBe(false);
    let observedOpen = false;
    await gate.openAndDrain(() => {
      observedOpen = gate.isOpen();
    });
    expect(observedOpen).toBe(true);
    expect(gate.isOpen()).toBe(false);
  });
});
