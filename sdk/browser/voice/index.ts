/**
 * @parle/ai-gateway/voice — speech detection in the browser.
 *
 * RMS energy gate → Silero VAD v5 (onnxruntime-web, injected) → end-of-utterance silence, with Silero in a worker
 * (main-thread fallback). High level: `createSpeechDetector` (one WAV per speaking turn). Lower level, for consumers
 * that wire their own sinks: the pure reducer (`createVoiceActivityPipeline`), the classifier pool
 * (`createSileroPool`), the frame worklet and the worker host (`serveSileroWorker`).
 *
 * The Silero model ships with the package (`sileroModelUrl()`); every product timing is a parameter.
 */
export {
  VOICE_ACTIVITY_TUNING,
  VOICE_FRAME_MS,
  createVoiceActivityPipeline,
  initialVoiceActivity,
  rmsOf,
  stepVoiceActivity,
  turnEndAfterVadEndMs,
} from './voice-activity';
export type {
  VadEffect,
  VoiceActivityEffect,
  VoiceActivityPipeline,
  VoiceActivityState,
  VoiceActivityTuning,
  VoiceFrameClassifier,
  VoiceFrameInput,
  VoiceStage,
} from './voice-activity';

export {
  SILERO_FRAME_SAMPLES,
  SILERO_SAMPLE_RATE,
  configureOnnxWasm,
  createSileroVad,
  fetchSileroModel,
  sileroModelUrl,
} from './silero';
export type { OnnxRuntime, OnnxSession, OnnxTensor, OnnxWasmRuntime } from './silero';

export { SILERO_WORKER_READY_TIMEOUT_MS, loadSileroWorker } from './silero-worker-client';
export type { SileroBackend, WorkerLike } from './silero-worker-client';
export { serveSileroWorker } from './silero-worker-host';
export type { SileroWorkerScope } from './silero-worker-host';
export type { SileroWorkerReply, SileroWorkerRequest } from './silero-worker-protocol';

export { createSharedSilero, createSileroPool, sileroInThread } from './silero-pool';
export type { SileroEngine, SileroPool, SileroPoolEvent, SileroPoolHooks } from './silero-pool';

export { VOICE_FRAME_WORKLET, addVoiceFrameWorklet, createVoiceFrameContext, createVoiceFrameNode } from './voice-frames';
export { startSileroListener } from './silero-listener';
export type { SileroListener } from './silero-listener';

export { STT_RATE, clipToWav, createTurnClip, encodeWav, voicedRange } from './turn-clip';
export type { TurnClip } from './turn-clip';
export { createTurnTaking } from './turn-taking';
export type { TurnTaking, TurnTakingOptions } from './turn-taking';
export { createSpeechDetector } from './speech-detector';
export type { MicSilenceWatch, SpeechDetector, SpeechDetectorOptions } from './speech-detector';
