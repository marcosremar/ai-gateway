// ── BabelCast Gateway — Fan-Out Orchestrator (Pure Domain Logic) ──────────────
// Core multi-language parallel translation + TTS logic extracted from
// server/dub-fanout.ts. This module contains ZERO server/ imports — all
// server-bound state and I/O are injected via the FanoutDeps interface.

import { createLogger } from '../../logger';
import type { RaceCandidate } from '../routing/provider-racer';
import { raceProviders } from '../routing/provider-racer';
import type { GpuLLMResult, GpuTTSResult } from './gpu-fetch';
import { DEFAULT_SPEAKER } from './system-prompt';

const log = createLogger('fanout-orchestrator');

/**
 * Default cost-amplification cap for a single fan-out (#63). High-capacity GPU
 * deployments can raise it (more parallel dub targets) and low-budget ones can
 * lower it — override per call via `FanoutOpts.maxTargets` or the
 * `FANOUT_MAX` env var (call-level opt wins).
 */
export const DEFAULT_FANOUT_MAX = 16;

/** Resolve the effective fan-out cap from a per-call opt → env → default (#63). */
export function resolveFanoutMax(optMax?: number, env: { FANOUT_MAX?: string } = (typeof process !== 'undefined' ? process.env : {}) as any): number {
  if (typeof optMax === 'number' && Number.isFinite(optMax) && optMax > 0) return Math.floor(optMax);
  const raw = env?.FANOUT_MAX;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_FANOUT_MAX;
}

/**
 * Resolve the per-target budget (ms) from a per-call opt → env → 0 (#59).
 * 0 means "no budget" (legacy behaviour — never abandons a target).
 */
export function resolvePerTargetTimeout(optMs?: number, env: { FANOUT_TARGET_TIMEOUT_MS?: string } = (typeof process !== 'undefined' ? process.env : {}) as any): number {
  if (typeof optMs === 'number' && Number.isFinite(optMs) && optMs > 0) return Math.floor(optMs);
  const raw = env?.FANOUT_TARGET_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

/**
 * Race a per-target promise against a deadline (#59). On timeout the underlying
 * work is left running (race candidates carry their own abort), but the fan-out
 * stops awaiting it so one slow target can't wedge `Promise.allSettled`. The
 * timer is `unref`'d so it never keeps the process alive, and always cleared.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms budget`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FanoutOpts {
  speaker?: string;
  style?: string;
  targets: string[];
  /** Override the cost-amplification cap for this fan-out (#63). */
  maxTargets?: number;
  /**
   * Per-target wall-clock budget in ms (#59). Without an outer bound, one slow
   * target's LLM+TTS race (each candidate may have no overall deadline) holds
   * the `Promise.allSettled` and ties up resources. When set, a target that
   * exceeds this is abandoned (logged) instead of blocking the fan-out. 0/unset
   * = no budget (legacy behaviour). Resolved via opt → `FANOUT_TARGET_TIMEOUT_MS`.
   */
  perTargetTimeoutMs?: number;
  /**
   * The primary pipeline's already-computed translation (#58/#62). When a dub
   * target's language equals `primaryTranslation.target`, the fan-out reuses the
   * text (and seeds the cache) instead of paying a redundant LLM call for a
   * translation the primary path already produced.
   */
  primaryTranslation?: { target: string; translation: string };
}

/**
 * Routing snapshot for the fanout — pre-computed by the server layer.
 */
export interface FanoutRouting {
  gpuEndpoint?: string;
  llmOnGpu: boolean;
  ttsOnGpu: boolean;
  cloudProviderName: string;
}

/**
 * Server-bound side-effect callbacks for the fanout.
 */
export interface FanoutSideEffects {
  /** Broadcast subtitle for a target language. */
  broadcastSubtitle(data: {
    transcription: string; translation: string;
    source: string; target: string;
    timing: { stt_ms: number; llm_ms: number };
  }): void;
  /** Broadcast dub audio to subscribed WebSocket clients. */
  broadcastDubAudio(target: string, data: {
    type: 'dub:audio'; target: string;
    audio: string; transcription: string; translation: string;
    timing: { stt_ms: number; llm_ms: number; tts_ms: number; total_ms: number };
  }, audioBuffer: Buffer): void;
}

/**
 * Stage execution functions for the fanout.
 */
export interface FanoutStageExecutors {
  /** Get cached translation, or null if not cached. */
  getCachedTranslation(text: string, source: string, target: string, style: string): string | null;
  /** Store a translation in the cache. */
  setCachedTranslation(text: string, source: string, target: string, translated: string, style: string): void;
  /** Build a system prompt for source → target translation. */
  buildSystemPrompt(sourceName: string, targetName: string, style: string): string;

  /** Build LLM race candidates for a single target. */
  buildLlmCandidates(routing: FanoutRouting, sttText: string, source: string, target: string,
    systemPrompt: string): RaceCandidate<GpuLLMResult>[];

  /** Build TTS race candidates for a single target. */
  buildTtsCandidates(routing: FanoutRouting, translatedText: string, targetName: string,
    speaker: string): RaceCandidate<GpuTTSResult>[];
}

/** All dependencies injected into the fanout orchestrator. */
export interface FanoutDeps {
  routing: FanoutRouting;
  sideEffects: FanoutSideEffects;
  executors: FanoutStageExecutors;
  langNames: Record<string, string>;
}

