/**
 * Integration: GatedContext + simulated Smart Turn pipeline.
 *
 * Models the runtime path:
 *   STT partial transcripts → GatedContext.append
 *   VAD silence → Smart Turn inference → COMPLETE | INCOMPLETE
 *     COMPLETE   → openAndDrain → commit to LLM context
 *     INCOMPLETE → keep buffering
 *     RETRACTED  → discard
 */

import { describe, it, expect, vi } from 'vitest';
import { GatedContext } from '../src/llm-context/gated-context';
import type { Message } from '../src/llm-context/types';

type SmartTurnResult = { state: 'COMPLETE' | 'INCOMPLETE'; probability: number };

// Simulated Smart Turn — deterministic by transcript shape.
function fakeSmartTurn(transcript: string): SmartTurnResult {
  const t = transcript.trim();
  if (t.endsWith('.') || t.endsWith('?') || t.endsWith('!')) {
    return { state: 'COMPLETE', probability: 0.95 };
  }
  return { state: 'INCOMPLETE', probability: 0.05 };
}

class ContextStore {
  committed: Message[] = [];
  commit = vi.fn(async (msgs: Message[]) => {
    this.committed.push(...msgs);
  });
}

function transcriptToMessage(text: string): Message {
  return { role: 'user', content: text };
}

describe('llm-context smart-turn integration', () => {
  it('commits buffered messages when Smart Turn says COMPLETE', async () => {
    const gate = new GatedContext();
    const store = new ContextStore();

    gate.append(transcriptToMessage('Send a message to Alice.'));
    const decision = fakeSmartTurn('Send a message to Alice.');
    expect(decision.state).toBe('COMPLETE');

    await gate.openAndDrain((msgs) => store.commit(msgs));
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0].content).toBe('Send a message to Alice.');
  });

  it('holds messages while Smart Turn says INCOMPLETE', async () => {
    const gate = new GatedContext();
    const store = new ContextStore();

    gate.append(transcriptToMessage('Send a message to'));
    const decision = fakeSmartTurn('Send a message to');
    expect(decision.state).toBe('INCOMPLETE');
    expect(gate.size()).toBe(1);
    expect(store.committed).toHaveLength(0);
  });

  it('accumulates partial transcripts then commits on final COMPLETE', async () => {
    const gate = new GatedContext();
    const store = new ContextStore();

    const stages = [
      'I want to',
      'I want to send',
      'I want to send a message',
      'I want to send a message to Alice.',
    ];

    for (const stage of stages.slice(0, -1)) {
      gate.append(transcriptToMessage(stage));
      expect(fakeSmartTurn(stage).state).toBe('INCOMPLETE');
    }
    expect(gate.size()).toBe(3);

    gate.append(transcriptToMessage(stages[3]));
    expect(fakeSmartTurn(stages[3]).state).toBe('COMPLETE');

    await gate.openAndDrain((msgs) => store.commit(msgs));
    expect(store.commit).toHaveBeenCalledOnce();
    expect(store.committed).toHaveLength(4);
  });

  it('discards on user retraction (silence > stop_secs)', async () => {
    const gate = new GatedContext();
    const store = new ContextStore();

    gate.append(transcriptToMessage('um actually'));
    expect(fakeSmartTurn('um actually').state).toBe('INCOMPLETE');

    // Simulate user gave up; stop_secs hit hard cutoff but transcript is junk
    const dropped = gate.discard();
    expect(dropped).toHaveLength(1);
    expect(store.committed).toHaveLength(0);
    expect(gate.size()).toBe(0);
  });

  it('multiple turns flow correctly through gate', async () => {
    const gate = new GatedContext();
    const store = new ContextStore();

    // Turn 1: complete immediately
    gate.append(transcriptToMessage('Hello!'));
    await gate.openAndDrain((msgs) => store.commit(msgs));

    // Turn 2: buffer + final
    gate.append(transcriptToMessage('What is'));
    gate.append(transcriptToMessage('What is the weather?'));
    await gate.openAndDrain((msgs) => store.commit(msgs));

    // Turn 3: retracted
    gate.append(transcriptToMessage('uhh'));
    gate.discard();

    expect(store.committed).toHaveLength(3);
    expect(store.commit).toHaveBeenCalledTimes(2);
  });
});
