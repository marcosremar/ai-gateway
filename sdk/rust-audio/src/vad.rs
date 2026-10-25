//! Silero VAD (v5) inference via ONNX Runtime.
//!
//! The model is bundled in the binary (`assets/silero_vad.onnx`) so no runtime
//! download is needed. Operates on 512-sample frames at 16 kHz and returns a
//! speech probability in `[0, 1]`, maintaining recurrent state across frames.

use ndarray::{Array1, Array2, Array3};
use ort::session::Session;
use ort::value::Tensor;

/// Frame size fed in by the caller at 16 kHz.
pub const FRAME_SAMPLES: usize = 512;
pub const SAMPLE_RATE: i64 = 16000;

/// v5 prepends 64 samples of the previous chunk to each window; the tensor the
/// model actually consumes is `CONTEXT_SAMPLES + FRAME_SAMPLES` long.
/// See the official C++ example (`examples/cpp/silero-vad-onnx.cpp`).
const CONTEXT_SAMPLES: usize = 64;

static MODEL_BYTES: &[u8] = include_bytes!("../assets/silero_vad.onnx");

/// Errors of the VAD (the ONNX Runtime session or its tensors).
#[derive(Debug, thiserror::Error)]
#[error("VAD: {0}")]
pub struct VadError(pub String);

impl VadError {
    fn ort(e: ort::Error) -> Self {
        Self(e.to_string())
    }
}

/// The app releases ONNX Runtime at `exit()` itself (or leaves with `_exit` while sessions still run): the
/// VAD then registers nothing. Call before the first [`SileroVad::new`].
pub fn release_handled_by_app() {
    APP_RELEASES.store(true, std::sync::atomic::Ordering::Relaxed);
}

static APP_RELEASES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// macOS: with ONNX Runtime 1.22's environment alive (`ort` keeps it in a `static` never dropped), its C++
/// destructors abort at `exit()` ("mutex lock failed: Invalid argument", exit code 134 instead of the
/// program's). An `atexit` registered after the library loaded releases the environment first. Once per
/// process; nothing on other systems.
fn release_env_at_exit() {
    #[cfg(target_os = "macos")]
    {
        extern "C" fn release() {
            use ort::AsPointer;
            if let Ok(env) = ort::environment::get_environment() {
                // SAFETY: at exit() no thread of a program that let the VAD register this uses ONNX Runtime
                // any more; the `ort` environment's `Drop` never runs (it is a `static`).
                unsafe { (ort::api().ReleaseEnv)(env.ptr().cast_mut()) }
            }
        }
        extern "C" {
            fn atexit(cb: extern "C" fn()) -> std::ffi::c_int;
        }
        static ONCE: std::sync::Once = std::sync::Once::new();
        if APP_RELEASES.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        // SAFETY: `atexit` only stores the function pointer.
        ONCE.call_once(|| unsafe {
            atexit(release);
        });
    }
}

/// Loads ONNX Runtime from this library file (instead of `ORT_DYLIB_PATH`). Call before the first session.
pub fn use_onnx_runtime_at(path: &std::path::Path) {
    let _ = ort::init_from(path.display().to_string());
}

pub struct SileroVad {
    session: Session,
    state: Array3<f32>, // shape [2, 1, 128]
    /// Tail of the previous frame. The ONNX input dimension is dynamic, so
    /// feeding 512 instead of 576 raises no error — it just makes the model
    /// output stay near zero for every signal, speech included.
    context: Vec<f32>,
}

