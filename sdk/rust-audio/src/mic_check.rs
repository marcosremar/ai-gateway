//! What is wrong with the microphone, from the audio itself — so an app can tell the person what to change
//! ("too quiet", "far away or echoing", "clipping", "noisy room", "electrical hum") instead of showing worse
//! subtitles without a reason.
//!
//! [`MicCheck`] keeps the last [`WINDOW_S`] seconds of frames: the frame's level as it came from the microphone,
//! the speech probability the VAD already computed for it (on its levelled copy — no second VAD), and the clipped
//! samples; plus a few seconds of the pauses for the hum. [`MicCheck::report`] turns that into numbers and
//! [`MicIssue`]s. Each check was measured on the ucast.me benchmark's room grid (reverb, distance, noise,
//! quiet microphones, clipped and humming copies of clean talks) and only flags what made the subtitles worse;
//! the thresholds and the numbers behind them are next to each constant.

use std::collections::VecDeque;

use crate::vad::{FRAME_SAMPLES, SAMPLE_RATE};

/// Seconds of audio a report looks at.
pub const WINDOW_S: f32 = 30.0;
/// Seconds of sound (frames well above the room's floor) a report needs before it says anything.
pub const MIN_SOUND_S: f32 = 8.0;
/// Seconds of pauses kept for the hum (0.25 Hz resolution at 4 s).
const HUM_S: f32 = 4.0;
/// Frames per hum block (~0.5 s, 2 Hz resolution: the neighbours 6–14 Hz away stay apart).
const HUM_BLOCK: usize = 16;

/// Speech this quiet (median level of the sound, dBFS, as it came from the microphone) is too quiet.
pub const QUIET_DB: f32 = -50.0;
/// More than this share of the speech samples at full scale = clipping.
pub const CLIPPED_SHARE: f32 = 0.001;
/// The VAD this unsure on frames that clearly carry sound = the voice comes from far away or with echo (or with
/// other voices behind it). Share of 10 s reports under 0.95 on the benchmark (the VAD hearing its levelled copy):
/// clean talks, a good room (RT60 0.4 s), conversations, accents 0–3 %; RT60 0.8 s at 3 m 37–78 %, at 6 m
/// 65–91 %, RT60 1.2 s 100 %, babble at 10 dB 19–47 %, a real table microphone (AMI) 19 % — the conditions where
/// the app's WER went from 6.8 % to 11–41 %.
pub const UNSURE_VAD: f32 = 0.95;
/// Far/echo only when the "speech" is at least this loud (dBFS). Studio pauses sit around −45…−50 and used to
/// look far after VadLevel; a room mic with a real talker is around −29.
pub const FAR_MIN_SPEECH_DB: f32 = -40.0;
/// "Sure speech" this quiet is not a voice: a table microphone's room tone makes Silero sure at −58 dBFS.
/// Quieter speech is [`MicIssue::TooQuiet`]'s subject, never [`MicIssue::Noisy`]'s.
pub const NOISY_MIN_SPEECH_DB: f32 = QUIET_DB;
/// Speech less than this above the room's floor (dB) = noisy.
pub const NOISY_SNR_DB: f32 = 10.0;
/// VAD probability that counts as speech for the noisy check. Lower (0.5) also matched air-conditioning
/// and other quiet ambient after `VadLevel` (room HVAC floor alone: ~22 % ≥ 0.5, ~11 % ≥ 0.8, ~6 % ≥ 0.9;
/// clean talk ~65 % ≥ 0.9). 0.85 keeps the 5 dB noise case (measured ~70 % of reports) and drops the HVAC floor.
pub const NOISY_VOICED_PROB: f32 = 0.85;
/// A peak at 50/60 Hz and its harmonics this much above the bins next to it (dB)…
pub const HUM_PEAK_DB: f32 = 8.0;
/// …and loud enough to matter: no more than this below the speech (dB).
pub const HUM_AUDIBLE_DB: f32 = -25.0;

/// Something the person can change, most harmful first. Only [`MicIssue::hurts_transcription`] ones made the
/// subtitles worse on the benchmark; the others are real (clipping and hum are heard by an audience, a
/// recording keeps them) but Parakeet + the VAD's level transcribed through them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum MicIssue {
    /// The sound reaches the microphone clipped: move it away or lower the input volume.
    Clipping,
    /// The voice is far away or echoing: use a microphone close to the mouth (lapel, headset).
    FarOrEcho,
    /// The speech is very quiet: bring the microphone closer or raise the input volume.
    TooQuiet,
    /// The room's noise is close to the speech: move away from it or use a closer microphone.
    Noisy,
    /// Electrical hum (50/60 Hz): another cable, USB port or power socket, away from power supplies.
    Hum,
}

