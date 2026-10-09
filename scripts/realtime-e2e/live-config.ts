import { encodeSessionConfig, RT_MAX_CFG_REF_CHARS } from '../../src/realtime/token';

export function withSignedVoice(config: Record<string, unknown>, b64: string, text: string): Record<string, unknown> {
  const signed = { ...config, voice: { audio: `data:audio/wav;base64,${b64.trim()}`, text } };
  const chars = encodeSessionConfig(signed).length;
  if (chars > RT_MAX_CFG_REF_CHARS) {
    throw new Error(
      `LIVE_VOICE_B64 makes the session config ${chars} base64url characters, over ${RT_MAX_CFG_REF_CHARS}: ` +
      'the edge refuses a voice sent after connect, so use a catalog voice of the replica (deployment files / fileUrls, RT_CONFIG voice id)',
    );
  }
  return signed;
}