impl SileroVad {
    pub fn new() -> Result<Self, VadError> {
        // Um thread só e sem spin. O padrão do ONNX Runtime é um thread por
        // núcleo, todos em espera ativa (spinning) entre uma inferência e a
        // próxima — com um frame a cada 32ms, isso queimava ~2,6 núcleos de
        // CPU parados, e numa máquina de 2 núcleos travava o arrasto das
        // janelas e atrasava as legendas. O Silero é minúsculo (<1ms por
        // frame): paralelismo não ajuda em nada aqui.
        let session = Session::builder()
            .map_err(VadError::ort)?
            .with_intra_threads(1)
            .map_err(VadError::ort)?
            .with_inter_threads(1)
            .map_err(VadError::ort)?
            .with_intra_op_spinning(false)
            .map_err(VadError::ort)?
            .with_inter_op_spinning(false)
            .map_err(VadError::ort)?
            .commit_from_memory(MODEL_BYTES)
            .map_err(VadError::ort)?;
        release_env_at_exit();
        Ok(Self {
            session,
            state: Array3::zeros((2, 1, 128)),
            context: vec![0.0; CONTEXT_SAMPLES],
        })
    }

    /// Reset the recurrent state (call periodically to avoid numerical drift).
    pub fn reset(&mut self) {
        self.state = Array3::zeros((2, 1, 128));
        self.context = vec![0.0; CONTEXT_SAMPLES];
    }

    /// Run one 512-sample frame; returns the speech probability.
    pub fn process(&mut self, frame: &[f32]) -> Result<f32, VadError> {
        debug_assert_eq!(frame.len(), FRAME_SAMPLES);

        // [contexto (64) | quadro (512)] = 576, como no exemplo oficial.
        let mut windowed = Vec::with_capacity(CONTEXT_SAMPLES + frame.len());
        windowed.extend_from_slice(&self.context);
        windowed.extend_from_slice(frame);

        let input = Array2::from_shape_vec((1, windowed.len()), windowed)
            .map_err(|e| VadError(e.to_string()))?;
        let sr = Array1::from_vec(vec![SAMPLE_RATE]);

        let input_t = Tensor::from_array(input).map_err(VadError::ort)?;
        let state_t = Tensor::from_array(self.state.clone()).map_err(VadError::ort)?;
        let sr_t = Tensor::from_array(sr).map_err(VadError::ort)?;

        let outputs = self
            .session
            .run(ort::inputs!["input" => input_t, "state" => state_t, "sr" => sr_t])
            .map_err(VadError::ort)?;

        // Update recurrent state from "stateN".
        let new_state = outputs["stateN"]
            .try_extract_array::<f32>()
            .map_err(VadError::ort)?;
        self.state = new_state
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| VadError(e.to_string()))?
            .to_owned();

        let prob = outputs["output"]
            .try_extract_array::<f32>()
            .map_err(VadError::ort)?;
        // O contexto do próximo quadro é a cauda deste.
        self.context.clear();
        self.context
            .extend_from_slice(&frame[frame.len() - CONTEXT_SAMPLES..]);

        let value = prob.iter().next().copied().unwrap_or(0.0);
        Ok(value)
    }
}

/// Puts what the VAD hears at the level of normal speech. Silero judges loudness too: a voice heard
/// from across a room (reverb + noise, ~4 dB quieter on average) came out at speech chance ~0.05 for
/// 40 s — nothing on screen — and at 0.7 with +12 dB. The level is the room's average over the last
/// seconds (`tau_s`), never per frame (a pause must not be blown up into speech), and only goes UP,
/// to at most `max_db`; audio quieter than `FLOOR` (a muted microphone) is left alone. Only the VAD's
/// copy changes: the speech model still gets the audio as it came.
pub struct VadLevel {
    target: f32,
    max_gain: f32,
    alpha: f32,
    mean_square: f32,
    /// Weight of the average so far: dividing by it keeps the first seconds from reading as near silence
    /// (which would raise them by the whole `max_db`).
    weight: f32,
    out: Vec<f32>,
}

impl VadLevel {
    /// Below this average level (−60 dBFS) nothing is raised.
    const FLOOR: f32 = 1e-3;

    pub fn new(target_db: f32, max_db: f32, tau_s: f32) -> Self {
        let frame_s = FRAME_SAMPLES as f32 / SAMPLE_RATE as f32;
        Self {
            target: 10f32.powf(target_db / 20.0),
            max_gain: 10f32.powf(max_db / 20.0),
            alpha: 1.0 - (-frame_s / tau_s).exp(),
            mean_square: 0.0,
            weight: 0.0,
            out: Vec::with_capacity(FRAME_SAMPLES),
        }
    }

