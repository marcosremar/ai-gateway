/**
 * Unit tests for src/gateway/pipeline/plugin-registry.ts
 *
 * Tests cover:
 *   - register/unregister/getPlugin/listPlugins basics
 *   - duplicate-name rejection and missing-name rejection
 *   - priority-based sort order (lower number = runs first)
 *   - runPrePipelineStart / runPostPipelineEnd: fires on all plugins, error isolation
 *   - runPreSTT: audio passthrough, mutation, skip flag, error isolation
 *   - runPostSTT: result passthrough, mutation, error isolation
 *   - runPreLLM: text passthrough, mutation, skip flag, error isolation
 *   - runPostLLM: result passthrough, mutation, error isolation
 *   - runPreTTS: text passthrough, mutation, skip flag, error isolation
 *   - runPostTTS: result passthrough, mutation, error isolation
 *   - plugins without the relevant hook are silently skipped
 *   - re-registration after unregister succeeds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PipelinePluginRegistry,
} from '../../src/gateway/pipeline/plugin-registry';
import type {
  PipelinePlugin,
  PluginContext,
} from '../../src/gateway/pipeline/plugin-registry';
import type {
  GpuSTTResult,
  GpuLLMResult,
  GpuTTSResult,
} from '../../src/gateway/pipeline/gpu-fetch';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ctx: PluginContext = {
  source: 'en',
  target: 'es',
  sessionId: 'sess-1',
  requestId: 'req-1',
};

function makeSTTResult(text = 'hello'): GpuSTTResult {
  return { text, language: 'en', used_gpu: false, avg_logprob: -0.1 };
}

function makeLLMResult(translated_text = 'hola'): GpuLLMResult {
  return { translated_text, used_gpu: false };
}

function makeTTSResult(): GpuTTSResult {
  return { audio: Buffer.from('audio'), contentType: 'audio/wav', used_gpu: false };
}

// ── Registration API ──────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — registration', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('registers a plugin and retrieves it by name', () => {
    const plugin: PipelinePlugin = { name: 'alpha' };
    registry.register(plugin);
    expect(registry.getPlugin('alpha')).toBe(plugin);
  });

  it('returns undefined for unknown plugin name', () => {
    expect(registry.getPlugin('nope')).toBeUndefined();
  });

  it('throws when registering a plugin without a name', () => {
    expect(() => registry.register({ name: '' })).toThrow('must have a name');
  });

  it('throws when registering a duplicate plugin name', () => {
    registry.register({ name: 'alpha' });
    expect(() => registry.register({ name: 'alpha' })).toThrow("'alpha' is already registered");
  });

  it('unregisters a plugin and returns true', () => {
    registry.register({ name: 'alpha' });
    expect(registry.unregister('alpha')).toBe(true);
    expect(registry.getPlugin('alpha')).toBeUndefined();
  });

  it('returns false when unregistering a non-existent plugin', () => {
    expect(registry.unregister('nope')).toBe(false);
  });

  it('allows re-registration after unregister', () => {
    const plugin: PipelinePlugin = { name: 'alpha' };
    registry.register(plugin);
    registry.unregister('alpha');
    expect(() => registry.register({ name: 'alpha' })).not.toThrow();
  });

  it('listPlugins returns empty array when no plugins registered', () => {
    expect(registry.listPlugins()).toEqual([]);
  });

  it('listPlugins returns all registered plugin names', () => {
    registry.register({ name: 'alpha' });
    registry.register({ name: 'beta' });
    expect(registry.listPlugins()).toContain('alpha');
    expect(registry.listPlugins()).toContain('beta');
    expect(registry.listPlugins()).toHaveLength(2);
  });
});

// ── Priority ordering ─────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — priority ordering', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('sorts plugins by ascending priority (lower number = earlier)', () => {
    registry.register({ name: 'c', priority: 300 });
    registry.register({ name: 'a', priority: 10 });
    registry.register({ name: 'b', priority: 200 });
    expect(registry.listPlugins()).toEqual(['a', 'b', 'c']);
  });

  it('uses default priority 100 when not specified', () => {
    registry.register({ name: 'first', priority: 50 });
    registry.register({ name: 'default' }); // priority 100 by default
    registry.register({ name: 'last', priority: 200 });
    expect(registry.listPlugins()).toEqual(['first', 'default', 'last']);
  });

  it('preserves insertion order for equal priorities', () => {
    registry.register({ name: 'x', priority: 50 });
    registry.register({ name: 'y', priority: 50 });
    const names = registry.listPlugins();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('x');
    expect(names[1]).toBe('y');
  });

  it('re-sorts after unregister', () => {
    registry.register({ name: 'a', priority: 10 });
    registry.register({ name: 'b', priority: 20 });
    registry.register({ name: 'c', priority: 30 });
    registry.unregister('b');
    expect(registry.listPlugins()).toEqual(['a', 'c']);
  });
});

// ── runPrePipelineStart ───────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPrePipelineStart', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('calls prePipelineStart on all plugins in priority order', async () => {
    const order: string[] = [];
    registry.register({ name: 'beta', priority: 20, prePipelineStart: async () => { order.push('beta'); } });
    registry.register({ name: 'alpha', priority: 10, prePipelineStart: async () => { order.push('alpha'); } });
    await registry.runPrePipelineStart(ctx);
    expect(order).toEqual(['alpha', 'beta']);
  });

  it('skips plugins without prePipelineStart hook', async () => {
    registry.register({ name: 'nohook' });
    await expect(registry.runPrePipelineStart(ctx)).resolves.toBeUndefined();
  });

  it('isolates errors — other plugins still run', async () => {
    const ran: string[] = [];
    registry.register({ name: 'a', priority: 1, prePipelineStart: async () => { throw new Error('boom'); } });
    registry.register({ name: 'b', priority: 2, prePipelineStart: async () => { ran.push('b'); } });
    await registry.runPrePipelineStart(ctx);
    expect(ran).toContain('b');
  });
});

// ── runPostPipelineEnd ────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPostPipelineEnd', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('calls postPipelineEnd on all plugins with context and result', async () => {
    const captured: { transcription: string; translation: string }[] = [];
    const result = { transcription: 'hello', translation: 'hola' };
    registry.register({
      name: 'a',
      postPipelineEnd: async (_ctx, r) => { captured.push(r); },
    });
    await registry.runPostPipelineEnd(ctx, result);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(result);
  });

  it('isolates postPipelineEnd errors', async () => {
    const ran: string[] = [];
    registry.register({ name: 'a', postPipelineEnd: async () => { throw new Error('boom'); } });
    registry.register({ name: 'b', postPipelineEnd: async () => { ran.push('b'); } });
    await registry.runPostPipelineEnd(ctx, { transcription: 'x', translation: 'y' });
    expect(ran).toContain('b');
  });
});

// ── runPreSTT ────────────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPreSTT', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('returns original audio when no preSTT plugins registered', async () => {
    const audio = Buffer.from('original');
    const result = await registry.runPreSTT(audio, ctx);
    expect(result).toBe(audio);
  });

  it('passes audio through a no-op plugin', async () => {
    const audio = Buffer.from('original');
    registry.register({ name: 'noop', preSTT: async () => ({}) });
    const result = await registry.runPreSTT(audio, ctx);
    expect(result).toEqual(audio);
  });

  it('allows a plugin to replace the audio buffer', async () => {
    const original = Buffer.from('original');
    const replaced = Buffer.from('replaced');
    registry.register({ name: 'mutate', preSTT: async () => ({ audio: replaced }) });
    const result = await registry.runPreSTT(original, ctx);
    expect(result).toBe(replaced);
  });

  it('chains audio transformations across multiple plugins', async () => {
    const order: string[] = [];
    registry.register({
      name: 'first', priority: 10,
      preSTT: async (audio) => { order.push('first'); return { audio: Buffer.from(audio.toString() + '-A') }; },
    });
    registry.register({
      name: 'second', priority: 20,
      preSTT: async (audio) => { order.push('second'); return { audio: Buffer.from(audio.toString() + '-B') }; },
    });
    const result = await registry.runPreSTT(Buffer.from('start'), ctx);
    expect(order).toEqual(['first', 'second']);
    expect(result.toString()).toBe('start-A-B');
  });

  it('stops processing further plugins when skip is true', async () => {
    const ran: string[] = [];
    registry.register({ name: 'a', priority: 1, preSTT: async () => { ran.push('a'); return { skip: true }; } });
    registry.register({ name: 'b', priority: 2, preSTT: async () => { ran.push('b'); return {}; } });
    await registry.runPreSTT(Buffer.from('audio'), ctx);
    expect(ran).toEqual(['a']);
  });

  it('returns the current audio when skip is triggered', async () => {
    const modified = Buffer.from('modified');
    registry.register({ name: 'a', preSTT: async () => ({ audio: modified, skip: true }) });
    registry.register({ name: 'b', preSTT: async () => { throw new Error('should not run'); } });
    const result = await registry.runPreSTT(Buffer.from('original'), ctx);
    expect(result).toBe(modified);
  });

  it('isolates preSTT errors and continues with current audio', async () => {
    const ran: string[] = [];
    registry.register({ name: 'bad', priority: 1, preSTT: async () => { throw new Error('boom'); } });
    registry.register({ name: 'good', priority: 2, preSTT: async (audio) => { ran.push('good'); return { audio }; } });
    const audio = Buffer.from('audio');
    const result = await registry.runPreSTT(audio, ctx);
    expect(ran).toContain('good');
    expect(result).toEqual(audio);
  });
});

// ── runPostSTT ────────────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPostSTT', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('returns original result when no postSTT plugins registered', async () => {
    const sttResult = makeSTTResult();
    const result = await registry.runPostSTT(sttResult, ctx);
    expect(result).toBe(sttResult);
  });

  it('allows a plugin to transform the STT result', async () => {
    registry.register({
      name: 'uppercase',
      postSTT: async (r) => ({ ...r, text: r.text.toUpperCase() }),
    });
    const result = await registry.runPostSTT(makeSTTResult('hello'), ctx);
    expect(result.text).toBe('HELLO');
  });

  it('chains multiple postSTT transformations', async () => {
    registry.register({ name: 'a', priority: 10, postSTT: async (r) => ({ ...r, text: r.text + '-A' }) });
    registry.register({ name: 'b', priority: 20, postSTT: async (r) => ({ ...r, text: r.text + '-B' }) });
    const result = await registry.runPostSTT(makeSTTResult('hi'), ctx);
    expect(result.text).toBe('hi-A-B');
  });

  it('isolates postSTT errors and continues with current result', async () => {
    registry.register({ name: 'bad', priority: 1, postSTT: async () => { throw new Error('boom'); } });
    registry.register({ name: 'good', priority: 2, postSTT: async (r) => ({ ...r, text: 'transformed' }) });
    const result = await registry.runPostSTT(makeSTTResult('original'), ctx);
    expect(result.text).toBe('transformed');
  });
});

// ── runPreLLM ────────────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPreLLM', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('returns original text and skip=false when no plugins registered', async () => {
    const result = await registry.runPreLLM('hello', ctx);
    expect(result).toEqual({ text: 'hello', skip: false });
  });

  it('passes text through a no-op plugin', async () => {
    registry.register({ name: 'noop', preLLM: async () => ({}) });
    const result = await registry.runPreLLM('hello', ctx);
    expect(result).toEqual({ text: 'hello', skip: false });
  });

  it('allows a plugin to replace the text', async () => {
    registry.register({ name: 'replace', preLLM: async () => ({ text: 'replaced' }) });
    const result = await registry.runPreLLM('original', ctx);
    expect(result.text).toBe('replaced');
    expect(result.skip).toBe(false);
  });

  it('chains text transformations', async () => {
    registry.register({ name: 'a', priority: 10, preLLM: async (t) => ({ text: t + '-A' }) });
    registry.register({ name: 'b', priority: 20, preLLM: async (t) => ({ text: t + '-B' }) });
    const result = await registry.runPreLLM('start', ctx);
    expect(result.text).toBe('start-A-B');
  });

  it('stops processing and returns skip=true when a plugin sets skip', async () => {
    const ran: string[] = [];
    registry.register({ name: 'a', priority: 1, preLLM: async () => { ran.push('a'); return { skip: true }; } });
    registry.register({ name: 'b', priority: 2, preLLM: async () => { ran.push('b'); return {}; } });
    const result = await registry.runPreLLM('text', ctx);
    expect(result.skip).toBe(true);
    expect(ran).toEqual(['a']);
  });

  it('preserves modified text when skip is returned', async () => {
    registry.register({ name: 'a', preLLM: async () => ({ text: 'modified', skip: true }) });
    const result = await registry.runPreLLM('original', ctx);
    expect(result.text).toBe('modified');
    expect(result.skip).toBe(true);
  });

  it('isolates preLLM errors', async () => {
    const ran: string[] = [];
    registry.register({ name: 'bad', priority: 1, preLLM: async () => { throw new Error('boom'); } });
    registry.register({ name: 'good', priority: 2, preLLM: async () => { ran.push('good'); return {}; } });
    await registry.runPreLLM('text', ctx);
    expect(ran).toContain('good');
  });
});

// ── runPostLLM ────────────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPostLLM', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('returns original result when no postLLM plugins registered', async () => {
    const llmResult = makeLLMResult();
    const result = await registry.runPostLLM(llmResult, ctx);
    expect(result).toBe(llmResult);
  });

  it('allows a plugin to transform the LLM result', async () => {
    registry.register({
      name: 'uppercase',
      postLLM: async (r) => ({ ...r, translated_text: r.translated_text.toUpperCase() }),
    });
    const result = await registry.runPostLLM(makeLLMResult('hola'), ctx);
    expect(result.translated_text).toBe('HOLA');
  });

  it('chains multiple postLLM transformations', async () => {
    registry.register({ name: 'a', priority: 10, postLLM: async (r) => ({ ...r, translated_text: r.translated_text + '-A' }) });
    registry.register({ name: 'b', priority: 20, postLLM: async (r) => ({ ...r, translated_text: r.translated_text + '-B' }) });
    const result = await registry.runPostLLM(makeLLMResult('hi'), ctx);
    expect(result.translated_text).toBe('hi-A-B');
  });

  it('isolates postLLM errors', async () => {
    registry.register({ name: 'bad', priority: 1, postLLM: async () => { throw new Error('boom'); } });
    registry.register({ name: 'good', priority: 2, postLLM: async (r) => ({ ...r, translated_text: 'transformed' }) });
    const result = await registry.runPostLLM(makeLLMResult('original'), ctx);
    expect(result.translated_text).toBe('transformed');
  });
});

// ── runPreTTS ────────────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPreTTS', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('returns original text and skip=false when no plugins registered', async () => {
    const result = await registry.runPreTTS('speak this', ctx);
    expect(result).toEqual({ text: 'speak this', skip: false });
  });

  it('allows a plugin to replace the TTS text', async () => {
    registry.register({ name: 'replace', preTTS: async () => ({ text: 'replaced text' }) });
    const result = await registry.runPreTTS('original', ctx);
    expect(result.text).toBe('replaced text');
    expect(result.skip).toBe(false);
  });

  it('chains TTS text transformations', async () => {
    registry.register({ name: 'a', priority: 10, preTTS: async (t) => ({ text: t + ' A' }) });
    registry.register({ name: 'b', priority: 20, preTTS: async (t) => ({ text: t + ' B' }) });
    const result = await registry.runPreTTS('start', ctx);
    expect(result.text).toBe('start A B');
  });

  it('stops processing and returns skip=true when a plugin sets skip', async () => {
    const ran: string[] = [];
    registry.register({ name: 'a', priority: 1, preTTS: async () => { ran.push('a'); return { skip: true }; } });
    registry.register({ name: 'b', priority: 2, preTTS: async () => { ran.push('b'); return {}; } });
    const result = await registry.runPreTTS('text', ctx);
    expect(result.skip).toBe(true);
    expect(ran).toEqual(['a']);
  });

  it('isolates preTTS errors', async () => {
    const ran: string[] = [];
    registry.register({ name: 'bad', priority: 1, preTTS: async () => { throw new Error('boom'); } });
    registry.register({ name: 'good', priority: 2, preTTS: async () => { ran.push('good'); return {}; } });
    await registry.runPreTTS('text', ctx);
    expect(ran).toContain('good');
  });
});

// ── runPostTTS ────────────────────────────────────────────────────────────────

describe('PipelinePluginRegistry — runPostTTS', () => {
  let registry: PipelinePluginRegistry;

  beforeEach(() => {
    registry = new PipelinePluginRegistry();
  });

  it('returns original result when no postTTS plugins registered', async () => {
    const ttsResult = makeTTSResult();
    const result = await registry.runPostTTS(ttsResult, ctx);
    expect(result).toBe(ttsResult);
  });

  it('allows a plugin to transform the TTS result', async () => {
    const newAudio = Buffer.from('modified audio');
    registry.register({
      name: 'modify',
      postTTS: async (r) => ({ ...r, audio: newAudio }),
    });
    const result = await registry.runPostTTS(makeTTSResult(), ctx);
    expect(result.audio).toBe(newAudio);
  });

  it('chains multiple postTTS transformations', async () => {
    const tags: string[] = [];
    registry.register({ name: 'a', priority: 10, postTTS: async (r) => { tags.push('a'); return r; } });
    registry.register({ name: 'b', priority: 20, postTTS: async (r) => { tags.push('b'); return r; } });
    await registry.runPostTTS(makeTTSResult(), ctx);
    expect(tags).toEqual(['a', 'b']);
  });

  it('isolates postTTS errors', async () => {
    const newAudio = Buffer.from('transformed');
    registry.register({ name: 'bad', priority: 1, postTTS: async () => { throw new Error('boom'); } });
    registry.register({ name: 'good', priority: 2, postTTS: async (r) => ({ ...r, audio: newAudio }) });
    const result = await registry.runPostTTS(makeTTSResult(), ctx);
    expect(result.audio).toBe(newAudio);
  });
});

// ── Cross-concern: plugins without the hook are silently skipped ──────────────

describe('PipelinePluginRegistry — plugins without hooks are skipped', () => {
  it('does not throw when running hooks on a registry with hookless plugins', async () => {
    const registry = new PipelinePluginRegistry();
    registry.register({ name: 'empty' }); // no hooks at all
    await expect(registry.runPrePipelineStart(ctx)).resolves.toBeUndefined();
    await expect(registry.runPostPipelineEnd(ctx, { transcription: 'a', translation: 'b' })).resolves.toBeUndefined();
    const audio = Buffer.from('a');
    await expect(registry.runPreSTT(audio, ctx)).resolves.toEqual(audio);
    await expect(registry.runPostSTT(makeSTTResult(), ctx)).resolves.toBeDefined();
    await expect(registry.runPreLLM('t', ctx)).resolves.toEqual({ text: 't', skip: false });
    await expect(registry.runPostLLM(makeLLMResult(), ctx)).resolves.toBeDefined();
    await expect(registry.runPreTTS('t', ctx)).resolves.toEqual({ text: 't', skip: false });
    await expect(registry.runPostTTS(makeTTSResult(), ctx)).resolves.toBeDefined();
  });
});
