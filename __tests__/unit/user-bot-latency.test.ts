import { describe, it, expect, vi } from 'vitest';
import { UserBotLatencyObserver } from '../../src/observers';
import type { LatencyBreakdown, LatencyMeasurement } from '../../src/observers';
import type { PipelineFrame } from '../../src/observers';

// Helper to build a frame
const f = (kind: PipelineFrame['kind'], ts: number, extra: Partial<PipelineFrame> = {}): PipelineFrame =>
  ({ kind, ts, ...extra });

describe('UserBotLatencyObserver', () => {
  // ── basic emission ──────────────────────────────────────────────────────────

  it('emits onLatencyMeasured when tts_first_audio arrives after user_speech_start', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('user_speech_start', 100));
    o.onFrame(f('tts_first_audio', 600));

    expect(measured).toHaveLength(1);
    expect(measured[0].totalMs).toBe(500);
    expect(measured[0].ts).toBe(600);
  });

  it('emits onLatencyMeasured when bot_speech_start arrives (no tts_first_audio)', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('bot_speech_start', 300));

    expect(measured).toHaveLength(1);
    expect(measured[0].totalMs).toBe(300);
  });

  it('prefers tts_first_audio over bot_speech_start for total latency', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('tts_first_audio', 200));
    // bot_speech_start arrives later — should not fire a second measurement
    o.onFrame(f('bot_speech_start', 300));

    // Only one measurement (tts_first_audio clears current turn)
    expect(measured).toHaveLength(1);
    expect(measured[0].totalMs).toBe(200);
  });

  // ── per-stage breakdown ──────────────────────────────────────────────────────

  it('emits full breakdown with all stages present', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('stt_partial', 100, { provider: 'deepgram' }));
    o.onFrame(f('stt_final', 400, { provider: 'deepgram' }));
    o.onFrame(f('llm_request', 410));
    o.onFrame(f('llm_first_token', 700, { provider: 'groq' }));
    o.onFrame(f('llm_complete', 900));
    o.onFrame(f('tts_first_audio', 1000, { provider: 'modal' }));

    expect(breakdowns).toHaveLength(1);
    const b = breakdowns[0];
    expect(b.totalMs).toBe(1000);         // 1000 - 0
    expect(b.sttTtfbMs).toBe(100);        // 100 - 0 (first partial)
    expect(b.sttFinalMs).toBe(400);       // 400 - 0 (stt_final - speech_start)
    expect(b.llmTtftMs).toBe(300);        // 700 - 400 (llm_first_token - stt_final)
    expect(b.llmCompleteMs).toBe(200);    // 900 - 700 (llm_complete - llm_first_token)
    expect(b.ttsTtfaMs).toBe(300);        // 1000 - 700 (tts_first_audio - llm_first_token)
    expect(b.providers.stt).toBe('deepgram');
    expect(b.providers.llm).toBe('groq');
    expect(b.providers.tts).toBe('modal');
  });

  it('sets sttTtfbMs to null when no stt_partial is present', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('stt_final', 300));
    o.onFrame(f('llm_first_token', 600));
    o.onFrame(f('tts_first_audio', 900));

    expect(breakdowns[0].sttTtfbMs).toBeNull();
    expect(breakdowns[0].sttFinalMs).toBe(300);
  });

  it('sets sttFinalMs to null when no stt_final present', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('tts_first_audio', 500));

    expect(breakdowns[0].sttFinalMs).toBeNull();
    expect(breakdowns[0].llmTtftMs).toBeNull();
    expect(breakdowns[0].ttsTtfaMs).toBeNull();
  });

  it('sets llmCompleteMs to null when llm_complete is absent', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('stt_final', 200));
    o.onFrame(f('llm_first_token', 400));
    o.onFrame(f('tts_first_audio', 600));

    expect(breakdowns[0].llmCompleteMs).toBeNull();
  });

  it('uses llm_request as fallback for llmTtftMs when stt_final is absent', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('llm_request', 200));
    o.onFrame(f('llm_first_token', 500));
    o.onFrame(f('tts_first_audio', 800));

    // llmTtftMs = llm_first_token - llm_request = 500 - 200 = 300
    expect(breakdowns[0].llmTtftMs).toBe(300);
  });

  // ── provider tracking ────────────────────────────────────────────────────────

  it('falls back to stt_partial provider when stt_final provider is absent', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('stt_partial', 100, { provider: 'groq-stt' }));
    // stt_final has no provider
    o.onFrame(f('stt_final', 300));
    o.onFrame(f('tts_first_audio', 600));

    expect(breakdowns[0].providers.stt).toBe('groq-stt');
  });

  it('falls back to llm_request provider when llm_first_token provider is absent', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('llm_request', 100, { provider: 'ollama' }));
    o.onFrame(f('llm_first_token', 400));  // no provider
    o.onFrame(f('tts_first_audio', 700));

    expect(breakdowns[0].providers.llm).toBe('ollama');
  });

  it('sets providers to empty object when no providers are tagged', () => {
    const breakdowns: LatencyBreakdown[] = [];
    const o = new UserBotLatencyObserver({ onLatencyBreakdown: (b) => breakdowns.push(b) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('tts_first_audio', 500));

    expect(breakdowns[0].providers).toEqual({ stt: undefined, llm: undefined, tts: undefined });
  });

  // ── interrupt handling ────────────────────────────────────────────────────────

  it('resets when interrupted by a new user_speech_start before tts_first_audio', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    // Turn 1 — interrupted
    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('stt_partial', 100));
    // Interrupt at t=200 — turn 1 is discarded
    o.onFrame(f('user_speech_start', 200));
    o.onFrame(f('tts_first_audio', 700));

    // Only one measurement for the second turn
    expect(measured).toHaveLength(1);
    expect(measured[0].totalMs).toBe(500); // 700 - 200
  });

  it('does not emit when tts_first_audio arrives with no prior user_speech_start', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('tts_first_audio', 500));
    o.onFrame(f('bot_speech_start', 600));

    expect(measured).toHaveLength(0);
  });

  it('does not emit a second time for the same turn', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('tts_first_audio', 300));

    // These arrive after turn was closed — should be ignored
    o.onFrame(f('tts_first_audio', 400));
    o.onFrame(f('bot_speech_start', 500));

    expect(measured).toHaveLength(1);
  });

  // ── multi-turn sequences ─────────────────────────────────────────────────────

  it('tracks multiple sequential turns independently', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    // Turn 1
    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('tts_first_audio', 400));
    // Turn 2
    o.onFrame(f('user_speech_start', 1000));
    o.onFrame(f('tts_first_audio', 1200));

    expect(measured).toHaveLength(2);
    expect(measured[0].totalMs).toBe(400);
    expect(measured[1].totalMs).toBe(200);
  });

  // ── frame cap (maxFramesPerTurn) ─────────────────────────────────────────────

  it('respects maxFramesPerTurn cap: frames beyond the cap are silently dropped', () => {
    const breakdowns: LatencyBreakdown[] = [];
    // cap=5: speechStart(1) + sttPartial(2) + sttFinal(3) + llmFirst(4) + ttsFirst(5→push+emit)
    const o = new UserBotLatencyObserver({
      onLatencyBreakdown: (b) => breakdowns.push(b),
      maxFramesPerTurn: 5,
    });

    o.onFrame(f('user_speech_start', 0));    // 1st (stored by reset)
    o.onFrame(f('stt_partial', 100));         // 2nd (1 < 5 → pushed)
    o.onFrame(f('stt_final', 200));           // 3rd (2 < 5 → pushed)
    o.onFrame(f('llm_first_token', 400));     // 4th (3 < 5 → pushed)
    o.onFrame(f('tts_first_audio', 600));     // 5th (4 < 5 → pushed → emit)

    expect(breakdowns).toHaveLength(1);
    expect(breakdowns[0].totalMs).toBe(600);
    expect(breakdowns[0].sttTtfbMs).toBe(100);
    expect(breakdowns[0].sttFinalMs).toBe(200);
    // tts_first_audio - llm_first_token = 600 - 400 = 200
    expect(breakdowns[0].ttsTtfaMs).toBe(200);
  });

  it('suppresses emission when trigger frame itself exceeds the cap', () => {
    const measured: LatencyMeasurement[] = [];
    // cap=2: speechStart(1) + sttPartial(2) → full; tts_first_audio(2 < 2 = false → not stored)
    // _emit() cannot find the end-frame, so it returns without emitting
    const o = new UserBotLatencyObserver({
      onLatencyMeasured: (m) => measured.push(m),
      maxFramesPerTurn: 2,
    });

    o.onFrame(f('user_speech_start', 0));  // stored (turn reset)
    o.onFrame(f('stt_partial', 100));       // 1 < 2 → pushed (length now 2)
    o.onFrame(f('tts_first_audio', 500));   // 2 < 2 = false → NOT pushed; emit triggered but endFrame not found

    expect(measured).toHaveLength(0);
  });

  // ── observer robustness ──────────────────────────────────────────────────────

  it('does not throw when onLatencyMeasured callback throws', () => {
    const o = new UserBotLatencyObserver({
      onLatencyMeasured: () => { throw new Error('boom'); },
    });

    o.onFrame(f('user_speech_start', 0));
    expect(() => o.onFrame(f('tts_first_audio', 500))).not.toThrow();
  });

  it('does not throw when onLatencyBreakdown callback throws', () => {
    const o = new UserBotLatencyObserver({
      onLatencyBreakdown: () => { throw new Error('bang'); },
    });

    o.onFrame(f('user_speech_start', 0));
    expect(() => o.onFrame(f('tts_first_audio', 300))).not.toThrow();
  });

  it('ignores all frames before user_speech_start', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('stt_partial', 100));
    o.onFrame(f('stt_final', 200));
    o.onFrame(f('llm_first_token', 400));
    o.onFrame(f('tts_first_audio', 600));

    expect(measured).toHaveLength(0);
  });

  it('fires both callbacks in the same emission', () => {
    const measuredCalls: number[] = [];
    const breakdownCalls: number[] = [];
    const o = new UserBotLatencyObserver({
      onLatencyMeasured: (m) => measuredCalls.push(m.totalMs),
      onLatencyBreakdown: (b) => breakdownCalls.push(b.totalMs),
    });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('tts_first_audio', 250));

    expect(measuredCalls).toEqual([250]);
    expect(breakdownCalls).toEqual([250]);
  });

  it('has name property equal to "user-bot-latency"', () => {
    const o = new UserBotLatencyObserver();
    expect(o.name).toBe('user-bot-latency');
  });

  // ── bot_speech_start as end-frame ─────────────────────────────────────────────

  it('bot_speech_start triggers emission and clears the turn', () => {
    const measured: LatencyMeasurement[] = [];
    const o = new UserBotLatencyObserver({ onLatencyMeasured: (m) => measured.push(m) });

    o.onFrame(f('user_speech_start', 0));
    o.onFrame(f('bot_speech_start', 400));
    // Subsequent frames should NOT re-emit
    o.onFrame(f('tts_first_audio', 600));

    expect(measured).toHaveLength(1);
    expect(measured[0].totalMs).toBe(400);
  });
});
