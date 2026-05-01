/**
 * Voice Catalog - All available voices across TTS providers
 *
 * This catalog enables voice mapping between generic voice slots
 * (e.g., "Male Voice 1", "Female Voice 2") and provider-specific voice IDs.
 */

import type { VoiceInfo } from './types';

// ---------------------------------------------------------------------------
// Voice Categories for Mapping
// ---------------------------------------------------------------------------

export type VoiceGender = 'male' | 'female' | 'neutral';

export interface VoiceSlot {
  id: string;
  label: string;
  labelPt: string;
  gender: VoiceGender;
}

/** Generic voice slots that users can map to provider-specific voices */
export const VOICE_SLOTS: VoiceSlot[] = [
  { id: 'male1', label: 'Male Voice 1', labelPt: 'Voz Masculina 1', gender: 'male' },
  { id: 'male2', label: 'Male Voice 2', labelPt: 'Voz Masculina 2', gender: 'male' },
  { id: 'female1', label: 'Female Voice 1', labelPt: 'Voz Feminina 1', gender: 'female' },
  { id: 'female2', label: 'Female Voice 2', labelPt: 'Voz Feminina 2', gender: 'female' },
];

// ---------------------------------------------------------------------------
// Provider Voice Catalogs
// ---------------------------------------------------------------------------

export interface ProviderVoice extends VoiceInfo {
  gender?: VoiceGender;
  language?: string;
  languageName?: string;
  previewUrl?: string;
}

export interface ProviderVoiceCatalog {
  providerId: string;
  providerName: string;
  models: {
    id: string;
    name: string;
    voices: ProviderVoice[];
  }[];
}

