//! Audio helpers.

/// Repairs a "streaming" WAV header: some TTS servers (vLLM-Omni / Qwen3-TTS) answer WAV with the RIFF and `data`
/// sizes set to `0xFFFFFFFF` (unknown), which header-trusting readers (hound, rodio) refuse. The sizes are set to the
/// real ones and `data` is cut to a whole number of sample frames. Anything else is returned untouched.
/// (Ported from babelcast `bc-gateway-client`.)
pub fn fix_streaming_wav(mut wav: Vec<u8>) -> Vec<u8> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return wav;
    }
    let u32_at = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let mut pos = 12;
    let mut block_align = 1usize;
    while pos + 8 <= wav.len() {
        let id = [wav[pos], wav[pos + 1], wav[pos + 2], wav[pos + 3]];
        let size = u32_at(&wav, pos + 4) as usize;
        if &id == b"fmt " && pos + 8 + 14 <= wav.len() {
            block_align = (u16::from_le_bytes([wav[pos + 20], wav[pos + 21]]) as usize).max(1);
        }
        if &id == b"data" {
            let start = pos + 8;
            let available = wav.len() - start;
            if size <= available && size % block_align == 0 && u32_at(&wav, 4) as usize == wav.len() - 8 {
                return wav;
            }
            let data_len = available - available % block_align;
            wav.truncate(start + data_len);
            wav[pos + 4..pos + 8].copy_from_slice(&(data_len as u32).to_le_bytes());
            let riff = (wav.len() - 8) as u32;
            wav[4..8].copy_from_slice(&riff.to_le_bytes());
            return wav;
        }
        if size == u32::MAX as usize {
            return wav;
        }
        pos += 8 + size + (size & 1);
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::fix_streaming_wav;

    /// 16-bit mono PCM WAV with the given header sizes.
    fn wav(riff: u32, data: u32, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&riff.to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1u16.to_le_bytes()); // mono
        v.extend_from_slice(&24_000u32.to_le_bytes());
        v.extend_from_slice(&48_000u32.to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes()); // block align
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data.to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn streaming_sizes_become_real_and_odd_tail_is_cut() {
        let fixed = fix_streaming_wav(wav(u32::MAX, u32::MAX, &[1, 2, 3, 4, 5]));
        assert_eq!(fixed.len(), 44 + 4);
        assert_eq!(u32::from_le_bytes(fixed[40..44].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(fixed[4..8].try_into().unwrap()), (fixed.len() - 8) as u32);
    }

    #[test]
    fn correct_wav_and_other_content_pass_untouched() {
        let ok = wav(36 + 4, 4, &[1, 2, 3, 4]);
        assert_eq!(fix_streaming_wav(ok.clone()), ok);
        assert_eq!(fix_streaming_wav(b"ID3 mp3".to_vec()), b"ID3 mp3");
    }
}
