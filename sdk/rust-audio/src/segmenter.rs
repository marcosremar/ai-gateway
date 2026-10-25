//! Speech segmentation from per-frame VAD probabilities.
//!
//! Ports the research-backed techniques from `app/services/audio_capture.py` /
//! README §"Audio Pipeline": EMA probability smoothing, dual-threshold
//! hysteresis, pre/post-speech padding, min/max speech duration, and a
//! smart cut at the quietest point when the max duration is reached.

use crate::vad::{FRAME_SAMPLES, SAMPLE_RATE};

const SR: usize = SAMPLE_RATE as usize;

/// Tunable segmentation parameters (defaults match the Python pipeline).
#[derive(Debug, Clone)]
pub struct SegmenterConfig {
    pub onset_threshold: f32,
    pub offset_threshold: f32,
    pub smoothing_alpha: f32,
    pub pre_speech_pad_ms: usize,
    pub post_speech_pad_ms: usize,
    pub min_speech_ms: usize,
    pub max_speech_ms: usize,
    pub silence_hangover_ms: usize,
    pub smart_cut_search_ms: usize,
    /// Passado o `max_speech_ms`, quanto a fala ainda pode crescer esperando
    /// uma pausa (vírgula, respiração) antes do corte forçado. Sem isso o
    /// corte aos 3 s caía antes da última palavra da frase, que ia sozinha
    /// para o STT e saía inventada (visto: "preocupação" → "Pau worries about
    /// it in Libra") e a linha original ficava sem ela.
    pub end_grace_ms: usize,
    /// Espiada (`take_peek`): a fala parou ao menos isto e voltou SEM fechar
    /// o trecho (pausa mais curta que o `silence_hangover_ms`, antes do
    /// `max_speech_ms`) — o que foi dito até ali sai como rascunho, sem cortar
    /// nada. 0 = desligado (padrão; a frase que cresce do `bc-pipeline` liga).
    pub peek_pause_ms: usize,
    pub peek_every_ms: usize,
}

/// Fala nova mínima (desde o começo do trecho ou da espiada anterior) para
/// uma espiada valer o pedido ao STT.
const PEEK_MIN_NEW_MS: usize = 1000;

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            onset_threshold: 0.45,
            offset_threshold: 0.20,
            smoothing_alpha: 0.35,
            pre_speech_pad_ms: 200,
            post_speech_pad_ms: 150,
            min_speech_ms: 400,
            max_speech_ms: 3000,
            silence_hangover_ms: 300,
            smart_cut_search_ms: 1500,
            end_grace_ms: 1500,
            peek_pause_ms: 0,
            peek_every_ms: 0,
        }
    }
}

fn ms_to_samples(ms: usize) -> usize {
    ms * SR / 1000
}

/// Stateful VAD segmenter. Feed 512-sample frames + their VAD probability;
/// receive completed speech segments (mono f32 @ 16 kHz).
pub struct Segmenter {
    cfg: SegmenterConfig,
    smoothed: f32,
    in_speech: bool,
    speech: Vec<f32>,
    pre_pad: Vec<f32>, // ring of recent pre-speech audio
    pre_pad_cap: usize,
    silence_run: usize, // samples of trailing sub-offset audio
    /// Houve voz desde o início/último corte? Um corte numa pausa que vira
    /// fim de fala deixa só silêncio para trás — esse resto não é segmento.
    voiced: bool,
    /// O último segmento foi cortado ANTES do fim da fala (pausa curta ou
    /// corte forçado por tamanho) — a frase pode continuar no próximo.
    forced: bool,
    /// Depois de um corte antes do fim da fala, a fala acabou sem mais voz
    /// (o corte foi no fim da frase): ver `take_tail_closed`.
    tail_closed: bool,
    last_rms: f32,
    /// Nota de "fim de frase" do último corte numa pausa (0..1).
    end_score: f32,
    /// Houve um corte (em aberto ou não) antes deste segmento: um resto
    /// curto depois dele é a última palavra, não ruído.
    after_any_cut: bool,
    /// Espiada pronta (ver `peek_pause_ms`) e até onde (amostras de voz do
    /// trecho em curso) a última foi.
    /// `true`: espiada pelo relógio (`peek_every_ms`), não numa pausa.
    peek: Option<(Vec<f32>, bool)>,
    peeked_voice: usize,
    /// A espiada sai já na pausa (padrão); `UCAST_PEEK_EARLY=0` volta a soltá-la
    /// só quando a fala recomeça (comparação A/B).
    peek_early: bool,
}

