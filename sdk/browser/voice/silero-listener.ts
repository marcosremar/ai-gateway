/**
 * A Silero listener on one microphone stream: frame worklet → voice-activity pipeline → effects, frames scored in
 * arrival order on one promise chain. `restart()` resets the classifier and the reducer (a new turn starts clean).
 */
import {
  createVoiceActivityPipeline, type VadEffect, type VoiceActivityPipeline, type VoiceActivityTuning, type VoiceFrameClassifier,
} from './voice-activity';
import { addVoiceFrameWorklet, createVoiceFrameContext, createVoiceFrameNode } from './voice-frames';

export interface SileroListener {
  connect(stream: MediaStream): void;
  restart(): void;
  stop(): void;
}

export async function startSileroListener(
  classifier: VoiceFrameClassifier,
  onEffect: (effect: VadEffect) => void,
  tuning?: VoiceActivityTuning,
): Promise<SileroListener> {
  const audio = createVoiceFrameContext();
  await audio.resume().catch(() => {});
  await addVoiceFrameWorklet(audio);
  const node = createVoiceFrameNode(audio);
  let source: MediaStreamAudioSourceNode | null = null;
  let pipeline: VoiceActivityPipeline = createVoiceActivityPipeline(classifier, onEffect, tuning);
  let queue = Promise.resolve();
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const current = pipeline;
    queue = queue.then(() => current.push(event.data)).catch(() => undefined);
  };
  return {
    connect(stream) {
      source?.disconnect();
      source = audio.createMediaStreamSource(stream);
      source.connect(node);
    },
    restart() {
      classifier.reset();
      pipeline = createVoiceActivityPipeline(classifier, onEffect, tuning);
    },
    stop() {
      source?.disconnect();
      void audio.close();
    },
  };
}
