/**
 * The high-level browser speech detector: RMS → Silero VAD → end-of-utterance silence, in the browser, on one
 * microphone stream. It hands the caller one WAV per speaking turn (`onTurn`), announces the voice as soon as Silero
 * confirms it (`onVoice`) and watches for a microphone that delivers silence (`onMicSilence`).
 *
 * Every timing that belongs to the product (`endSilenceMs`, `maxSpeechMs`, `echoTailMs`, the silent-microphone
 * thresholds) is a parameter: the SDK does not decide how long a learner may pause.
 */
import { createTurnClip, clipToWav } from './turn-clip';
import { createTurnTaking } from './turn-taking';
import { startSileroListener } from './silero-listener';
import type { VoiceActivityTuning, VoiceFrameClassifier } from './voice-activity';

/** Silent-microphone watch: the loudest sample over each `checkMs` window under `peak` = silent. */
export interface MicSilenceWatch {
  peak: number;
  checkMs: number;
}

export interface SpeechDetectorOptions {
  stream: MediaStream;
  /** The page's audio context (decoding the clip, the silence analyser); created and closed here when absent. */
  context?: AudioContext;
  /** The Silero classifier (e.g. `createSharedSilero(engine).load`). */
  classifier: () => Promise<VoiceFrameClassifier>;
  /** Whole pause, from the last voiced frame, that ends a turn. */
  endSilenceMs: number;
  /** Longest turn: it closes this long after the voice started, even without a pause. */
  maxSpeechMs: number;
  /** Effects are ignored this long after listening opens (the page's own voice still in the room). */
  echoTailMs: number;
  micSilence: MicSilenceWatch;
  tuning?: VoiceActivityTuning;
  /** How often the listening gate and the silence analyser are polled (ms). */
  pollMs?: number;
  /** Polled: may the detector take a turn now (not while the page speaks)? */
  mayListen: () => boolean;
  onVoice: () => void;
  onTurn: (wav: Blob) => void;
  /** Called on each change of the silent-microphone verdict (first call after the first `checkMs`). */
  onMicSilence: (silent: boolean) => void;
}

export interface SpeechDetector {
  /** Moves the detector to another microphone stream (drops the turn in progress; the caller stops the old tracks). */
  switchStream(stream: MediaStream): void;
  stop(): void;
}

const DEFAULT_POLL_MS = 50;
const ANALYSER_SAMPLES = 1024;

export async function createSpeechDetector(opts: SpeechDetectorOptions): Promise<SpeechDetector> {
  const ownContext = !opts.context;
  const context = opts.context ?? new AudioContext();
  const analyser = context.createAnalyser();
  let source = context.createMediaStreamSource(opts.stream);
  source.connect(analyser);
  const samples = new Float32Array(ANALYSER_SAMPLES);
  let track = opts.stream.getAudioTracks()[0]!;
  let loudest = 0;
  let checkAt = performance.now() + opts.micSilence.checkMs;
  let micSilent: boolean | null = null;

  const turns = createTurnTaking({
    clip: createTurnClip(),
    track: () => track,
    toWav: (clip) => clipToWav(clip, context),
    endSilenceMs: opts.endSilenceMs,
    maxSpeechMs: opts.maxSpeechMs,
    echoTailMs: opts.echoTailMs,
    tuning: opts.tuning,
    onVoice: opts.onVoice,
    onTurn: opts.onTurn,
  });

  const vad = await startSileroListener(await opts.classifier(), (effect) => turns.onEffect(effect), opts.tuning);
  vad.connect(opts.stream);

  const watch = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample));
    if (performance.now() >= checkAt) {
      const silent = loudest < opts.micSilence.peak;
      if (silent !== micSilent) { micSilent = silent; opts.onMicSilence(silent); }
      loudest = 0;
      checkAt = performance.now() + opts.micSilence.checkMs;
    }
    if (turns.setListening(opts.mayListen())) vad.restart();
  }, opts.pollMs ?? DEFAULT_POLL_MS);

  return {
    switchStream(stream) {
      turns.drop();
      source.disconnect();
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      track = stream.getAudioTracks()[0]!;
      vad.connect(stream);
      vad.restart();
      loudest = 0;
      checkAt = performance.now() + opts.micSilence.checkMs;
    },
    stop() {
      clearInterval(watch);
      turns.drop();
      vad.stop();
      source.disconnect();
      if (ownContext) void context.close();
    },
  };
}
