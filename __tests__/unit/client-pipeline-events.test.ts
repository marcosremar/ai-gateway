/**
 * Tests for client/pipeline-events.ts
 * - PipelineEvent types and structure
 */

import { describe, it, expect } from 'vitest';
import type { PipelineEvent, PipelineStage } from '../../src/client/pipeline-events';

describe('PipelineEvent types', () => {
  it('stage event has correct shape', () => {
    const event: PipelineEvent = {
      event: 'stage',
      data: { stage: 'stt', status: 'start' },
    };
    expect(event.event).toBe('stage');
    expect(event.data.stage).toBe('stt');
    expect(event.data.status).toBe('start');
  });

  it('stage event works with all stages', () => {
    const stages: PipelineStage[] = ['stt', 'llm', 'tts'];
    for (const stage of stages) {
      const event: PipelineEvent = {
        event: 'stage',
        data: { stage, status: 'complete' },
      };
      expect(event.data.stage).toBe(stage);
    }
  });

  it('transcript event has correct shape', () => {
    const event: PipelineEvent = {
      event: 'transcript',
      data: { text: 'Hello world', provider: 'groq', latencyMs: 150 },
    };
    expect(event.event).toBe('transcript');
    expect(event.data.text).toBe('Hello world');
    expect(event.data.provider).toBe('groq');
    expect(event.data.latencyMs).toBe(150);
  });

  it('response event has correct shape', () => {
    const event: PipelineEvent = {
      event: 'response',
      data: { text: 'Hi there!', provider: 'openai', latencyMs: 500 },
    };
    expect(event.event).toBe('response');
    expect(event.data.text).toBe('Hi there!');
  });

  it('audio event has correct shape', () => {
    const event: PipelineEvent = {
      event: 'audio',
      data: {
        base64: 'UklGRiQA...',
        contentType: 'audio/wav',
        provider: 'openai',
        latencyMs: 300,
      },
    };
    expect(event.event).toBe('audio');
    expect(event.data.base64).toBe('UklGRiQA...');
    expect(event.data.contentType).toBe('audio/wav');
  });

  it('complete event has correct shape', () => {
    const event: PipelineEvent = {
      event: 'complete',
      data: {
        timing: { stt: 150, llm: 400, tts: 200 },
        usedGpu: false,
        providers: { stt: 'groq', llm: 'openai', tts: 'openai' },
      },
    };
    expect(event.event).toBe('complete');
    expect(event.data.usedGpu).toBe(false);
    expect(event.data.timing.stt).toBe(150);
  });

  it('error event has correct shape', () => {
    const event: PipelineEvent = {
      event: 'error',
      data: { message: 'STT failed', stage: 'stt', recoverable: true },
    };
    expect(event.event).toBe('error');
    expect(event.data.recoverable).toBe(true);
    expect(event.data.stage).toBe('stt');
  });

  it('error event without stage', () => {
    const event: PipelineEvent = {
      event: 'error',
      data: { message: 'Fatal error', recoverable: false },
    };
    expect(event.data.stage).toBeUndefined();
  });

  it('events are JSON serializable', () => {
    const events: PipelineEvent[] = [
      { event: 'stage', data: { stage: 'stt', status: 'start' } },
      { event: 'transcript', data: { text: 'test', provider: 'groq', latencyMs: 100 } },
      { event: 'audio', data: { base64: 'abc', contentType: 'audio/wav', provider: 'openai', latencyMs: 200 } },
      { event: 'complete', data: { timing: {}, usedGpu: true, providers: {} } },
      { event: 'error', data: { message: 'err', recoverable: false } },
    ];

    for (const e of events) {
      expect(() => JSON.stringify(e)).not.toThrow();
    }
  });

  it('stage can be narrowed by discriminant', () => {
    function handleEvent(e: PipelineEvent) {
      if (e.event === 'transcript') {
        return e.data.text.toLowerCase(); // TypeScript should allow this
      }
      return null;
    }

    const event: PipelineEvent = {
      event: 'transcript',
      data: { text: 'HELLO', provider: 'groq', latencyMs: 100 },
    };
    expect(handleEvent(event)).toBe('hello');
  });

  it('complete event with usedGpu=true works', () => {
    const event: PipelineEvent = {
      event: 'complete',
      data: {
        timing: { total: 1000 },
        usedGpu: true,
        providers: { stt: 'tensordock', llm: 'tensordock', tts: 'tensordock' },
      },
    };
    expect(event.data.usedGpu).toBe(true);
  });
});
