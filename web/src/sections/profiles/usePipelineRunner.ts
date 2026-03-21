import { useState, useCallback } from 'react';
import { playgroundStt, playgroundLlm, playgroundTts } from '@/lib/gateway';

export interface StageResult {
  text?: string;
  audioBase64?: string;
  contentType?: string;
  latencyMs: number;
  provider?: string;
  model?: string;
}

export type PipelineStatus = 'idle' | 'running' | 'done' | 'error';

export interface PipelineRunState {
  status: PipelineStatus;
  activeStage: 'stt' | 'llm' | 'tts' | null;
  results: {
    stt?: StageResult;
    llm?: StageResult;
    tts?: StageResult;
  };
  error?: string;
  totalMs?: number;
  inputType: 'audio' | 'text' | 'image' | null;
}

export interface PipelineInput {
  type: 'audio' | 'text' | 'image';
  blob?: Blob;
  text?: string;
}

const INITIAL: PipelineRunState = {
  status: 'idle',
  activeStage: null,
  results: {},
  inputType: null,
};

export function usePipelineRunner(opts: {
  sttEnabled: boolean;
  ttsEnabled: boolean;
  sourceLang?: string;
  targetLang?: string;
}) {
  const [state, setState] = useState<PipelineRunState>(INITIAL);

  const run = useCallback(async (input: PipelineInput) => {
    const t0 = performance.now();
    setState({ status: 'running', activeStage: null, results: {}, inputType: input.type });

    try {
      // Image pipeline not yet supported on the backend
      if (input.type === 'image') {
        throw new Error('Image pipeline not yet supported — use text or audio input');
      }

      let currentText = input.text ?? '';
      const results: PipelineRunState['results'] = {};

      // ── STT ──
      if (input.type === 'audio' && opts.sttEnabled && input.blob) {
        setState(s => ({ ...s, activeStage: 'stt' }));
        const r = await playgroundStt(input.blob);
        results.stt = {
          text: r.text,
          latencyMs: r.latencyMs,
          provider: r.provider,
          model: r.model ?? undefined,
        };
        currentText = r.text;
        setState(s => ({ ...s, results: { ...s.results, stt: results.stt } }));
      }

      // ── LLM ──
      setState(s => ({ ...s, activeStage: 'llm' }));
      const source = opts.sourceLang ?? 'fr';
      const target = opts.targetLang ?? 'en';
      const llmR = await playgroundLlm({
        system_prompt: `Translate from ${source} to ${target}. Output ONLY the translation.`,
        messages: [{ role: 'user', content: currentText }],
      });
      results.llm = {
        text: llmR.content,
        latencyMs: llmR.latencyMs,
        provider: llmR.provider,
        model: llmR.model,
      };
      currentText = llmR.content;
      setState(s => ({ ...s, results: { ...s.results, llm: results.llm } }));

      // ── TTS ──
      if (opts.ttsEnabled) {
        setState(s => ({ ...s, activeStage: 'tts' }));
        const ttsR = await playgroundTts({ text: currentText, return_audio: true });
        results.tts = {
          audioBase64: ttsR.audioBase64,
          contentType: ttsR.contentType,
          latencyMs: ttsR.latencyMs,
          provider: ttsR.provider,
          model: ttsR.model,
        };
        setState(s => ({ ...s, results: { ...s.results, tts: results.tts } }));
      }

      const totalMs = Math.round(performance.now() - t0);
      setState(s => ({ ...s, status: 'done', activeStage: null, totalMs }));
    } catch (err) {
      const totalMs = Math.round(performance.now() - t0);
      setState(s => ({
        ...s,
        status: 'error',
        activeStage: null,
        totalMs,
        error: err instanceof Error ? err.message : 'Pipeline failed',
      }));
    }
  }, [opts.sttEnabled, opts.ttsEnabled, opts.sourceLang, opts.targetLang]);

  const reset = useCallback(() => {
    setState(INITIAL);
  }, []);

  return { ...state, run, reset };
}
