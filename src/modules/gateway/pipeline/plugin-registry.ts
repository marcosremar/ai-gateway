// ── BabelCast Gateway — Pipeline Plugin Registry ─────────────────────────────────
// Plugin system for extending the STT→LLM→TTS pipeline with pre/post hooks.
// Plugins can intercept and transform data at each stage boundary.

import type { GpuSTTResult, GpuLLMResult, GpuTTSResult } from './gpu-fetch';

export type PipelineStage = 'stt' | 'llm' | 'tts';

export interface PluginContext {
  source: string;
  target: string;
  style?: string;
  speaker?: string;
  sessionId?: string;
  requestId?: string;
}

export interface PluginPreSTTHook {
  (audio: Buffer, ctx: PluginContext): Promise<{ audio?: Buffer; skip?: boolean }>;
}

export interface PluginPostSTTHook {
  (result: GpuSTTResult, ctx: PluginContext): Promise<GpuSTTResult>;
}

export interface PluginPreLLMHook {
  (text: string, ctx: PluginContext): Promise<{ text?: string; skip?: boolean }>;
}

export interface PluginPostLLMHook {
  (result: GpuLLMResult, ctx: PluginContext): Promise<GpuLLMResult>;
}

export interface PluginPreTTSHook {
  (text: string, ctx: PluginContext): Promise<{ text?: string; skip?: boolean }>;
}

export interface PluginPostTTSHook {
  (result: GpuTTSResult, ctx: PluginContext): Promise<GpuTTSResult>;
}

export interface PluginPipelineHooks {
  name: string;
  priority?: number;
  preSTT?: PluginPreSTTHook;
  postSTT?: PluginPostSTTHook;
  preLLM?: PluginPreLLMHook;
  postLLM?: PluginPostLLMHook;
  preTTS?: PluginPreTTSHook;
  postTTS?: PluginPostTTSHook;
}

export interface PluginPipelineStartHook {
  (ctx: PluginContext): Promise<void>;
}

export interface PluginPipelineEndHook {
  (ctx: PluginContext, result: { transcription: string; translation: string }): Promise<void>;
}

export interface PipelinePlugin {
  name: string;
  priority?: number;
  prePipelineStart?: PluginPipelineStartHook;
  postPipelineEnd?: PluginPipelineEndHook;
  preSTT?: PluginPreSTTHook;
  postSTT?: PluginPostSTTHook;
  preLLM?: PluginPreLLMHook;
  postLLM?: PluginPostLLMHook;
  preTTS?: PluginPreTTSHook;
  postTTS?: PluginPostTTSHook;
}

const DEFAULT_PRIORITY = 100;

function sortPlugins(plugins: PipelinePlugin[]): PipelinePlugin[] {
  return [...plugins].sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));
}

export class PipelinePluginRegistry {
  private plugins: PipelinePlugin[] = [];
  private sortedPlugins: PipelinePlugin[] = [];
  private dirty = false;

  register(plugin: PipelinePlugin): void {
    if (!plugin.name) {
      throw new Error('Pipeline plugin must have a name');
    }
    if (this.plugins.some(p => p.name === plugin.name)) {
      throw new Error(`Pipeline plugin '${plugin.name}' is already registered`);
    }
    this.plugins.push(plugin);
    this.dirty = true;
  }

  unregister(name: string): boolean {
    const idx = this.plugins.findIndex(p => p.name === name);
    if (idx === -1) return false;
    this.plugins.splice(idx, 1);
    this.dirty = true;
    return true;
  }

  getPlugin(name: string): PipelinePlugin | undefined {
    return this.plugins.find(p => p.name === name);
  }

  listPlugins(): string[] {
    return this.sorted().map(p => p.name);
  }

  private sorted(): PipelinePlugin[] {
    if (this.dirty) {
      this.sortedPlugins = sortPlugins(this.plugins);
      this.dirty = false;
    }
    return this.sortedPlugins;
  }

  async runPrePipelineStart(ctx: PluginContext): Promise<void> {
    for (const plugin of this.sorted()) {
      if (plugin.prePipelineStart) {
        try {
          await plugin.prePipelineStart(ctx);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] prePipelineStart failed:`, err);
        }
      }
    }
  }

  async runPostPipelineEnd(ctx: PluginContext, result: { transcription: string; translation: string }): Promise<void> {
    for (const plugin of this.sorted()) {
      if (plugin.postPipelineEnd) {
        try {
          await plugin.postPipelineEnd(ctx, result);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] postPipelineEnd failed:`, err);
        }
      }
    }
  }

  async runPreSTT(audio: Buffer, ctx: PluginContext): Promise<Buffer> {
    let currentAudio = audio;
    for (const plugin of this.sorted()) {
      if (plugin.preSTT) {
        try {
          const result = await plugin.preSTT(currentAudio, ctx);
          if (result.audio) currentAudio = result.audio;
          if (result.skip) return currentAudio;
        } catch (err) {
          console.error(`[plugin:${plugin.name}] preSTT failed:`, err);
        }
      }
    }
    return currentAudio;
  }

  async runPostSTT(result: GpuSTTResult, ctx: PluginContext): Promise<GpuSTTResult> {
    let currentResult = result;
    for (const plugin of this.sorted()) {
      if (plugin.postSTT) {
        try {
          currentResult = await plugin.postSTT(currentResult, ctx);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] postSTT failed:`, err);
        }
      }
    }
    return currentResult;
  }

  async runPreLLM(text: string, ctx: PluginContext): Promise<{ text: string; skip: boolean }> {
    let currentText = text;
    let skip = false;
    for (const plugin of this.sorted()) {
      if (plugin.preLLM) {
        try {
          const result = await plugin.preLLM(currentText, ctx);
          if (result.text !== undefined) currentText = result.text;
          if (result.skip) { skip = true; break; }
        } catch (err) {
          console.error(`[plugin:${plugin.name}] preLLM failed:`, err);
        }
      }
    }
    return { text: currentText, skip };
  }

  async runPostLLM(result: GpuLLMResult, ctx: PluginContext): Promise<GpuLLMResult> {
    let currentResult = result;
    for (const plugin of this.sorted()) {
      if (plugin.postLLM) {
        try {
          currentResult = await plugin.postLLM(currentResult, ctx);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] postLLM failed:`, err);
        }
      }
    }
    return currentResult;
  }

  async runPreTTS(text: string, ctx: PluginContext): Promise<{ text: string; skip: boolean }> {
    let currentText = text;
    let skip = false;
    for (const plugin of this.sorted()) {
      if (plugin.preTTS) {
        try {
          const result = await plugin.preTTS(currentText, ctx);
          if (result.text !== undefined) currentText = result.text;
          if (result.skip) { skip = true; break; }
        } catch (err) {
          console.error(`[plugin:${plugin.name}] preTTS failed:`, err);
        }
      }
    }
    return { text: currentText, skip };
  }

  async runPostTTS(result: GpuTTSResult, ctx: PluginContext): Promise<GpuTTSResult> {
    let currentResult = result;
    for (const plugin of this.sorted()) {
      if (plugin.postTTS) {
        try {
          currentResult = await plugin.postTTS(currentResult, ctx);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] postTTS failed:`, err);
        }
      }
    }
    return currentResult;
  }
}

export const pipelinePlugins = new PipelinePluginRegistry();