impl MicIssue {
    /// Whether this made the transcription worse on the ucast.me benchmark (app WER, clean talk 6.8 %): far/echo
    /// 11–41 %, noisy (5 dB) 18 % — yes; clipping (×3, ×8) 6.9 %, hum (−35 / −55 dB) 6.9–7.2 %, a quiet
    /// microphone (−15 / −25 dB) 6.8–7.0 % — no.
    pub fn hurts_transcription(self) -> bool {
        matches!(self, MicIssue::FarOrEcho | MicIssue::Noisy)
    }
}

/// What the microphone hears **when nobody is talking** — the pause floor, which decides whether an advice is
/// even meaningful. Measured on the ucast.me benchmark sets (2026-10-26, `docs/medicoes.md` § piso): a single
/// threshold cannot tell a clean studio pause from air-conditioning, and both from a real noisy room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Floor {
    /// Digital zeros (muted channel, joined gaps): nothing to measure.
    DigitalSilence,
    /// Clean-talk pauses, −54 dBFS and quieter, no digital.
    StudioQuiet,
    /// Room tone / air-conditioning / projector: ~−40…−50 dBFS.
    RoomAmbient,
    /// Loud noise floor (~−38 dBFS and up) waiting to swallow the voice.
    LoudFloor,
    /// Real meeting recordings: some digital gaps plus a quiet floor.
    MeetingFloor,
}

impl Floor {
    /// The floor from the pauses: their median level and how much of them is digital silence.
    fn of(pause_median_db: f32, digital_share: f32) -> Self {
        if pause_median_db <= -90.0 || (digital_share >= 0.05 && pause_median_db <= -70.0) {
            Floor::DigitalSilence
        } else if digital_share >= 0.05 {
            Floor::MeetingFloor
        } else if pause_median_db <= -54.0 {
            Floor::StudioQuiet
        } else if pause_median_db <= -39.0 {
            Floor::RoomAmbient
        } else {
            Floor::LoudFloor
        }
    }

    /// Whether this floor alone should never produce an advice (nobody spoke).
    pub fn is_quiet(self) -> bool {
        !matches!(self, Floor::LoudFloor)
    }
}

/// The numbers behind a report (dB are dBFS of the audio as it came from the microphone).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct MicReport {
    /// Median level of the frames with sound.
    pub speech_db: f32,
    /// The room's floor (20th percentile of the frames the VAD calls silence), `None` when the pauses are
    /// digital silence or too short to tell.
    pub noise_db: Option<f32>,
    /// Median speech probability on the frames with clear sound (10 dB over the floor), `None` with too few.
    pub vad_confidence: Option<f32>,
    /// Share of the samples of the sound frames at full scale.
    pub clipped_share: f32,
    /// Peak of the hum bins over their neighbours (dB) and its level relative to the speech (dB).
    pub hum: Option<(f32, f32)>,
    /// What to tell the person, most harmful first (empty = nothing to change).
    pub issues: Vec<MicIssue>,
    /// What the room sounds like while nobody talks (`None` with too few pauses to tell).
    pub floor: Option<Floor>,
}

impl MicReport {
    pub fn snr_db(&self) -> Option<f32> {
        self.noise_db.map(|n| self.speech_db - n)
    }
}

#[derive(Clone, Copy)]
struct Frame {
    db: f32,
    prob: f32,
    clipped: u16,
}

pub struct MicCheck {
    frames: VecDeque<Frame>,
    pauses: VecDeque<f32>,
}

impl Default for MicCheck {
    fn default() -> Self {
        Self::new()
    }
}

