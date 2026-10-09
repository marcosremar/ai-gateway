import { describe, expect, it } from 'vitest';
import { withSignedVoice } from '../../../scripts/realtime-e2e/live-config';
import { RT_MAX_CFG_REF_CHARS } from '../../../src/realtime/token';

describe('live harness: a cloned voice travels in the signed session config', () => {
  const base = { system: 'Você é a padeira.', messages: [], voice: 'default', fallback_voice: 'default' };

  it('puts {audio, text} in the config the gateway signs and leaves the rest alone', () => {
    const cfg = withSignedVoice(base, ' QUJD\n', 'Bom dia.');
    expect(cfg).toEqual({ ...base, voice: { audio: 'data:audio/wav;base64,QUJD', text: 'Bom dia.' } });
    expect(base.voice).toBe('default');
  });

  it('refuses a sample that does not fit a signed config and points to a catalog voice', () => {
    expect(() => withSignedVoice(base, 'A'.repeat(RT_MAX_CFG_REF_CHARS), 'Bom dia.')).toThrow(/catalog voice/);
  });
});
