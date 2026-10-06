/**
 * Microphone → Silero frames: an AudioWorklet that cuts the 16 kHz input into 512-sample frames and posts each one to
 * the main thread. The worklet source is inline (a Blob URL), so no bundler has to know about a worklet file.
 */
import { SILERO_FRAME_SAMPLES, SILERO_SAMPLE_RATE } from './silero';

const PROCESSOR = 'voice-frames';

export const VOICE_FRAME_WORKLET = `
class VoiceFrames extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Float32Array(${SILERO_FRAME_SAMPLES}); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.frame[this.filled++] = channel[i];
      if (this.filled === this.frame.length) { this.port.postMessage(this.frame); this.frame = new Float32Array(this.frame.length); this.filled = 0; }
    }
    return true;
  }
}
registerProcessor("${PROCESSOR}", VoiceFrames);
`;

/** An `AudioContext` at Silero's rate (the browser resamples the microphone into it). */
export function createVoiceFrameContext(): AudioContext {
  return new AudioContext({ sampleRate: SILERO_SAMPLE_RATE });
}

/** Registers the frame worklet on `audio`. */
export async function addVoiceFrameWorklet(audio: BaseAudioContext): Promise<void> {
  const workletUrl = URL.createObjectURL(new Blob([VOICE_FRAME_WORKLET], { type: 'text/javascript' }));
  await audio.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);
}

/** A frame node on a context that already has the worklet (`addVoiceFrameWorklet`); frames arrive on `port.onmessage`. */
export function createVoiceFrameNode(audio: BaseAudioContext): AudioWorkletNode {
  return new AudioWorkletNode(audio, PROCESSOR);
}