// ── Fan-Out Orchestrator ─────────────────────────────────────────────────────

/**
 * Run parallel LLM+TTS for multiple target languages after a single STT pass.
 *
 * This is the pure fan-out logic — all server-bound state and I/O are injected
 * via `deps`. For each target language:
 *   1. Check translation cache → skip LLM if cached
 *   2. Race LLM candidates → get translated text
 *   3. Broadcast subtitle
 *   4. Race TTS candidates → get audio
 *   5. Broadcast dub:audio
 *
 * All targets run in parallel (Promise.allSettled). Individual failures
 * are logged but do not propagate.
 */
export async function runFanoutOrchestrator(
  sttText: string,
  source: string,
  sttMs: number,
  _sttProvider: string,
  opts: FanoutOpts,
  deps: FanoutDeps,
): Promise<void> {
  const { targets: rawTargets, speaker, style = 'default' } = opts;
  if (rawTargets.length === 0) return;

  // Dedupe + cap to prevent cost amplification from malformed or malicious
  // requests. Without this, `targets:['fr','fr','fr',...]` ran LLM+TTS once
  // per duplicate (translation cache populated AFTER race resolves, so
  // concurrent dupes all miss). The cap is configurable (#63) via
  // FanoutOpts.maxTargets or the FANOUT_MAX env var.
  const fanoutMax = resolveFanoutMax(opts.maxTargets);
  const targets = [...new Set(rawTargets)].slice(0, fanoutMax);
  if (targets.length < rawTargets.length) {
    log.warn(`Fan-out targets reduced ${rawTargets.length}→${targets.length} (dedupe + cap ${fanoutMax})`);
  }

  const { routing, sideEffects: fx, executors: ex, langNames: langs } = deps;
  const perTargetTimeout = resolvePerTargetTimeout(opts.perTargetTimeoutMs);
  // #58/#62 — the primary path already translated source→primaryTarget; reuse it
  // for a matching dub target instead of re-paying the LLM.
  const primary = opts.primaryTranslation;

  log.log(`Fan-out for ${targets.length} targets: [${targets.join(',')}]`);

  await Promise.allSettled(targets.map((target) => withDeadline((async () => {
    const t0 = Date.now();
    const sourceName = langs[source] || source;
    const targetName = langs[target] || target;

    try {
      // ── LLM Translation ──
      const cached = ex.getCachedTranslation(sttText, source, target, style);
      let translatedText = '';
      let llmProvider = '';
      let llmMs = 0;

      if (primary && primary.target === target && primary.translation.trim()) {
        // #58/#62 — reuse the primary's translation; skip the LLM call entirely
        // and seed the cache so a later identical request hits.
        translatedText = primary.translation;
        llmProvider = 'primary';
        ex.setCachedTranslation(sttText, source, target, translatedText, style);
      } else if (cached !== null) {
        translatedText = cached;
        llmProvider = 'cache';
      } else {
        const systemPrompt = ex.buildSystemPrompt(sourceName, targetName, style);
        const llmCandidates = ex.buildLlmCandidates(routing, sttText, source, target, systemPrompt);
        const llmRace = await raceProviders(llmCandidates, { logPrefix: `[dub-llm:${target}]` });
        translatedText = llmRace.result.translated_text;
        llmProvider = llmRace.provider;
        llmMs = Date.now() - t0;

        if (translatedText) ex.setCachedTranslation(sttText, source, target, translatedText, style);
      }

      if (!translatedText.trim()) return;

      // Broadcast subtitle for this target language
      fx.broadcastSubtitle({
        transcription: sttText,
        translation: translatedText,
        source, target,
        timing: { stt_ms: sttMs, llm_ms: llmMs },
      });

      // ── TTS Synthesis ──
      const ttsT0 = Date.now();
      const ttsCandidates = ex.buildTtsCandidates(routing, translatedText, targetName, speaker || DEFAULT_SPEAKER);
      const ttsRace = await raceProviders(ttsCandidates, { logPrefix: `[dub-tts:${target}]` });
      const ttsMs = Date.now() - ttsT0;
      const ttsAudioBuffer = ttsRace.result.audio;
      const audioB64 = ttsAudioBuffer.toString('base64');
      const totalMs = Date.now() - t0;

      // Send dubbed audio only to clients subscribed to this target
      fx.broadcastDubAudio(target, {
        type: 'dub:audio',
        target,
        audio: audioB64,
        transcription: sttText,
        translation: translatedText,
        timing: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: totalMs },
      }, ttsAudioBuffer);

      log.log(`${target}: ${totalMs}ms (LLM=${llmMs}ms[${llmProvider}] TTS=${ttsMs}ms[${ttsRace.provider}])`);
    } catch (err) {
      log.warn(`${target} failed:`, err instanceof Error ? err.message : err);
    }
  })(), perTargetTimeout, `[dub:${target}]`).catch((err) => {
    // #59 — deadline overrun is surfaced here (not inside the inner try, whose
    // own catch only sees stage errors) so a budget-exceeded target is logged
    // rather than silently swallowed by allSettled.
    log.warn(`${target} abandoned:`, err instanceof Error ? err.message : err);
  })));
}