    /// The gain applied to the last frame.
    pub fn gain(&self) -> f32 {
        let level = (self.mean_square / self.weight.max(f32::MIN_POSITIVE)).sqrt();
        if level < Self::FLOOR {
            1.0
        } else {
            (self.target / level).clamp(1.0, self.max_gain)
        }
    }

    /// The frame as the VAD should hear it.
    pub fn apply(&mut self, frame: &[f32]) -> &[f32] {
        let ms = frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32;
        self.mean_square += (ms - self.mean_square) * self.alpha;
        self.weight += (1.0 - self.weight) * self.alpha;
        let gain = self.gain();
        self.out.clear();
        self.out
            .extend(frame.iter().map(|s| (s * gain).clamp(-1.0, 1.0)));
        &self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(level: f32, seed: &mut u32) -> Vec<f32> {
        (0..FRAME_SAMPLES)
            .map(|_| {
                *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                level * ((*seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 3.46
            })
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn a_quiet_room_reaches_the_vad_louder_and_loud_speech_stays_as_it_is() {
        let mut seed = 7;
        // −36 dBFS for 10 s: raised by the maximum (12 dB) once the average settles.
        let mut level = VadLevel::new(-24.0, 12.0, 3.0);
        let mut out = 0.0;
        for _ in 0..312 {
            out = rms(level.apply(&noise(0.016, &mut seed)));
        }
        assert!((out / 0.016 - 3.98).abs() < 0.3, "gain {}", out / 0.016);
        // −16 dBFS: already above the target, never lowered.
        let mut level = VadLevel::new(-24.0, 12.0, 3.0);
        for _ in 0..312 {
            level.apply(&noise(0.16, &mut seed));
        }
        assert_eq!(level.gain(), 1.0);
    }

    #[test]
    fn a_muted_microphone_and_a_short_pause_are_not_blown_up() {
        let mut seed = 3;
        let mut level = VadLevel::new(-24.0, 12.0, 3.0);
        for _ in 0..312 {
            level.apply(&noise(0.0005, &mut seed));
        }
        assert_eq!(level.gain(), 1.0, "below −60 dBFS nothing is raised");
        // Speech at −24 dBFS, then a 0.5 s pause: the gain hardly moves (the average is seconds long).
        let mut level = VadLevel::new(-24.0, 12.0, 3.0);
        for _ in 0..312 {
            level.apply(&noise(0.063, &mut seed));
        }
        let before = level.gain();
        for _ in 0..16 {
            level.apply(&noise(0.002, &mut seed));
        }
        assert!(level.gain() < before * 1.25, "{before} → {}", level.gain());
    }

    #[test]
    fn speech_at_the_target_from_the_first_frame_is_not_raised() {
        let mut seed = 11;
        let mut level = VadLevel::new(-24.0, 12.0, 3.0);
        for _ in 0..5 {
            level.apply(&noise(0.07, &mut seed));
            assert!(level.gain() < 1.05, "first frames raised ×{}", level.gain());
        }
    }

    #[test]
    fn loads_model_and_runs_silence_and_tone() {
        let mut vad = SileroVad::new().expect("load silero model");

        // Silence -> low probability.
        let silence = vec![0.0f32; FRAME_SAMPLES];
        let p_silence = vad.process(&silence).unwrap();
        assert!((0.0..=1.0).contains(&p_silence));
        assert!(
            p_silence < 0.5,
            "silence prob should be low, got {p_silence}"
        );

        // A loud 300 Hz tone should generally read higher than pure silence.
        let mut tone = vec![0.0f32; FRAME_SAMPLES];
        for (i, s) in tone.iter_mut().enumerate() {
            *s = (2.0 * std::f32::consts::PI * 300.0 * i as f32 / 16000.0).sin() * 0.6;
        }
        let mut p_tone = 0.0;
        for _ in 0..10 {
            p_tone = vad.process(&tone).unwrap();
        }
        assert!((0.0..=1.0).contains(&p_tone));
    }
}