fn frames_in(seconds: f32) -> usize {
    (seconds * SAMPLE_RATE as f32 / FRAME_SAMPLES as f32) as usize
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

/// Goertzel power of `freq` over `x`.
fn power(x: &[f32], freq: f32) -> f32 {
    let w = 2.0 * std::f32::consts::PI * freq / SAMPLE_RATE as f32;
    let c = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for &v in x {
        let s0 = v + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    (s1 * s1 + s2 * s2 - c * s1 * s2).max(0.0)
}

impl MicCheck {
    pub fn new() -> Self {
        Self { frames: VecDeque::with_capacity(frames_in(WINDOW_S) + 1), pauses: VecDeque::new() }
    }

    /// One frame as it came from the microphone (before any level) and the VAD's speech probability for it.
    pub fn push(&mut self, frame: &[f32], prob: f32) {
        let ms = frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32;
        let db = 10.0 * ms.max(1e-18).log10();
        let clipped = frame.iter().filter(|s| s.abs() >= 0.98).count() as u16;
        if self.frames.len() == frames_in(WINDOW_S) {
            self.frames.pop_front();
        }
        self.frames.push_back(Frame { db, prob, clipped });
        if prob < 0.2 && db > -100.0 {
            self.pauses.extend(frame.iter().copied());
            let keep = (HUM_S * SAMPLE_RATE as f32) as usize;
            while self.pauses.len() > keep {
                self.pauses.pop_front();
            }
        }
    }

    /// Forget everything (another microphone was chosen).
    pub fn clear(&mut self) {
        self.frames.clear();
        self.pauses.clear();
    }

    /// `None` until there are [`MIN_SOUND_S`] seconds of sound in the window.
    pub fn report(&self) -> Option<MicReport> {
        let silent: Vec<f32> = self.frames.iter().filter(|f| f.prob < 0.2 && f.db > -100.0).map(|f| f.db).collect();
        let noise_db = (silent.len() >= frames_in(2.0)).then(|| {
            let mut s = silent.clone();
            s.sort_by(|a, b| a.total_cmp(b));
            s[s.len() / 5]
        });
        // Clear sound = well above the room's floor (or above −60 dBFS when the pauses are digital silence); the
        // speech = that plus what the VAD calls speech (in a noisy room the voice is not 10 dB above the floor).
        let gate = noise_db.map_or(-60.0, |n| n + 10.0);
        let clear: Vec<Frame> = self.frames.iter().copied().filter(|f| f.db > gate).collect();
        let sound: Vec<Frame> = self.frames.iter().copied().filter(|f| f.db > gate || f.prob >= 0.5).collect();
        if sound.len() < frames_in(MIN_SOUND_S) {
            return None;
        }
        let speech_db = median(sound.iter().map(|f| f.db).collect());
        // What the room does while nobody talks: the pause median (digital silence excluded, it has no level)
        // and how much of the pauses is digital.
        let floor = (silent.len() >= frames_in(2.0)).then(|| {
            let mut levels = silent.clone();
            levels.sort_by(|a, b| a.total_cmp(b));
            let digital = self.frames.iter().filter(|f| f.prob < 0.2 && f.db <= -100.0).count();
            let pause_frames = self.frames.iter().filter(|f| f.prob < 0.2).count().max(1);
            Floor::of(levels[levels.len() / 2], digital as f32 / pause_frames as f32)
        });
        // How sure the VAD is where the sound is clear: unsure there = far away or echoing.
        let vad_confidence = (clear.len() >= frames_in(4.0)).then(|| median(clear.iter().map(|f| f.prob).collect()));
        let clipped_share = sound.iter().map(|f| f.clipped as f32).sum::<f32>() / (sound.len() * FRAME_SAMPLES) as f32;
        let hum = (self.pauses.len() >= (2.0 * SAMPLE_RATE as f32) as usize).then(|| {
            // The pauses are pieces cut out between words: the hum's phase jumps from one to the next, so each block
            // of HUM_BLOCK frames is measured on its own and the powers are added (not one coherent sum).
            let x: Vec<f32> = self.pauses.iter().copied().collect();
            let blocks: Vec<&[f32]> = x.chunks_exact(HUM_BLOCK * FRAME_SAMPLES).collect();
            let n = (HUM_BLOCK * FRAME_SAMPLES) as f32;
            let total = |freq: f32| blocks.iter().map(|b| power(b, freq)).sum::<f32>() / blocks.len() as f32;
            [50.0f32, 60.0]
                .iter()
                .map(|&base| {
                    let peak: f32 = (1..=3).map(|k| total(base * k as f32)).sum();
                    let side: f32 = (1..=3).map(|k| [6.0, 8.0, 10.0, 12.0, 14.0].iter().map(|d| total(base * k as f32 + d)).sum::<f32>() / 5.0).sum();
                    // Goertzel power of a sine of amplitude a over n samples ≈ (a n / 2)², so its rms (a / √2) is √(2 P) / n.
                    let rms = (2.0 * peak).sqrt() / n;
                    (10.0 * (peak / side.max(1e-18)).log10(), 20.0 * rms.max(1e-9).log10() - speech_db)
                })
                .max_by(|a, b| a.0.total_cmp(&b.0))
                .expect("two bases")
        });
        let mut issues = Vec::new();
        if clipped_share > CLIPPED_SHARE {
            issues.push(MicIssue::Clipping);
        }
        // Far/echo needs a long stretch of unsure speech, not studio pauses after VadLevel
        // (presentation/ pt pauses: ~27 % in 0.15..0.85 ≈ 8 s / 30 s; a real room mic is ~38 %).
        let unsure_speech = self
            .frames
            .iter()
            .filter(|f| f.prob >= 0.15 && f.prob < NOISY_VOICED_PROB)
            .count()
            >= frames_in(10.0);
        if unsure_speech && speech_db >= FAR_MIN_SPEECH_DB && vad_confidence.is_some_and(|c| c < UNSURE_VAD) {
            issues.push(MicIssue::FarOrEcho);
        }
        if speech_db < QUIET_DB {
            issues.push(MicIssue::TooQuiet);
        }
        let humming = hum.is_some_and(|(peak, level)| peak > HUM_PEAK_DB && level > HUM_AUDIBLE_DB);
        // SNR from frames the VAD is sure are speech — not ambient the level boosts into mid probabilities.
        // Same 8 s bar as MIN_SOUND_S: a loud AC floor (~11 % ≥ 0.85 → ~3 s / 30 s) stays under it.
        let voiced: Vec<f32> = self.frames.iter().filter(|f| f.prob >= NOISY_VOICED_PROB).map(|f| f.db).collect();
        let voiced_db = (voiced.len() >= frames_in(MIN_SOUND_S)).then(|| median(voiced));
        // A hum raises the floor too; then it is the hum, not a noisy room (the advice differs, and the hum was
        // transcribed through: WER 7.2 % vs 6.8 % clean).
        if !humming
            && voiced_db.zip(noise_db).is_some_and(|(s, n)| s >= NOISY_MIN_SPEECH_DB && s - n < NOISY_SNR_DB)
        {
            issues.push(MicIssue::Noisy);
        }
        if humming {
            issues.push(MicIssue::Hum);
        }
        Some(MicReport { speech_db, noise_db, vad_confidence, clipped_share, hum, issues, floor })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Noise(u32);
    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((self.0 >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 3.46
        }
    }

    /// 30 s alternating 2 s of "speech" (noise at `speech_db`, probability `prob`) and 1 s of pause (noise at
    /// `pause_db`, probability 0.05), each sample through `extra`.
    fn session(speech_db: f32, pause_db: f32, prob: f32, extra: impl Fn(usize, f32, bool) -> f32) -> Option<MicReport> {
        let mut check = MicCheck::new();
        let mut noise = Noise(9);
        let per_s = SAMPLE_RATE as usize / FRAME_SAMPLES;
        let mut t = 0usize;
        for i in 0..(30 * per_s) {
            let speaking = i % (3 * per_s) < 2 * per_s;
            let amp = 10f32.powf(if speaking { speech_db } else { pause_db } / 20.0);
            let frame: Vec<f32> = (0..FRAME_SAMPLES)
                .map(|_| {
                    t += 1;
                    extra(t, noise.next() * amp, speaking).clamp(-1.0, 1.0)
                })
                .collect();
            check.push(&frame, if speaking { prob } else { 0.05 });
        }
        check.report()
    }

    #[test]
    fn a_good_microphone_has_nothing_to_change() {
        let r = session(-28.0, -65.0, 0.95, |_, s, _| s).expect("report");
        assert!(r.issues.is_empty(), "{r:?}");
        assert!((r.speech_db + 28.0).abs() < 1.5 && r.snr_db().unwrap() > 30.0, "{r:?}");
    }

    #[test]
    fn nothing_is_said_before_eight_seconds_of_sound() {
        let mut check = MicCheck::new();
        for _ in 0..(5 * 31) {
            check.push(&[0.05; FRAME_SAMPLES], 0.9);
        }
        assert!(check.report().is_none());
    }

    #[test]
    fn each_problem_is_named() {
        let quiet = session(-56.0, -90.0, 0.95, |_, s, _| s).unwrap();
        assert_eq!(quiet.issues, vec![MicIssue::TooQuiet]);
        let far = session(-28.0, -65.0, 0.35, |_, s, _| s).unwrap();
        assert_eq!(far.issues, vec![MicIssue::FarOrEcho]);
        let noisy = session(-28.0, -34.0, 0.95, |_, s, _| s).unwrap();
        assert_eq!(noisy.issues, vec![MicIssue::Noisy]);
        let clipped = session(-28.0, -65.0, 0.95, |t, s, speaking| if speaking && t % 50 == 0 { 1.0 } else { s }).unwrap();
        assert_eq!(clipped.issues, vec![MicIssue::Clipping]);
    }

    #[test]
    fn audible_hum_is_named_and_a_faint_one_is_not() {
        let hum = |amp_db: f32| {
            let amp = 10f32.powf(amp_db / 20.0);
            move |t: usize, s: f32, _| s + amp * (2.0 * std::f32::consts::PI * 50.0 * t as f32 / SAMPLE_RATE as f32).sin()
        };
        let loud = session(-28.0, -70.0, 0.95, hum(-40.0)).unwrap();
        assert!(loud.issues.contains(&MicIssue::Hum), "{loud:?}");
        let faint = session(-28.0, -70.0, 0.95, hum(-75.0)).unwrap();
        assert!(!faint.issues.contains(&MicIssue::Hum), "{faint:?}");
    }

    #[test]
    fn ambient_noise_alone_is_not_a_noisy_room() {
        // Room noise only, VAD silent: louder bursts above the floor used to count as "speech" within
        // 10 dB of it → false Noisy. (Also must not require a report — FarOrEcho may still fire.)
        let mut check = MicCheck::new();
        let mut noise = Noise(9);
        let per_s = SAMPLE_RATE as usize / FRAME_SAMPLES;
        let mut t = 0usize;
        for i in 0..(30 * per_s) {
            let loud = i % 4 < 2;
            let amp = 10f32.powf(if loud { -28.0 } else { -35.0 } / 20.0);
            let frame: Vec<f32> = (0..FRAME_SAMPLES)
                .map(|_| {
                    t += 1;
                    (noise.next() * amp).clamp(-1.0, 1.0)
                })
                .collect();
            check.push(&frame, 0.05);
        }
        if let Some(r) = check.report() {
            assert!(
                !r.issues.contains(&MicIssue::Noisy) && !r.issues.contains(&MicIssue::FarOrEcho),
                "{r:?}"
            );
        }
    }

    #[test]
    fn silence_with_a_high_floor_is_not_a_noisy_room() {
        // Steady floor, no one talking: bursts above the floor (or a VAD that fires on the same level)
        // used to make speech_db ≈ noise_db → Noisy while the room was just quiet.
        let mut check = MicCheck::new();
        let mut noise = Noise(3);
        let per_s = SAMPLE_RATE as usize / FRAME_SAMPLES;
        let mut t = 0usize;
        for i in 0..(30 * per_s) {
            // Mostly −42 dBFS "silence"; every 4th frame a bit louder (−33) so the gate sees "sound".
            let amp = 10f32.powf(if i % 4 == 0 { -33.0 } else { -42.0 } / 20.0);
            let frame: Vec<f32> = (0..FRAME_SAMPLES)
                .map(|_| {
                    t += 1;
                    (noise.next() * amp).clamp(-1.0, 1.0)
                })
                .collect();
            check.push(&frame, 0.05);
        }
        if let Some(r) = check.report() {
            assert!(
                !r.issues.contains(&MicIssue::Noisy) && !r.issues.contains(&MicIssue::FarOrEcho),
                "{r:?}"
            );
        }
    }

    #[test]
    fn mid_vad_on_the_room_floor_is_not_a_noisy_room() {
        // Like the HVAC pauses in `room/` after VadLevel: ~20 % of frames at prob 0.5–0.8 on the floor,
        // almost none ≥ 0.9. Used to warn Noisy while the person was silent.
        let mut check = MicCheck::new();
        let mut noise = Noise(7);
        let per_s = SAMPLE_RATE as usize / FRAME_SAMPLES;
        let mut t = 0usize;
        for i in 0..(30 * per_s) {
            let amp = 10f32.powf(-40.0 / 20.0);
            let frame: Vec<f32> = (0..FRAME_SAMPLES)
                .map(|_| {
                    t += 1;
                    (noise.next() * amp).clamp(-1.0, 1.0)
                })
                .collect();
            // 22 % mid VAD (ambient after level), ~6 % ≥ 0.9 — mirrors room HVAC floor histogram.
            let prob = match i % 50 {
                0..=2 => 0.92,  // 6 %
                3..=13 => 0.65, // 22 %
                _ => 0.05,
            };
            check.push(&frame, prob);
        }
        if let Some(r) = check.report() {
            assert!(!r.issues.contains(&MicIssue::Noisy), "{r:?}");
        }
    }

    #[test]
    fn studio_pauses_with_confident_vad_fakes_are_not_far_or_echo() {
        // presentation/ pauses after VadLevel: clear bursts + confident VAD fakes used to warn
        // FarOrEcho (median confidence on clear frames just under 0.95) while nobody was talking.
        let mut check = MicCheck::new();
        let mut noise = Noise(11);
        let per_s = SAMPLE_RATE as usize / FRAME_SAMPLES;
        let mut t = 0usize;
        for i in 0..(30 * per_s) {
            let amp = 10f32.powf(if i % 5 == 0 { -40.0 } else { -55.0 } / 20.0);
            let frame: Vec<f32> = (0..FRAME_SAMPLES)
                .map(|_| {
                    t += 1;
                    (noise.next() * amp).clamp(-1.0, 1.0)
                })
                .collect();
            // Under 8 s of mid (unsure) and under 8 s of ≥ 0.85 — like the measured pause histogram.
            let prob = match i % 50 {
                0..=9 => 0.92,   // 20 %
                10..=17 => 0.55, // 16 %
                _ => 0.05,
            };
            check.push(&frame, prob);
        }
        if let Some(r) = check.report() {
            assert!(
                !r.issues.contains(&MicIssue::FarOrEcho) && !r.issues.contains(&MicIssue::Noisy),
                "{r:?}"
            );
        }
    }

    #[test]
    fn the_floor_is_named_from_the_pauses() {
        // The five pauses the benchmark sets have (docs/medicoes.md § piso, 2026-10-26).
        assert_eq!(Floor::of(-95.0, 0.6), Floor::DigitalSilence, "zeros");
        assert_eq!(Floor::of(-120.0, 0.0), Floor::DigitalSilence, "all digital");
        assert_eq!(Floor::of(-60.0, 0.17), Floor::MeetingFloor, "AMI headset");
        assert_eq!(Floor::of(-58.0, 0.0), Floor::StudioQuiet, "clean talk");
        assert_eq!(Floor::of(-43.0, 0.0), Floor::RoomAmbient, "HVAC");
        assert_eq!(Floor::of(-38.0, 0.0), Floor::LoudFloor, "5 dB noise");
        assert!(!Floor::LoudFloor.is_quiet() && Floor::RoomAmbient.is_quiet());
    }

    #[test]
    fn a_table_microphone_with_only_room_tone_is_not_a_noisy_room() {
        // AMI's table mic after VadLevel: sure VAD (≥ 0.85) on the floor at −58 dBFS, SNR ~6 dB.
        // Used to warn Noisy while nobody was speaking — quieter than speech is TooQuiet's business.
        let mut check = MicCheck::new();
        let mut noise = Noise(13);
        let per_s = SAMPLE_RATE as usize / FRAME_SAMPLES;
        let mut t = 0usize;
        for i in 0..(30 * per_s) {
            // Digital gaps (as AMI has) mixed with a very quiet floor.
            let digital = i % 7 == 0;
            let amp = 10f32.powf(-58.0 / 20.0);
            let frame: Vec<f32> = (0..FRAME_SAMPLES)
                .map(|_| {
                    t += 1;
                    if digital { 0.0 } else { (noise.next() * amp).clamp(-1.0, 1.0) }
                })
                .collect();
            check.push(&frame, if i % 3 == 0 { 0.95 } else { 0.05 });
        }
        if let Some(r) = check.report() {
            assert!(!r.issues.contains(&MicIssue::Noisy), "{r:?}");
            assert!(r.floor.is_some(), "the floor is still reported: {r:?}");
        }
    }
}
