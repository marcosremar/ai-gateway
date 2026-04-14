/**
 * Tests for Pipeline Plugin Registry.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PipelinePluginRegistry,
  pipelinePlugins,
  type PipelinePlugin,
  type PluginContext,
} from '../../src/gateway/pipeline/plugin-registry';

describe('PipelinePluginRegistry', () => {
  describe('register', () => {
    it('should register a plugin', () => {
      const registry = new PipelinePluginRegistry();
      const plugin: PipelinePlugin = {
        name: 'test-plugin',
      };
      registry.register(plugin);
      expect(registry.listPlugins()).toContain('test-plugin');
    });

    it('should throw if plugin has no name', () => {
      const registry = new PipelinePluginRegistry();
      const plugin = { name: '' } as PipelinePlugin;
      expect(() => registry.register(plugin)).toThrow("must have a name");
    });

    it('should throw if plugin name is already registered', () => {
      const registry = new PipelinePluginRegistry();
      const plugin: PipelinePlugin = { name: 'dup-plugin' };
      registry.register(plugin);
      expect(() => registry.register(plugin)).toThrow("already registered");
    });
  });

  describe('unregister', () => {
    it('should unregister an existing plugin', () => {
      const registry = new PipelinePluginRegistry();
      registry.register({ name: 'remove-me' });
      expect(registry.unregister('remove-me')).toBe(true);
      expect(registry.listPlugins()).not.toContain('remove-me');
    });

    it('should return false for non-existent plugin', () => {
      const registry = new PipelinePluginRegistry();
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('getPlugin', () => {
    it('should return registered plugin', () => {
      const registry = new PipelinePluginRegistry();
      const plugin: PipelinePlugin = { name: 'get-test' };
      registry.register(plugin);
      expect(registry.getPlugin('get-test')).toBe(plugin);
    });

    it('should return undefined for non-existent plugin', () => {
      const registry = new PipelinePluginRegistry();
      expect(registry.getPlugin('nonexistent')).toBeUndefined();
    });
  });

  describe('priority ordering', () => {
    it('should sort plugins by priority (lower first)', async () => {
      const registry = new PipelinePluginRegistry();
      const order: string[] = [];

      registry.register({ name: 'low', priority: 100, preSTT: async (_audio, _ctx) => { order.push('low'); return {}; } });
      registry.register({ name: 'high', priority: 1, preSTT: async (_audio, _ctx) => { order.push('high'); return {}; } });
      registry.register({ name: 'medium', priority: 50, preSTT: async (_audio, _ctx) => { order.push('medium'); return {}; } });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPreSTT(Buffer.from('test audio'), ctx);

      expect(order).toEqual(['high', 'medium', 'low']);
    });

    it('should use default priority of 100 when not specified', async () => {
      const registry = new PipelinePluginRegistry();
      const order: string[] = [];

      registry.register({ name: 'first', priority: 1, preSTT: async (_audio, _ctx) => { order.push('first'); return {}; } });
      registry.register({ name: 'default-priority', preSTT: async (_audio, _ctx) => { order.push('default'); return {}; } });
      registry.register({ name: 'second', priority: 200, preSTT: async (_audio, _ctx) => { order.push('second'); return {}; } });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPreSTT(Buffer.from('test'), ctx);

      expect(order).toEqual(['first', 'default', 'second']);
    });
  });

  describe('runPreSTT', () => {
    it('should call preSTT hooks in order', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'plugin-a',
        preSTT: async (audio, _ctx) => { calls.push('a'); return { audio }; },
      });
      registry.register({
        name: 'plugin-b',
        preSTT: async (audio, _ctx) => { calls.push('b'); return { audio }; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      const result = await registry.runPreSTT(Buffer.from('original'), ctx);

      expect(calls).toEqual(['plugin-a', 'plugin-b']);
      expect(result.toString()).toBe('original');
    });

    it('should allow hook to modify audio', async () => {
      const registry = new PipelinePluginRegistry();

      registry.register({
        name: 'modifier',
        preSTT: async (_audio, _ctx) => {
          return { audio: Buffer.from('modified') };
        },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      const result = await registry.runPreSTT(Buffer.from('original'), ctx);

      expect(result.toString()).toBe('modified');
    });

    it('should skip remaining hooks if skip is true', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'skipper',
        preSTT: async (audio, _ctx) => { calls.push('skipper'); return { audio, skip: true }; },
      });
      registry.register({
        name: 'should-not-call',
        preSTT: async (audio, _ctx) => { calls.push('should-not-call'); return { audio }; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPreSTT(Buffer.from('test'), ctx);

      expect(calls).toEqual(['skipper']);
    });

    it('should continue if hook throws', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'throwing',
        preSTT: async () => { throw new Error('plugin error'); },
      });
      registry.register({
        name: 'ok',
        preSTT: async (audio, _ctx) => { calls.push('ok'); return { audio }; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPreSTT(Buffer.from('test'), ctx);

      expect(calls).toEqual(['ok']);
    });
  });

  describe('runPostSTT', () => {
    it('should call postSTT hooks in order', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'post-a',
        postSTT: async (result, _ctx) => { calls.push('post-a'); return result; },
      });
      registry.register({
        name: 'post-b',
        postSTT: async (result, _ctx) => { calls.push('post-b'); return result; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      const result = await registry.runPostSTT({ text: 'hello', language: 'en' }, ctx);

      expect(calls).toEqual(['post-a', 'post-b']);
      expect(result.text).toBe('hello');
    });

    it('should allow hook to modify result', async () => {
      const registry = new PipelinePluginRegistry();

      registry.register({
        name: 'modifier',
        postSTT: async (_result, _ctx) => {
          return { text: 'modified', language: 'en' };
        },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      const result = await registry.runPostSTT({ text: 'original', language: 'en' }, ctx);

      expect(result.text).toBe('modified');
    });
  });

  describe('runPreLLM', () => {
    it('should call preLLM hooks in order', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'llm-a',
        preLLM: async (text, _ctx) => { calls.push('a'); return { text }; },
      });
      registry.register({
        name: 'llm-b',
        preLLM: async (text, _ctx) => { calls.push('b'); return { text }; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPreLLM('hello', ctx);

      expect(calls).toEqual(['a', 'b']);
    });

    it('should allow hook to modify text', async () => {
      const registry = new PipelinePluginRegistry();

      registry.register({
        name: 'modifier',
        preLLM: async (_text, _ctx) => {
          return { text: 'modified text' };
        },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      const result = await registry.runPreLLM('original', ctx);

      expect(result.text).toBe('modified text');
    });

    it('should return skip=true when hook requests skip', async () => {
      const registry = new PipelinePluginRegistry();

      registry.register({
        name: 'skipper',
        preLLM: async (_text, _ctx) => {
          return { text: 'unchanged', skip: true };
        },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      const result = await registry.runPreLLM('original', ctx);

      expect(result.skip).toBe(true);
      expect(result.text).toBe('unchanged');
    });
  });

  describe('runPostLLM', () => {
    it('should call postLLM hooks in order', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'llm-post-a',
        postLLM: async (result, _ctx) => { calls.push('a'); return result; },
      });
      registry.register({
        name: 'llm-post-b',
        postLLM: async (result, _ctx) => { calls.push('b'); return result; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPostLLM({ translated_text: 'hola', used_gpu: false }, ctx);

      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('runPreTTS', () => {
    it('should call preTTS hooks in order', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'tts-a',
        preTTS: async (text, _ctx) => { calls.push('a'); return { text }; },
      });
      registry.register({
        name: 'tts-b',
        preTTS: async (text, _ctx) => { calls.push('b'); return { text }; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPreTTS('hello', ctx);

      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('runPostTTS', () => {
    it('should call postTTS hooks in order', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'tts-post-a',
        postTTS: async (result, _ctx) => { calls.push('a'); return result; },
      });
      registry.register({
        name: 'tts-post-b',
        postTTS: async (result, _ctx) => { calls.push('b'); return result; },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPostTTS({ audio: Buffer.from('audio'), contentType: 'audio/wav', used_gpu: false }, ctx);

      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('runPrePipelineStart', () => {
    it('should call prePipelineStart hooks', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'start-a',
        prePipelineStart: async (_ctx) => { calls.push('a'); },
      });
      registry.register({
        name: 'start-b',
        prePipelineStart: async (_ctx) => { calls.push('b'); },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPrePipelineStart(ctx);

      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('runPostPipelineEnd', () => {
    it('should call postPipelineEnd hooks', async () => {
      const registry = new PipelinePluginRegistry();
      const calls: string[] = [];

      registry.register({
        name: 'end-a',
        postPipelineEnd: async (_ctx, _result) => { calls.push('a'); },
      });
      registry.register({
        name: 'end-b',
        postPipelineEnd: async (_ctx, _result) => { calls.push('b'); },
      });

      const ctx: PluginContext = { source: 'en', target: 'es' };
      await registry.runPostPipelineEnd(ctx, { transcription: 'hello', translation: 'hola' });

      expect(calls).toEqual(['a', 'b']);
    });
  });
});

describe('pipelinePlugins singleton', () => {
  it('should be a PipelinePluginRegistry instance', () => {
    expect(pipelinePlugins).toBeInstanceOf(PipelinePluginRegistry);
  });
});
