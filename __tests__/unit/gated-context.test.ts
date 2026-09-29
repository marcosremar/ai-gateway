import { describe, it, expect, vi } from 'vitest';
import { GatedContext } from '../../src/llm-context/gated-context';
import type { Message } from '../../src/llm-context/types';

const msg = (role: Message['role'], content: string): Message => ({ role, content });

describe('GatedContext — append', () => {
  it('accepts valid user messages', () => {
    const g = new GatedContext();
    g.append(msg('user', 'Hello'));
    expect(g.size()).toBe(1);
  });

  it('accepts multiple messages in one call', () => {
    const g = new GatedContext();
    g.append(msg('user', 'A'), msg('assistant', 'B'), msg('system', 'C'));
    expect(g.size()).toBe(3);
  });

  it('preserves message order', () => {
    const g = new GatedContext();
    g.append(msg('user', 'first'));
    g.append(msg('assistant', 'second'));
    expect(g.pending[0].content).toBe('first');
    expect(g.pending[1].content).toBe('second');
  });

  it('throws TypeError on null message', () => {
    const g = new GatedContext();
    expect(() => g.append(null as unknown as Message)).toThrow(TypeError);
  });

  it('throws TypeError on non-object message', () => {
    const g = new GatedContext();
    expect(() => g.append('string' as unknown as Message)).toThrow(TypeError);
  });

  it('throws TypeError when role is missing', () => {
    const g = new GatedContext();
    expect(() => g.append({ content: 'hi' } as unknown as Message)).toThrow(TypeError);
  });
});

describe('GatedContext — pending (read-only view)', () => {
  it('returns empty array initially', () => {
    const g = new GatedContext();
    expect(g.pending).toHaveLength(0);
  });

  it('reflects appended messages', () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    expect(g.pending).toHaveLength(1);
  });

  it('returns a live reference to the internal buffer (not a defensive copy)', () => {
    // TypeScript marks it `readonly`, but the JS object is the same array.
    // Callers should not mutate it; this test documents the real behaviour.
    const g = new GatedContext();
    g.append(msg('user', 'original'));
    const ref = g.pending;
    expect(ref).toBe(g.pending); // same reference
  });
});

describe('GatedContext — isOpen', () => {
  it('starts closed', () => {
    const g = new GatedContext();
    expect(g.isOpen()).toBe(false);
  });

  it('is closed after discard', () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    g.discard();
    expect(g.isOpen()).toBe(false);
  });

  it('is closed after openAndDrain resolves', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    await g.openAndDrain(async () => {});
    expect(g.isOpen()).toBe(false);
  });
});

describe('GatedContext — discard', () => {
  it('returns the dropped messages', () => {
    const g = new GatedContext();
    g.append(msg('user', 'a'), msg('assistant', 'b'));
    const dropped = g.discard();
    expect(dropped).toHaveLength(2);
    expect(dropped[0].content).toBe('a');
  });

  it('clears the buffer', () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    g.discard();
    expect(g.size()).toBe(0);
  });

  it('returns empty array when nothing buffered', () => {
    const g = new GatedContext();
    expect(g.discard()).toHaveLength(0);
  });
});

describe('GatedContext — openAndDrain', () => {
  it('calls commit with all buffered messages', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'hello'));
    g.append(msg('assistant', 'world'));
    const received: Message[] = [];
    await g.openAndDrain(async (msgs) => { received.push(...msgs); });
    expect(received).toHaveLength(2);
    expect(received[0].content).toBe('hello');
  });

  it('returns the drained messages', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'msg'));
    const drained = await g.openAndDrain(async () => {});
    expect(drained).toHaveLength(1);
    expect(drained[0].content).toBe('msg');
  });

  it('clears the buffer on success', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    await g.openAndDrain(async () => {});
    expect(g.size()).toBe(0);
  });

  it('restores buffer when commit throws', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'saved'));
    await expect(
      g.openAndDrain(async () => { throw new Error('sink down'); }),
    ).rejects.toThrow('sink down');
    // Messages must be restored for retry
    expect(g.size()).toBe(1);
    expect(g.pending[0].content).toBe('saved');
  });

  it('restores in correct order when commit throws', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'A'));
    g.append(msg('assistant', 'B'));
    let callCount = 0;
    await expect(
      g.openAndDrain(async () => {
        callCount++;
        throw new Error('fail');
      }),
    ).rejects.toThrow();
    expect(g.pending[0].content).toBe('A');
    expect(g.pending[1].content).toBe('B');
  });

  it('merges newly appended messages after restoration on retry', async () => {
    // If a message is appended during the async commit (rare but possible),
    // the restored messages should precede the newly appended ones.
    const g = new GatedContext();
    g.append(msg('user', 'original'));
    let threw = false;
    await expect(
      g.openAndDrain(async () => {
        if (!threw) {
          threw = true;
          g.append(msg('user', 'concurrent'));
          throw new Error('transient');
        }
      }),
    ).rejects.toThrow();
    // original should be first, concurrent (appended mid-drain) should be second
    expect(g.pending[0].content).toBe('original');
    expect(g.pending[1].content).toBe('concurrent');
  });

  it('works with empty buffer (no-op commit)', async () => {
    const g = new GatedContext();
    const commit = vi.fn();
    const drained = await g.openAndDrain(commit);
    expect(commit).toHaveBeenCalledWith([]);
    expect(drained).toHaveLength(0);
  });

  it('accepts a sync commit function', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'sync'));
    const result = await g.openAndDrain((msgs) => { /* sync void */ });
    expect(result).toHaveLength(1);
  });
});

describe('GatedContext — size', () => {
  it('returns 0 initially', () => {
    expect(new GatedContext().size()).toBe(0);
  });

  it('increments with each append call', () => {
    const g = new GatedContext();
    g.append(msg('user', 'a'));
    expect(g.size()).toBe(1);
    g.append(msg('user', 'b'));
    expect(g.size()).toBe(2);
  });

  it('increments for each message in a single append call', () => {
    const g = new GatedContext();
    g.append(msg('user', 'a'), msg('user', 'b'), msg('user', 'c'));
    expect(g.size()).toBe(3);
  });

  it('returns 0 after discard', () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    g.discard();
    expect(g.size()).toBe(0);
  });

  it('returns 0 after successful drain', async () => {
    const g = new GatedContext();
    g.append(msg('user', 'x'));
    await g.openAndDrain(async () => {});
    expect(g.size()).toBe(0);
  });
});

describe('GatedContext — ContentBlock messages', () => {
  it('accepts messages with ContentBlock[] content', () => {
    const g = new GatedContext();
    g.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(g.size()).toBe(1);
  });

  it('returns ContentBlock messages unchanged via pending', () => {
    const g = new GatedContext();
    const m: Message = { role: 'user', content: [{ type: 'text', text: 'world' }] };
    g.append(m);
    expect(g.pending[0]).toBe(m);
  });
});