// ---------------------------------------------------------------------------
// OpenAI Voices
// ---------------------------------------------------------------------------
export const OPENAI_VOICE_CATALOG: ProviderVoiceCatalog = {
  providerId: 'openai',
  providerName: 'OpenAI',
  models: [
    {
      id: 'gpt-4o-mini-tts-2025-03-20',
      name: 'GPT-4o Mini TTS (Estavel)',
      voices: [
        { id: 'alloy', name: 'Alloy', description: 'Neutro e equilibrado', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'ash', name: 'Ash', description: 'Claro e articulado', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'ballad', name: 'Ballad', description: 'Caloroso e expressivo', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'coral', name: 'Coral', description: 'Amigavel e acessivel', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'echo', name: 'Echo', description: 'Claro e ressonante', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'fable', name: 'Fable', description: 'Qualidade de contador de historias', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'nova', name: 'Nova', description: 'Energetico e vibrante', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'onyx', name: 'Onyx', description: 'Profundo e autoritario', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'sage', name: 'Sage', description: 'Calmo e ponderado', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'shimmer', name: 'Shimmer', description: 'Suave e gentil', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'verse', name: 'Verse', description: 'Poetico e medido', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'marin', name: 'Marin', description: 'Natural e claro (recomendado)', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'cedar', name: 'Cedar', description: 'Caloroso e natural (recomendado)', gender: 'male', language: 'multi', languageName: 'Multilingue' },
      ],
    },
    {
      id: 'tts-1',
      name: 'TTS-1 (Rapido)',
      voices: [
        { id: 'alloy', name: 'Alloy', description: 'Neutro e equilibrado', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'ash', name: 'Ash', description: 'Claro e articulado', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'coral', name: 'Coral', description: 'Amigavel e acessivel', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'echo', name: 'Echo', description: 'Claro e ressonante', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'fable', name: 'Fable', description: 'Qualidade de contador de historias', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'nova', name: 'Nova', description: 'Energetico e vibrante', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'onyx', name: 'Onyx', description: 'Profundo e autoritario', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'sage', name: 'Sage', description: 'Calmo e ponderado', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'shimmer', name: 'Shimmer', description: 'Suave e gentil', gender: 'female', language: 'multi', languageName: 'Multilingue' },
      ],
    },
    {
      id: 'tts-1-hd',
      name: 'TTS-1 HD (Alta Qualidade)',
      voices: [
        { id: 'alloy', name: 'Alloy', description: 'Neutro e equilibrado', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'ash', name: 'Ash', description: 'Claro e articulado', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'coral', name: 'Coral', description: 'Amigavel e acessivel', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'echo', name: 'Echo', description: 'Claro e ressonante', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'fable', name: 'Fable', description: 'Qualidade de contador de historias', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'nova', name: 'Nova', description: 'Energetico e vibrante', gender: 'female', language: 'multi', languageName: 'Multilingue' },
        { id: 'onyx', name: 'Onyx', description: 'Profundo e autoritario', gender: 'male', language: 'multi', languageName: 'Multilingue' },
        { id: 'sage', name: 'Sage', description: 'Calmo e ponderado', gender: 'neutral', language: 'multi', languageName: 'Multilingue' },
        { id: 'shimmer', name: 'Shimmer', description: 'Suave e gentil', gender: 'female', language: 'multi', languageName: 'Multilingue' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Kokoro TTS Voices (hexgrad/Kokoro-82M) - All 54+ voices
// ---------------------------------------------------------------------------
export const KOKORO_VOICE_CATALOG: ProviderVoiceCatalog = {
  providerId: 'kokoro',
  providerName: 'Kokoro 82M',
  models: [
    {
      id: 'kokoro-82m',
      name: 'Kokoro 82M',
      voices: [
        // ══════════════════════════════════════════════════════════════════════
        // ENGLISH - American (en-US)
        // ══════════════════════════════════════════════════════════════════════
        { id: 'af_alloy', name: 'Alloy', description: 'Americano feminino - Neutro', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_aoede', name: 'Aoede', description: 'Americano feminino - Melodico', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_bella', name: 'Bella', description: 'Americano feminino - Caloroso', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_heart', name: 'Heart', description: 'Americano feminino - Emocional', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_jessica', name: 'Jessica', description: 'Americano feminino - Profissional', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_kore', name: 'Kore', description: 'Americano feminino - Jovem', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_nicole', name: 'Nicole', description: 'Americano feminino - Claro', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_nova', name: 'Nova', description: 'Americano feminino - Vibrante', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_river', name: 'River', description: 'Americano feminino - Fluido', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_sarah', name: 'Sarah', description: 'Americano feminino - Amigavel', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'af_sky', name: 'Sky', description: 'Americano feminino - Brilhante', gender: 'female', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_adam', name: 'Adam', description: 'Americano masculino - Profundo', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_echo', name: 'Echo', description: 'Americano masculino - Ressonante', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_eric', name: 'Eric', description: 'Americano masculino - Confiante', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_fenrir', name: 'Fenrir', description: 'Americano masculino - Forte', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_liam', name: 'Liam', description: 'Americano masculino - Jovem', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_michael', name: 'Michael', description: 'Americano masculino - Claro', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_onyx', name: 'Onyx', description: 'Americano masculino - Autoritario', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },
        { id: 'am_puck', name: 'Puck', description: 'Americano masculino - Travesso', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },

        // ══════════════════════════════════════════════════════════════════════
        // ENGLISH - British (en-GB)
        // ══════════════════════════════════════════════════════════════════════
        { id: 'bf_alice', name: 'Alice', description: 'Britanico feminino - Classico', gender: 'female', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bf_emma', name: 'Emma', description: 'Britanico feminino - Elegante', gender: 'female', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bf_isabella', name: 'Isabella', description: 'Britanico feminino - Sofisticado', gender: 'female', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bf_lily', name: 'Lily', description: 'Britanico feminino - Delicado', gender: 'female', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bm_daniel', name: 'Daniel', description: 'Britanico masculino - Distinto', gender: 'male', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bm_fable', name: 'Fable', description: 'Britanico masculino - Narrador', gender: 'male', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bm_george', name: 'George', description: 'Britanico masculino - Classico', gender: 'male', language: 'en-GB', languageName: 'Ingles (UK)' },
        { id: 'bm_lewis', name: 'Lewis', description: 'Britanico masculino - Moderno', gender: 'male', language: 'en-GB', languageName: 'Ingles (UK)' },

        // ══════════════════════════════════════════════════════════════════════
        // EN-US extras present on the server (am_santa)
        // ══════════════════════════════════════════════════════════════════════
        { id: 'am_santa', name: 'Santa', description: 'Americano masculino - Caloroso', gender: 'male', language: 'en-US', languageName: 'Ingles (EUA)' },

        // ══════════════════════════════════════════════════════════════════════
        // PORTUGUESE - Brazilian (pt-BR) — only voices present in
        // dockers/kokoro-tts/server.py:ALL_VOICES. The pretrained model has
        // exactly these three; pf_camila/pf_fernanda/pm_antonio do NOT
        // exist in hexgrad/Kokoro-82M and the server returns 400 for them.
        // ══════════════════════════════════════════════════════════════════════
        { id: 'pf_dora', name: 'Dora', description: 'Brasileiro feminino - Expressivo', gender: 'female', language: 'pt-BR', languageName: 'Portugues (Brasil)' },
        { id: 'pm_alex', name: 'Alex', description: 'Brasileiro masculino - Claro', gender: 'male', language: 'pt-BR', languageName: 'Portugues (Brasil)' },
        { id: 'pm_santa', name: 'Santa', description: 'Brasileiro masculino - Caloroso', gender: 'male', language: 'pt-BR', languageName: 'Portugues (Brasil)' },

        // ══════════════════════════════════════════════════════════════════════
        // SPANISH (es) — server only has ef_dora, em_alex, em_santa.
        // ══════════════════════════════════════════════════════════════════════
        { id: 'ef_dora', name: 'Dora', description: 'Espanhol feminino - Expressivo', gender: 'female', language: 'es', languageName: 'Espanhol' },
        { id: 'em_alex', name: 'Alex', description: 'Espanhol masculino - Natural', gender: 'male', language: 'es', languageName: 'Espanhol' },
        { id: 'em_santa', name: 'Santa', description: 'Espanhol masculino - Caloroso', gender: 'male', language: 'es', languageName: 'Espanhol' },

        // ══════════════════════════════════════════════════════════════════════
        // FRENCH (fr) — server only has ff_siwis.
        // ══════════════════════════════════════════════════════════════════════
        { id: 'ff_siwis', name: 'Siwis', description: 'Frances feminino - Sofisticado', gender: 'female', language: 'fr', languageName: 'Frances' },

        // GERMAN (de) and KOREAN (ko) intentionally omitted —
        // hexgrad/Kokoro-82M does not include voices for these languages,
        // even though earlier versions of this catalog claimed otherwise.

        // ══════════════════════════════════════════════════════════════════════
        // ITALIAN (it) — server only has if_sara, im_nicola.
        // ══════════════════════════════════════════════════════════════════════
        { id: 'if_sara', name: 'Sara', description: 'Italiano feminino - Natural', gender: 'female', language: 'it', languageName: 'Italiano' },
        { id: 'im_nicola', name: 'Nicola', description: 'Italiano masculino - Caloroso', gender: 'male', language: 'it', languageName: 'Italiano' },

        // ══════════════════════════════════════════════════════════════════════
        // JAPANESE (ja)
        // ══════════════════════════════════════════════════════════════════════
        { id: 'jf_alpha', name: 'Alpha', description: 'Japones feminino - Claro', gender: 'female', language: 'ja', languageName: 'Japones' },
        { id: 'jf_gongitsune', name: 'Gongitsune', description: 'Japones feminino - Suave', gender: 'female', language: 'ja', languageName: 'Japones' },
        { id: 'jf_nezumi', name: 'Nezumi', description: 'Japones feminino - Jovem', gender: 'female', language: 'ja', languageName: 'Japones' },
        { id: 'jf_tebukuro', name: 'Tebukuro', description: 'Japones feminino - Gentil', gender: 'female', language: 'ja', languageName: 'Japones' },
        { id: 'jm_kumo', name: 'Kumo', description: 'Japones masculino - Natural', gender: 'male', language: 'ja', languageName: 'Japones' },

        // ══════════════════════════════════════════════════════════════════════
        // CHINESE - Mandarin (zh)
        // ══════════════════════════════════════════════════════════════════════
        { id: 'zf_xiaobei', name: 'Xiaobei', description: 'Chines feminino - Claro', gender: 'female', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zf_xiaoni', name: 'Xiaoni', description: 'Chines feminino - Caloroso', gender: 'female', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zf_xiaoxiao', name: 'Xiaoxiao', description: 'Chines feminino - Brilhante', gender: 'female', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zf_xiaoyi', name: 'Xiaoyi', description: 'Chines feminino - Natural', gender: 'female', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zm_yunjian', name: 'Yunjian', description: 'Chines masculino - Profundo', gender: 'male', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zm_yunxi', name: 'Yunxi', description: 'Chines masculino - Claro', gender: 'male', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zm_yunxia', name: 'Yunxia', description: 'Chines masculino - Caloroso', gender: 'male', language: 'zh', languageName: 'Chines (Mandarim)' },
        { id: 'zm_yunyang', name: 'Yunyang', description: 'Chines masculino - Natural', gender: 'male', language: 'zh', languageName: 'Chines (Mandarim)' },

        // ══════════════════════════════════════════════════════════════════════
        // HINDI (hi) — actual voices in hexgrad/Kokoro-82M.
        // ══════════════════════════════════════════════════════════════════════
        { id: 'hf_alpha', name: 'Alpha', description: 'Hindi feminino - Claro', gender: 'female', language: 'hi', languageName: 'Hindi' },
        { id: 'hf_beta', name: 'Beta', description: 'Hindi feminino - Natural', gender: 'female', language: 'hi', languageName: 'Hindi' },
        { id: 'hm_omega', name: 'Omega', description: 'Hindi masculino - Profundo', gender: 'male', language: 'hi', languageName: 'Hindi' },
        { id: 'hm_psi', name: 'Psi', description: 'Hindi masculino - Claro', gender: 'male', language: 'hi', languageName: 'Hindi' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Qwen3 TTS Voices (CosyVoice-based)
// ---------------------------------------------------------------------------
export const QWEN3_VOICE_CATALOG: ProviderVoiceCatalog = {
  providerId: 'qwen3',
  providerName: 'Qwen3 TTS (CustomVoice)',
  models: [
    {
      id: 'qwen3-tts',
      name: 'Qwen3 TTS CustomVoice',
      voices: [
        // Official Qwen3-TTS preset speakers (from HuggingFace Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)
        // All 9 speakers can speak any of the 10 supported languages (zh, en, ja, ko, de, fr, ru, pt, es, it)
        // but best quality is in their native language.

        // Chinese native speakers
        { id: 'Vivian', name: 'Vivian', description: 'Chinesa feminina — Voz brilhante e ligeiramente cortante', gender: 'female', language: 'zh', languageName: 'Chines' },
        { id: 'Serena', name: 'Serena', description: 'Chinesa feminina — Voz calorosa e suave', gender: 'female', language: 'zh', languageName: 'Chines' },
        { id: 'Uncle_Fu', name: 'Uncle Fu', description: 'Chines masculino — Voz experiente, grave e melosa', gender: 'male', language: 'zh', languageName: 'Chines' },
        { id: 'Dylan', name: 'Dylan', description: 'Chines masculino (Beijing) — Voz jovem, clara e natural', gender: 'male', language: 'zh', languageName: 'Chines' },
        { id: 'Eric', name: 'Eric', description: 'Chines masculino (Sichuan) — Voz animada, ligeiramente rouca', gender: 'male', language: 'zh', languageName: 'Chines' },

        // English native speakers
        { id: 'Ryan', name: 'Ryan', description: 'Ingles masculino — Voz dinamica com ritmo forte', gender: 'male', language: 'en', languageName: 'Ingles' },
        { id: 'Aiden', name: 'Aiden', description: 'Ingles masculino (US) — Voz ensolarada com medio claro', gender: 'male', language: 'en', languageName: 'Ingles' },

        // Japanese native speaker
        { id: 'Ono_Anna', name: 'Ono Anna', description: 'Japonesa feminina — Voz brincalhona, leve e agil', gender: 'female', language: 'ja', languageName: 'Japones' },

        // Korean native speaker
        { id: 'Sohee', name: 'Sohee', description: 'Coreana feminina — Voz calorosa com emocao rica', gender: 'female', language: 'ko', languageName: 'Coreano' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Combined Catalogs for Self-Hosted
// ---------------------------------------------------------------------------

// SkyPilot / Self-hosted voices (combines Kokoro + Qwen3)
export const SKYPILOT_VOICE_CATALOG: ProviderVoiceCatalog = {
  providerId: 'skypilot',
  providerName: 'SkyPilot (Self-hosted)',
  models: [
    ...KOKORO_VOICE_CATALOG.models,
    ...QWEN3_VOICE_CATALOG.models,
  ],
};

// ---------------------------------------------------------------------------
// MOSS-TTS-Realtime Voices (OpenMOSS-Team/MOSS-TTS-Realtime 1.7B)
// One voice per language. Voice cloning via user-provided reference audio.
// ---------------------------------------------------------------------------

/** Helper to generate a MOSS-TTS voice entry for a language */
function mossTtsLangVoice(
  langCode: string,
  langName: string,
  langNamePt: string,
): ProviderVoice {
  return {
    id: `moss-${langCode}`,
    name: `${langName}`,
    description: `MOSS-TTS ${langNamePt} (suporta clonagem de voz com audio de referencia)`,
    gender: 'neutral',
    language: langCode,
    languageName: langNamePt,
  };
}

export const MOSS_TTS_VOICE_CATALOG: ProviderVoiceCatalog = {
  providerId: 'moss-tts',
  providerName: 'MOSS-TTS-Realtime 1.7B',
  models: [
    {
      id: 'moss-tts-realtime',
      name: 'MOSS-TTS-Realtime 1.7B',
      voices: [
        mossTtsLangVoice('pt', 'Portugues', 'Portugues'),
        mossTtsLangVoice('en', 'English', 'Ingles'),
        mossTtsLangVoice('es', 'Espanol', 'Espanhol'),
        mossTtsLangVoice('fr', 'Francais', 'Frances'),
        mossTtsLangVoice('de', 'Deutsch', 'Alemao'),
        mossTtsLangVoice('it', 'Italiano', 'Italiano'),
        mossTtsLangVoice('ja', 'Japanese', 'Japones'),
        mossTtsLangVoice('zh', 'Chinese', 'Chines'),
        mossTtsLangVoice('ko', 'Korean', 'Coreano'),
        mossTtsLangVoice('ru', 'Russian', 'Russo'),
        mossTtsLangVoice('ar', 'Arabic', 'Arabe'),
        mossTtsLangVoice('tr', 'Turkish', 'Turco'),
      ],
    },
  ],
};

// Modal voices (MOSS-TTS + Kokoro + Qwen3)
export const MODAL_VOICE_CATALOG: ProviderVoiceCatalog = {
  providerId: 'modal',
  providerName: 'Modal (Serverless)',
  models: [
    ...MOSS_TTS_VOICE_CATALOG.models,
    ...KOKORO_VOICE_CATALOG.models,
    ...QWEN3_VOICE_CATALOG.models,
  ],
};

// ---------------------------------------------------------------------------
// Voice Mapping Types
// ---------------------------------------------------------------------------

/** Maps a slot ID to a provider's voice ID */
export interface VoiceMapping {
  /** Provider ID (e.g., 'openai', 'kokoro') */
  providerId: string;
  /** Model ID (e.g., 'gpt-4o-mini-tts', 'kokoro-82m') */
  modelId: string;
  /** Maps slot ID to voice ID */
  mapping: Record<string, string>;
  /** Per-slot voice style instructions (gpt-4o-mini-tts only) */
  instructions?: Record<string, string>;
}

/** Complete voice mappings configuration */
export interface VoiceMappingConfig {
  /** Mapping per provider/model combination */
  mappings: VoiceMapping[];
  /** Default slot to use when provider doesn't have a mapping */
  defaultSlot: string;
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/** Get all provider voice catalogs */
export function getAllVoiceCatalogs(): ProviderVoiceCatalog[] {
  return [
    OPENAI_VOICE_CATALOG,
    MODAL_VOICE_CATALOG,
    KOKORO_VOICE_CATALOG,
    QWEN3_VOICE_CATALOG,
  ];
}

/** Get voice catalog for a specific provider */
export function getVoiceCatalog(providerId: string): ProviderVoiceCatalog | undefined {
  switch (providerId) {
    case 'openai':
      return OPENAI_VOICE_CATALOG;
    case 'kokoro':
      return KOKORO_VOICE_CATALOG;
    case 'qwen3':
    case 'qwen3-tts':
      return QWEN3_VOICE_CATALOG;
    case 'moss-tts':
    case 'moss':
      return MOSS_TTS_VOICE_CATALOG;
    case 'skypilot':
      return SKYPILOT_VOICE_CATALOG;
    case 'modal':
      return MODAL_VOICE_CATALOG;
    default:
      return undefined;
  }
}

/** Get voices for a specific provider and model */
export function getVoicesForProviderModel(providerId: string, modelId: string): ProviderVoice[] {
  const catalog = getVoiceCatalog(providerId);
  if (!catalog) return [];

  const model = catalog.models.find(m => m.id === modelId);
  return model?.voices || [];
}

/** Get all unique languages from a provider catalog */
export function getLanguagesFromCatalog(catalog: ProviderVoiceCatalog): string[] {
  const languages = new Set<string>();
  for (const model of catalog.models) {
    for (const voice of model.voices) {
      if (voice.language) {
        languages.add(voice.language);
      }
    }
  }
  return Array.from(languages).sort();
}

/** Filter voices by language */
export function filterVoicesByLanguage(voices: ProviderVoice[], language: string): ProviderVoice[] {
  if (!language || language === 'all') return voices;
  return voices.filter(v => v.language === language || v.language === 'multi');
}

/** Get default voice mappings (best-effort matching by gender) */
export function getDefaultVoiceMappings(): VoiceMappingConfig {
  const mappings: VoiceMapping[] = [];

  const catalogs = getAllVoiceCatalogs();

  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      const mapping: Record<string, string> = {};

      const maleVoices = model.voices.filter(v => v.gender === 'male');
      const femaleVoices = model.voices.filter(v => v.gender === 'female');

      mapping['male1'] = maleVoices[0]?.id || model.voices[0]?.id || '';
      mapping['male2'] = maleVoices[1]?.id || maleVoices[0]?.id || model.voices[0]?.id || '';
      mapping['female1'] = femaleVoices[0]?.id || model.voices[0]?.id || '';
      mapping['female2'] = femaleVoices[1]?.id || femaleVoices[0]?.id || model.voices[0]?.id || '';

      mappings.push({
        providerId: catalog.providerId,
        modelId: model.id,
        mapping,
      });
    }
  }

  return {
    mappings,
    defaultSlot: 'female1',
  };
}

/** Resolve a voice slot to a specific voice ID for a provider/model */
export function resolveVoiceSlot(
  config: VoiceMappingConfig,
  slotId: string,
  providerId: string,
  modelId: string
): string | undefined {
  const mapping = config.mappings.find(
    m => m.providerId === providerId && m.modelId === modelId
  );

  if (mapping && mapping.mapping[slotId]) {
    return mapping.mapping[slotId];
  }

  // Fallback: try to find a voice by gender
  const slot = VOICE_SLOTS.find(s => s.id === slotId);
  if (!slot) return undefined;

  const voices = getVoicesForProviderModel(providerId, modelId);
  const genderMatch = voices.find(v => v.gender === slot.gender);
  return genderMatch?.id || voices[0]?.id;
}