/// A partir desta nota um corte numa pausa conta como fim de frase.
const SENTENCE_END_SCORE: f32 = 0.7;

/// A voz antes de uma pausa soa como fim de frase? Mede nos últimos ~600 ms
/// de voz: o F0 (altura) caindo — o fim de uma afirmação — e a energia
/// caindo. F0 subindo é continuação ("e aí…", vírgula) ou pergunta. Só a
/// pausa (≥ 100 ms) vale 0,5; F0 caindo +0,3 (subindo −0,3); energia caindo
/// +0,2. Sem voz medível, fica no 0,5 (não segura a mais do que antes).
pub fn sentence_end_score(voiced: &[f32]) -> f32 {
    let win = ms_to_samples(600).min(voiced.len());
    let tail = &voiced[voiced.len() - win..];
    let frames: Vec<&[f32]> = tail.chunks_exact(FRAME_SAMPLES).collect();
    if frames.len() < 6 {
        return 0.5;
    }
    let split = frames.len() * 2 / 3;
    let db = |f: &[f32]| 20.0 * ((f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt()).max(1e-6).log10();
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
    let (head, end) = frames.split_at(split);
    let energy_drop = mean(&head.iter().map(|f| db(f)).collect::<Vec<_>>()) - mean(&end.iter().map(|f| db(f)).collect::<Vec<_>>());
    let semis = |fs: &[&[f32]]| {
        let mut v: Vec<f32> = fs.iter().filter_map(|f| f0(f)).map(|hz| 12.0 * (hz / 100.0).log2()).collect();
        v.sort_by(f32::total_cmp);
        v.get(v.len() / 2).copied()
    };
    let mut score = 0.5;
    if let (Some(a), Some(b)) = (semis(head), semis(end)) {
        if b < a - 1.0 {
            score += 0.3;
        } else if b > a + 1.0 {
            score -= 0.3;
        }
    }
    if energy_drop >= 3.0 {
        score += 0.2;
    }
    score
}

/// F0 por autocorrelação normalizada, 70–400 Hz (a mesma ideia de
/// `bc_pipeline::prosody`); `None` em quadro sem voz periódica.
fn f0(frame: &[f32]) -> Option<f32> {
    let energy: f32 = frame.iter().map(|s| s * s).sum();
    if energy < 1e-4 {
        return None;
    }
    let (min_lag, max_lag) = (SR / 400, (SR / 70).min(frame.len() - 1));
    let mut best = (0usize, 0f32);
    for lag in min_lag..=max_lag {
        let (mut num, mut e1, mut e2) = (0f32, 0f32, 0f32);
        for i in 0..frame.len() - lag {
            num += frame[i] * frame[i + lag];
            e1 += frame[i] * frame[i];
            e2 += frame[i + lag] * frame[i + lag];
        }
        let r = num / (e1 * e2).sqrt().max(1e-9);
        if r > best.1 {
            best = (lag, r);
        }
    }
    (best.1 > 0.5).then(|| SR as f32 / best.0 as f32)
}

impl Segmenter {
    pub fn new(cfg: SegmenterConfig) -> Self {
        let pre_pad_cap = ms_to_samples(cfg.pre_speech_pad_ms);
        Self {
            cfg,
            smoothed: 0.0,
            in_speech: false,
            speech: Vec::new(),
            pre_pad: Vec::with_capacity(pre_pad_cap + FRAME_SAMPLES),
            pre_pad_cap,
            silence_run: 0,
            voiced: false,
            forced: false,
            tail_closed: false,
            last_rms: 0.0,
            end_score: 0.0,
            after_any_cut: false,
            peek: None,
            peeked_voice: 0,
            peek_early: std::env::var("UCAST_PEEK_EARLY").map_or(true, |v| v.trim() != "0"),
        }
    }

    /// O que foi dito no trecho em curso até a última pausa curta depois da
    /// qual a fala continuou (ver `SegmenterConfig::peek_pause_ms`). Não corta
    /// nada: o trecho que sair depois traz este áudio também. Lê e zera.
    pub fn take_peek(&mut self) -> Option<(Vec<f32>, bool)> {
        self.peek.take()
    }

    /// O segmento que acabou de sair foi cortado antes do fim da fala (por
    /// tamanho, numa pausa curta ou no ponto mais baixo): o resto da frase
    /// pode vir no próximo. O pipeline usa para juntar o fim curto da frase
    /// a ele em vez de mandar a última palavra sozinha (visto: corte na
    /// pausa antes de "preocupação").
    /// O último segmento foi cortado no meio da fala (pausa curta ou corte
    /// por tamanho), qualquer que seja a prosódia — `false` = a fala acabou
    /// de verdade (silêncio de `silence_hangover_ms`). A frase que cresce
    /// (`bc_pipeline`) só fecha a frase quando isto é `false`.
    pub fn last_cut_mid_speech(&self) -> bool {
        self.after_any_cut
    }

    pub fn last_cut_forced(&self) -> bool {
        self.forced
    }

    pub fn in_speech(&self) -> bool {
        self.in_speech
    }

    /// A fala que um corte deixou "em aberto" (`last_cut_forced`) acabou sem
    /// mais voz — o corte era o fim da frase. O pipeline libera na hora o
    /// trecho que segurava esperando o resto (sem isto cada frase de mais de
    /// 3 s esperava 3 s a mais). Lê e zera.
    pub fn take_tail_closed(&mut self) -> bool {
        std::mem::take(&mut self.tail_closed)
    }

    /// Most recent frame RMS (for VU metering), in [0, 1]-ish.
    pub fn last_rms(&self) -> f32 {
        self.last_rms
    }

    /// Feed one frame; returns a completed segment if one was emitted.
    pub fn push_frame(&mut self, frame: &[f32], prob: f32) -> Option<Vec<f32>> {
        if frame.is_empty() {
            return None;
        }
        let prob = if prob.is_finite() { prob.clamp(0.0, 1.0) } else { 0.0 };
        // EMA smoothing of the raw probability.
        self.smoothed =
            self.cfg.smoothing_alpha * self.smoothed + (1.0 - self.cfg.smoothing_alpha) * prob;

        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        self.last_rms = rms;

        if !self.in_speech {
            // Maintain the pre-speech padding ring.
            self.pre_pad.extend_from_slice(frame);
            if self.pre_pad.len() > self.pre_pad_cap {
                let excess = self.pre_pad.len() - self.pre_pad_cap;
                self.pre_pad.drain(0..excess);
            }
            if self.smoothed >= self.cfg.onset_threshold {
                // Start of speech — seed with the padding buffer, which already
                // ends with this frame (added just above). Adding the frame
                // again repeated 32 ms right where the first word starts.
                self.in_speech = true;
                self.speech.clear();
                self.speech.extend_from_slice(&self.pre_pad);
                self.silence_run = 0;
                self.voiced = true;
            }
            return None;
        }

        // In speech: accumulate.
        self.speech.extend_from_slice(frame);
        if self.smoothed < self.cfg.offset_threshold {
            let before_silence = self.silence_run;
            self.silence_run += frame.len();
            // A espiada sai já na pausa (não quando a fala volta): se a pausa
            // for o fim da frase, a transcrição dela começou ~170 ms antes do
            // fim do silêncio, e a versão final a reaproveita — o áudio a mais
            // é só silêncio (2026-10-19). Se a fala voltar, é a mesma espiada
            // de antes, só mais cedo.
            let pause = ms_to_samples(self.cfg.peek_pause_ms);
            if self.peek_early && self.cfg.peek_pause_ms > 0 && before_silence < pause && self.silence_run >= pause {
                let voice = self.speech.len() - self.silence_run;
                if self.speech.len() < ms_to_samples(self.cfg.max_speech_ms) && voice >= self.peeked_voice + ms_to_samples(PEEK_MIN_NEW_MS) {
                    self.peeked_voice = voice;
                    self.peek = Some((self.speech.clone(), false));
                }
            }
        } else {
            // A fala voltou depois de uma pausa curta que não fechou o trecho.
            if self.cfg.peek_pause_ms > 0 && self.silence_run >= ms_to_samples(self.cfg.peek_pause_ms) {
                let before = self.speech.len() - frame.len();
                let voice = before - self.silence_run;
                if before < ms_to_samples(self.cfg.max_speech_ms)
                    && voice >= self.peeked_voice + ms_to_samples(PEEK_MIN_NEW_MS)
                {
                    self.peeked_voice = voice;
                    self.peek = Some((self.speech[..before].to_vec(), false));
                }
            }
            self.silence_run = 0;
            self.voiced = true;
        }

        if self.cfg.peek_every_ms > 0 && self.speech.len() >= self.peeked_voice + ms_to_samples(self.cfg.peek_every_ms) {
            self.peeked_voice = self.speech.len();
            self.peek = Some((self.speech.clone(), true));
        }

        // End on sufficient trailing silence.
        if self.silence_run >= ms_to_samples(self.cfg.silence_hangover_ms) {
            return self.finish_segment();
        }

        // Longa demais: corta na primeira pausa curta (o VAD caiu abaixo do
        // limiar de saída, sem chegar ao fim da fala) — fronteira natural de
        // frase. Sem pausa, só no fim da folga, no ponto mais baixo.
        let max = ms_to_samples(self.cfg.max_speech_ms);
        if self.speech.len() >= max {
            // ≥ 100 ms: o vão entre duas palavras (1 quadro) não conta.
            if self.silence_run >= ms_to_samples(100) {
                return Some(self.cut_here());
            }
            if self.speech.len() >= max + ms_to_samples(self.cfg.end_grace_ms) {
                return Some(self.smart_cut());
            }
        }
        None
    }

    /// Flush any buffered speech (e.g. on stop). Returns a segment if long enough.
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        if self.in_speech {
            self.finish_segment()
        } else {
            None
        }
    }

    fn finish_segment(&mut self) -> Option<Vec<f32>> {
        self.in_speech = false;
        let mut seg = std::mem::take(&mut self.speech);
        self.pre_pad.clear();
        self.silence_run = 0;
        self.smoothed = 0.0;

        // Add post-speech padding of trailing context if it's mostly silence;
        // here we simply keep the accumulated tail (already includes hangover).
        let _ = self.cfg.post_speech_pad_ms;

        let voiced = std::mem::replace(&mut self.voiced, false);
        let after_cut = std::mem::replace(&mut self.forced, false);
        let after_any_cut = std::mem::replace(&mut self.after_any_cut, false);
        self.peeked_voice = 0;
        if !voiced {
            // Depois de um corte: a frase acabou ali — libera quem esperava.
            self.tail_closed |= after_cut || after_any_cut;
            return None;
        }
        // Curto demais vira ruído descartado — MAS não o fim de uma frase
        // cortada (ex.: "…trimestre" depois da pausa): ele vai, e o pipeline
        // o junta ao trecho que esperava. Descartado, o pipeline esperava 3 s
        // por um resto que nunca vinha (visto: legenda 5,5 s atrasada).
        if !after_cut && !after_any_cut && seg.len() < ms_to_samples(self.cfg.min_speech_ms) {
            return None;
        }
        seg.shrink_to_fit();
        Some(seg)
    }

    /// Corta no fim do que já veio (estamos numa pausa curta): a fala segue
    /// num segmento novo, sem a pausa. Se a voz antes da pausa soa como fim
    /// de frase (`sentence_end_score`), o corte não fica "em aberto": o
    /// pipeline não segura o trecho esperando o resto da frase.
    fn cut_here(&mut self) -> Vec<f32> {
        let voiced_end = self.speech.len().saturating_sub(self.silence_run);
        self.end_score = sentence_end_score(&self.speech[..voiced_end]);
        self.forced = self.end_score < SENTENCE_END_SCORE;
        self.after_any_cut = true;
        self.silence_run = 0;
        self.voiced = false;
        self.peeked_voice = 0;
        let mut segment = std::mem::take(&mut self.speech);
        segment.shrink_to_fit();
        segment
    }

    /// Cut at the quietest 20 ms window within the last `smart_cut_search_ms`,
    /// keeping the remainder as the start of the next segment.
    fn smart_cut(&mut self) -> Vec<f32> {
        let win = ms_to_samples(20).max(1);
        let search = ms_to_samples(self.cfg.smart_cut_search_ms).min(self.speech.len());
        let start = self.speech.len() - search;

        let mut best_idx = self.speech.len() - win;
        let mut best_energy = f32::MAX;
        let mut i = start;
        while i + win <= self.speech.len() {
            let energy: f32 = self.speech[i..i + win].iter().map(|s| s * s).sum();
            if energy < best_energy {
                best_energy = energy;
                best_idx = i;
            }
            i += win;
        }

        // Sem pausa nenhuma: a frase segue, o corte fica sempre em aberto.
        self.forced = true;
        self.after_any_cut = true;
        self.end_score = 0.0;
        let cut = best_idx + win / 2;
        let remainder = self.speech.split_off(cut);
        let segment = std::mem::take(&mut self.speech);
        // Continue speech with the remainder.
        self.speech = remainder;
        self.peeked_voice = 0;
        self.silence_run = 0;
        segment
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(level: f32) -> Vec<f32> {
        vec![level; FRAME_SAMPLES]
    }

    #[test]
    fn emits_on_silence_after_speech() {
        let cfg = SegmenterConfig { min_speech_ms: 100, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        let mut emitted = None;
        // ~600 ms of "speech" (high prob).
        for _ in 0..20 {
            if let Some(s) = seg.push_frame(&frame(0.3), 0.9) {
                emitted = Some(s);
            }
        }
        // Then silence to trigger hangover.
        for _ in 0..20 {
            if let Some(s) = seg.push_frame(&frame(0.0), 0.0) {
                emitted = Some(s);
            }
        }
        let s = emitted.expect("a segment should be emitted");
        assert!(s.len() > ms_to_samples(300));
    }

    /// O trecho é o áudio como chegou: o pré-roll e depois a fala, sem repetir
    /// o quadro que abriu a fala (antes ele entrava duas vezes — 32 ms
    /// repetidos no começo da primeira palavra).
    #[test]
    fn the_segment_is_the_audio_as_it_came_with_no_repeated_frame() {
        let cfg = SegmenterConfig { min_speech_ms: 100, ..Default::default() };
        let mut seg = Segmenter::new(cfg.clone());
        // Cada quadro com um valor próprio: dá para ver repetição ou falta.
        let frames: Vec<Vec<f32>> = (0..60).map(|i| vec![i as f32 / 1000.0; FRAME_SAMPLES]).collect();
        let probs = (0..60).map(|i| if (20..40).contains(&i) { 0.95 } else { 0.0 });
        let mut out = None;
        for (f, p) in frames.iter().zip(probs) {
            if let Some(s) = seg.push_frame(f, p) {
                out = Some(s);
                break;
            }
        }
        let out = out.expect("trecho");
        let fed: Vec<f32> = frames.iter().flatten().copied().collect();
        // O pré-roll (200 ms) começa no meio de um quadro: o encaixe é por posição.
        let fits = (0..=fed.len() - out.len()).any(|s| fed[s..s + out.len()] == out[..]);
        assert!(fits, "o trecho repete ou pula áudio ({} amostras)", out.len());
        assert!(out.len() >= ms_to_samples(cfg.pre_speech_pad_ms), "o pré-roll entrou");
    }

    /// Pausa curta (abaixo do hangover) e a fala volta: o que foi dito até ali
    /// sai como espiada, sem cortar o trecho; pausa curtinha (entre palavras)
    /// ou fala nova curta demais, não. Desligada por padrão.
    #[test]
    fn a_short_pause_that_does_not_close_gives_a_peek_without_cutting() {
        let cfg = SegmenterConfig { peek_pause_ms: 160, ..Default::default() };
        let mut seg = Segmenter::new(cfg.clone());
        let mut out = Vec::new();
        let mut run = |seg: &mut Segmenter, frames: usize, voice: bool| {
            for _ in 0..frames {
                out.extend(if voice { seg.push_frame(&frame(0.2), 0.95) } else { seg.push_frame(&frame(0.0), 0.0) });
            }
        };
        run(&mut seg, 35, true); // ~1,1 s
        run(&mut seg, 3, false); // ~100 ms: pausa entre palavras
        run(&mut seg, 2, true);
        assert!(seg.take_peek().is_none(), "pausa curtinha não espia");
        run(&mut seg, 7, false); // ~220 ms: abaixo dos 300 ms do hangover
        run(&mut seg, 1, true);
        let (peek, timed) = seg.take_peek().expect("espiada");
        assert!(!timed, "espiada na pausa");
        assert!(peek.len() >= ms_to_samples(1100), "{}", peek.len());
        run(&mut seg, 10, true);
        run(&mut seg, 7, false);
        run(&mut seg, 1, true);
        assert!(seg.take_peek().is_none(), "menos de 1 s de fala nova desde a espiada");
        run(&mut seg, 20, false);
        assert_eq!(out.len(), 1, "a espiada não corta: um trecho só, no silêncio do fim");
        assert!(out[0].len() > peek.len());

        let mut off = Segmenter::new(SegmenterConfig::default());
        for i in 0..50 {
            off.push_frame(&frame(if (35..42).contains(&i) { 0.0 } else { 0.2 }), if (35..42).contains(&i) { 0.0 } else { 0.95 });
        }
        assert!(off.take_peek().is_none(), "desligada por padrão");
    }

    /// Fim da fala: a espiada sai na pausa, ANTES de o trecho fechar (o
    /// pipeline já transcreve), e o trecho que fecha é ela + só silêncio.
    #[test]
    fn at_the_end_of_speech_the_peek_comes_before_the_segment_and_only_silence_follows() {
        let mut seg = Segmenter::new(SegmenterConfig { peek_pause_ms: 128, ..Default::default() });
        let mut peek_at = None;
        let mut out = None;
        for i in 0..80 {
            let voice = i < 40; // ~1,3 s de fala e depois silêncio
            if let Some(s) = seg.push_frame(&frame(if voice { 0.2 } else { 0.0 }), if voice { 0.95 } else { 0.0 }) {
                out = Some((i, s));
                break;
            }
            if peek_at.is_none() {
                if let Some((p, _)) = seg.take_peek() {
                    peek_at = Some((i, p));
                }
            }
        }
        let (pi, peek) = peek_at.expect("espiada na pausa");
        let (si, segment) = out.expect("trecho no fim do silêncio");
        assert!(pi < si, "a espiada vem antes do trecho ({pi} × {si})");
        assert_eq!(&segment[..peek.len()], &peek[..], "o trecho começa com a espiada");
        assert!(segment[peek.len()..].iter().all(|s| s.abs() < 1e-6), "depois dela, só silêncio");
    }

    #[test]
    fn timed_peeks_follow_the_speech_without_cutting_it() {
        let mut seg = Segmenter::new(SegmenterConfig { peek_every_ms: 1500, ..Default::default() });
        let mut peeks = Vec::new();
        let mut segments = Vec::new();
        for _ in 0..100 {
            segments.extend(seg.push_frame(&frame(0.2), 0.95));
            peeks.extend(seg.take_peek().map(|(p, timed)| {
                assert!(timed);
                p.len()
            }));
        }
        assert_eq!(peeks.len(), 2, "3,2 s de fala: uma espiada a cada 1,5 s");
        assert!(peeks[1] >= peeks[0] + ms_to_samples(1500));
        assert!(segments.is_empty(), "a espiada não corta a fala");
    }

    fn talk(seg: &mut Segmenter, frames: impl Iterator<Item = (Vec<f32>, f32)>) -> (usize, Vec<usize>) {
        let (mut fed, mut out) = (0, Vec::new());
        for (f, p) in frames {
            fed += f.len();
            if let Some(s) = seg.push_frame(&f, p) {
                out.push(s.len());
            }
        }
        if let Some(s) = seg.flush() {
            out.push(s.len());
        }
        (fed, out)
    }

    #[test]
    fn ten_minutes_without_a_pause_come_out_whole_in_bounded_pieces() {
        let cfg = SegmenterConfig { peek_every_ms: 1500, peek_pause_ms: 128, max_speech_ms: 5000, ..Default::default() };
        let longest = ms_to_samples(cfg.max_speech_ms + cfg.end_grace_ms) + FRAME_SAMPLES;
        let mut seg = Segmenter::new(cfg);
        let speech = (0..(600 * 16_000 / FRAME_SAMPLES)).map(|i| (frame(0.1 + (i % 7) as f32 * 0.02), 0.97));
        let (fed, out) = talk(&mut seg, speech);
        assert!(out.len() >= 600 / 7, "{} pedaços", out.len());
        assert!(out.iter().all(|&n| n <= longest), "pedaço de {} s", out.iter().max().unwrap() / 16_000);
        let total: usize = out.iter().sum();
        assert!(total <= fed && fed - total <= FRAME_SAMPLES * 2, "perdeu {} amostras", fed - total);
        assert!(seg.speech.capacity() <= 4 * longest, "buffer cresceu para {}", seg.speech.capacity());
    }

    #[test]
    fn a_vad_that_flickers_every_frame_still_gives_bounded_segments() {
        let cfg = SegmenterConfig::default();
        let longest = ms_to_samples(cfg.max_speech_ms + cfg.end_grace_ms) + FRAME_SAMPLES;
        let mut seg = Segmenter::new(cfg);
        let (_, out) = talk(&mut seg, (0..20_000).map(|i| (frame(0.2), if i % 2 == 0 { 1.0 } else { 0.0 })));
        assert!(out.iter().all(|&n| n <= longest));
    }

    #[test]
    fn nan_probabilities_and_odd_frames_never_stop_the_segmenter() {
        let mut seg = Segmenter::new(SegmenterConfig::default());
        for p in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -5.0, 7.0] {
            seg.push_frame(&frame(0.2), p);
        }
        assert!(seg.push_frame(&[], 0.9).is_none());
        assert!(seg.last_rms().is_finite());
        let mut seg = Segmenter::new(SegmenterConfig::default());
        seg.push_frame(&frame(0.2), f32::NAN);
        let sizes = [100usize, 2048, 1, 512, 4096];
        let speech = (0..400).map(|i| (vec![0.2; sizes[i % sizes.len()]], 0.95));
        let silence = (0..40).map(|_| (frame(0.0), 0.0));
        let (_, out) = talk(&mut seg, speech.chain(silence));
        assert!(!out.is_empty(), "um NaN no começo não deixa a fala para sempre sem segmento");
    }

    #[test]
    fn forces_cut_at_max_duration() {
        let cfg = SegmenterConfig { max_speech_ms: 500, min_speech_ms: 50, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        let mut got = None;
        for i in 0..100 {
            if seg.push_frame(&frame(0.2), 0.95).is_some() {
                got = Some(i);
                break;
            }
        }
        // Fala sem pausa nenhuma: corta no fim da folga (500 + 1500 ms).
        // (+2: o quadro que abre a fala e o do pré-roll entram no segmento.)
        let at = got.expect("max-duration cut should emit a segment");
        assert!((at + 2) * FRAME_SAMPLES >= ms_to_samples(2000), "cortou cedo: quadro {at}");
        assert!(seg.last_cut_forced(), "corte forçado tem de ser marcado");
    }

    /// Depois do máximo, a primeira pausa curta corta ali (fronteira de frase)
    /// — sem esperar a folga e sem fim de fala.
    #[test]
    fn after_the_max_a_short_pause_cuts_there() {
        let cfg = SegmenterConfig { max_speech_ms: 1000, min_speech_ms: 50, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        for _ in 0..35 {
            assert!(seg.push_frame(&frame(0.2), 0.95).is_none());
        }
        // ~1.1 s de fala; uma pausa curta (bem menor que o hangover de 300 ms).
        let mut cut = None;
        for _ in 0..8 {
            if let Some(s) = seg.push_frame(&frame(0.0), 0.0) {
                cut = Some(s);
                break;
            }
        }
        let s = cut.expect("a pausa depois do máximo corta");
        assert!(seg.last_cut_forced(), "pausa curta não é fim de fala: a frase pode continuar");
        assert!(s.len() >= ms_to_samples(1000));
    }

    /// Frase que termina natural depois do máximo: o corte sai na pausa
    /// (marcado como "pode continuar") e, quando a fala acaba de vez sem mais
    /// voz, `take_tail_closed` avisa — o pipeline não espera 3 s à toa.
    #[test]
    fn a_natural_end_after_the_max_releases_the_held_sentence() {
        let cfg = SegmenterConfig { max_speech_ms: 1000, min_speech_ms: 50, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        let mut emitted_forced = None;
        for _ in 0..40 {
            if seg.push_frame(&frame(0.2), 0.95).is_some() {
                emitted_forced = Some(seg.last_cut_forced());
            }
        }
        let mut closed = false;
        for _ in 0..30 {
            if seg.push_frame(&frame(0.0), 0.0).is_some() {
                emitted_forced = Some(seg.last_cut_forced());
            }
            closed |= seg.take_tail_closed();
        }
        assert_eq!(emitted_forced, Some(true), "cortou na pausa, marcando que podia continuar");
        assert!(closed, "a fala acabou sem mais voz: tem de avisar");
        assert!(!seg.take_tail_closed(), "lê e zera");
    }

    /// O resto de uma frase cortada, mesmo mais curto que `min_speech_ms`,
    /// sai (não é ruído: é o fim da frase, que o pipeline junta ao corte).
    #[test]
    fn a_short_tail_after_a_cut_is_not_dropped() {
        let cfg = SegmenterConfig { max_speech_ms: 1000, min_speech_ms: 800, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        let mut out = Vec::new();
        for _ in 0..35 {
            out.extend(seg.push_frame(&frame(0.2), 0.95));
        }
        // Pausa curta (corte), 160 ms de voz (o fim da frase), silêncio.
        for _ in 0..6 {
            out.extend(seg.push_frame(&frame(0.0), 0.0));
        }
        assert_eq!(out.len(), 1, "cortou na pausa");
        for _ in 0..5 {
            out.extend(seg.push_frame(&frame(0.2), 0.95));
        }
        for _ in 0..20 {
            out.extend(seg.push_frame(&frame(0.0), 0.0));
        }
        assert_eq!(out.len(), 2, "o fim curto da frase saiu: {:?}", out.iter().map(Vec::len).collect::<Vec<_>>());
        assert!(out[1].len() < ms_to_samples(800), "mais curto que o mínimo e mesmo assim saiu");
    }

    /// A última palavra logo depois do máximo (sem pausa antes dela) fica no
    /// MESMO segmento da frase — não vai sozinha para o STT.
    #[test]
    fn the_last_word_stays_with_its_sentence() {
        let cfg = SegmenterConfig { max_speech_ms: 3000, min_speech_ms: 50, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        let mut out = Vec::new();
        // 3.6 s de fala contínua (frase + "preocupação") e o silêncio do fim.
        for _ in 0..113 {
            out.extend(seg.push_frame(&frame(0.2), 0.95));
        }
        for _ in 0..30 {
            out.extend(seg.push_frame(&frame(0.0), 0.0));
        }
        assert_eq!(out.len(), 1, "a frase foi partida: {:?}", out.iter().map(Vec::len).collect::<Vec<_>>());
        assert!(out[0].len() >= ms_to_samples(3600));
    }

    #[test]
    fn drops_too_short_segments() {
        let cfg = SegmenterConfig { min_speech_ms: 2000, ..Default::default() };
        let mut seg = Segmenter::new(cfg);
        for _ in 0..3 {
            seg.push_frame(&frame(0.2), 0.9);
        }
        for _ in 0..20 {
            seg.push_frame(&frame(0.0), 0.0);
        }
        // Short burst dropped (None already returned); flush also yields nothing.
        assert!(seg.flush().is_none());
    }

    /// Voz sintética: tom de `f_start` a `f_end` Hz em `secs`, volume de
    /// `a_start` a `a_end` (com harmônicos, como uma vogal).
    fn glide(f_start: f32, f_end: f32, a_start: f32, a_end: f32, secs: f32) -> Vec<f32> {
        let n = (secs * SR as f32) as usize;
        let mut phase = 0f32;
        (0..n)
            .map(|i| {
                let t = i as f32 / n as f32;
                let f = f_start + (f_end - f_start) * t;
                phase += std::f32::consts::TAU * f / SR as f32;
                let a = a_start + (a_end - a_start) * t;
                a * (phase.sin() + 0.5 * (2.0 * phase).sin() + 0.25 * (3.0 * phase).sin())
            })
            .collect()
    }

    #[test]
    fn falling_pitch_and_energy_sound_like_the_end_of_a_sentence() {
        // Fim de afirmação: o tom cai ~5 semitons e a voz perde força.
        let end = glide(180.0, 135.0, 0.3, 0.05, 1.0);
        assert!(sentence_end_score(&end) >= SENTENCE_END_SCORE, "{}", sentence_end_score(&end));
        // Continuação: o tom sobe ("e aí…"), volume igual.
        let goes_on = glide(140.0, 190.0, 0.3, 0.3, 1.0);
        assert!(sentence_end_score(&goes_on) < SENTENCE_END_SCORE, "{}", sentence_end_score(&goes_on));
        // Tom e volume parados: só a pausa — segura como antes.
        let flat = glide(150.0, 150.0, 0.3, 0.3, 1.0);
        assert!(sentence_end_score(&flat) < SENTENCE_END_SCORE, "{}", sentence_end_score(&flat));
    }

    #[test]
    fn a_pause_after_a_sentence_end_does_not_leave_the_cut_open() {
        let cfg = SegmenterConfig { max_speech_ms: 1000, ..SegmenterConfig::default() };
        let speech = |seg: &mut Segmenter, audio: &[f32]| {
            audio.chunks_exact(FRAME_SAMPLES).filter_map(|f| seg.push_frame(f, 0.9)).last()
        };
        let pause = |seg: &mut Segmenter| (0..8).filter_map(|_| seg.push_frame(&frame(0.0), 0.0)).last();
        // Frase terminando (tom e volume caindo), pausa curta: corta e o
        // corte NÃO fica em aberto — o pipeline não segura o trecho.
        let mut seg = Segmenter::new(cfg.clone());
        assert!(speech(&mut seg, &glide(180.0, 130.0, 0.3, 0.05, 1.5)).is_none());
        assert!(pause(&mut seg).is_some(), "cortou na pausa");
        assert!(!seg.last_cut_forced(), "fim de frase: não espera o resto");
        // Tom subindo antes da mesma pausa: continuação, o corte fica em aberto.
        let mut seg = Segmenter::new(cfg);
        assert!(speech(&mut seg, &glide(140.0, 200.0, 0.3, 0.3, 1.5)).is_none());
        assert!(pause(&mut seg).is_some(), "cortou na pausa");
        assert!(seg.last_cut_forced(), "a frase continua: espera o resto");
    }
}
