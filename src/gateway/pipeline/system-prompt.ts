// ── BabelCast Gateway — System Prompt Builder ────────────────────────────────
// Builds translation system prompts from source/target language and style.

/** Available translation styles with their prompt templates. */
export const TRANSLATION_STYLES: Record<string, string> = {
  default:  'You are a real-time translator. Translate the following text accurately and naturally. Output ONLY the translation, nothing else.',
  academic: 'You are a real-time translator for an academic conference. Translate the following text into formal, scholarly English suitable for a scientific seminar or lecture presentation. Use precise academic vocabulary, complete sentences, formal register (no contractions, no slang), and natural academic discourse markers (therefore, furthermore, consequently, it is noteworthy that…). Output ONLY the translation, nothing else.',
  casual:   'You are a real-time translator. Translate the following text in a natural, conversational tone — as if two friends were talking. Keep it relaxed and colloquial. Output ONLY the translation, nothing else.',
  news:     'You are a real-time translator for broadcast journalism. Translate with the clarity and authority of a TV news anchor — concise, neutral, professional. Output ONLY the translation, nothing else.',
};

/**
 * Build a translation system prompt for the given source→target language pair and style.
 *
 * @param source - Human-readable source language name (e.g. "French")
 * @param target - Human-readable target language name (e.g. "English")
 * @param style - Translation style key (default, academic, casual, news)
 */
export function buildSystemPrompt(source: string, target: string, style: string = 'default'): string {
  const prompt = TRANSLATION_STYLES[style] ?? TRANSLATION_STYLES.default;
  return `${prompt}\nTranslate from ${source} to ${target}.`;
}

/**
 * Resolve a speaker/voice name to one valid for the active TTS provider.
 * Now that Modal Qwen3-TTS is the primary cloud fallback, we keep the original
 * Qwen3-TTS name (Ryan, Vivian etc.) — Modal accepts them natively.
 * Each downstream provider (Groq, OpenAI) has its own resolveVoice() that maps
 * unknown names to their own defaults automatically.
 */
export function resolveVoiceForProfile(speaker: string, _hasGpu: boolean): string {
  return speaker;
}
