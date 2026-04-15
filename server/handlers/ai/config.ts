/**
 * AI Handlers Configuration and Timeouts
 */

import { createLogger } from '../../../src/logger';

const log = createLogger('ai-config');

/**
 * Base timeout configurations
 */
export const DEFAULT_TIMEOUTS = {
  STT: 30000,      // 30 seconds
  LLM: 60000,      // 60 seconds
  TTS: 45000,      // 45 seconds
  PIPELINE: 120000, // 2 minutes
  CHAT: 90000,     // 90 seconds
};

/**
 * GPU-specific timeouts (faster for GPU inference)
 */
export const GPU_TIMEOUTS = {
  STT: 15000,      // 15 seconds
  LLM: 30000,      // 30 seconds
  TTS: 20000,      // 20 seconds
  PIPELINE: 60000, // 60 seconds
};

/**
 * Cloud provider timeouts
 */
export const CLOUD_TIMEOUTS = {
  groq: {
    STT: 10000,
    LLM: 15000,
    TTS: 15000,
  },
  openai: {
    STT: 15000,
    LLM: 30000,
    TTS: 20000,
  },
  deepgram: {
    STT: 8000,
  },
  fireworks: {
    STT: 12000,
    LLM: 25000,
  },
};

/**
 * Adaptive timeout based on system load
 */
export function adaptiveTimeout(
  baseMs: number,
  options: {
    loadFactor?: number;
    retryCount?: number;
    isGpu?: boolean;
  } = {}
): number {
  const { loadFactor = 1.0, retryCount = 0, isGpu = false } = options;
  
  // GPU is faster
  const gpuMultiplier = isGpu ? 0.7 : 1.0;
  
  // Increase timeout on retries
  const retryMultiplier = 1 + (retryCount * 0.5);
  
  // Adjust for load
  const loadMultiplier = Math.max(0.8, Math.min(2.0, loadFactor));
  
  const finalTimeout = Math.round(baseMs * gpuMultiplier * retryMultiplier * loadMultiplier);
  
  // Cap at 5 minutes max
  return Math.min(finalTimeout, 300000);
}

/**
 * Get stage-specific timeout
 */
export function getStageTimeout(
  stage: 'stt' | 'llm' | 'tts' | 'pipeline',
  provider: 'gpu' | 'cloud' = 'cloud',
  options?: {
    retryCount?: number;
    loadFactor?: number;
  }
): number {
  const baseTimeout = provider === 'gpu' 
    ? GPU_TIMEOUTS[stage.toUpperCase() as keyof typeof GPU_TIMEOUTS]
    : DEFAULT_TIMEOUTS[stage.toUpperCase() as keyof typeof DEFAULT_TIMEOUTS];
  
  return adaptiveTimeout(baseTimeout, {
    isGpu: provider === 'gpu',
    retryCount: options?.retryCount,
    loadFactor: options?.loadFactor,
  });
}

/**
 * Hallucination filter configuration
 */
export const HALLUCINATION_FILTER_CONFIG = {
  enabled: true,
  minConfidence: 0.5,
  maxRepeatedChars: 3,
  blockedPhrases: [
    'thank you for watching',
    'subscribe to my channel',
    'like and subscribe',
  ],
};

/**
 * Ensemble STT provider configuration
 */
export const ENSEMBLE_STT_PROVIDERS = [
  'groq',
  'deepgram',
  'fireworks',
  'openai',
];

/**
 * Provider priority for fallback chains
 */
export const PROVIDER_PRIORITY: Record<string, string[]> = {
  stt: ['gpu', 'groq', 'deepgram', 'fireworks', 'openai'],
  llm: ['gpu', 'groq', 'fireworks', 'openrouter', 'openai'],
  tts: ['gpu', 'groq', 'openai', 'modal'],
};

/**
 * Validate language code
 */
export function validateLanguage(lang: string): boolean {
  const validLangs = [
    'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ko',
    'ar', 'hi', 'tr', 'vi', 'th', 'id', 'cs', 'el', 'he', 'sv', 'da', 'fi',
    'no', 'hu', 'ro', 'sk', 'uk', 'bg', 'hr', 'sr', 'sl', 'lt', 'lv', 'et',
    'auto',
  ];
  return validLangs.includes(lang.toLowerCase());
}

/**
 * Get full language name
 */
export function getLanguageName(lang: string): string {
  const names: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    pl: 'Polish',
    ru: 'Russian',
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
    ar: 'Arabic',
    hi: 'Hindi',
    auto: 'Auto-detect',
  };
  return names[lang.toLowerCase()] || lang;
}
