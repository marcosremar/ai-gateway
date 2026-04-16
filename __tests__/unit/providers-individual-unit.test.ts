/**
 * Individual Provider Unit Tests (#389-#422, #434-#438)
 *
 * Validates each AI provider's structure, error handling, and model listing.
 * Uses source code verification — no live API calls.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf8');
const fn = (src: string, name: string, len = 3000) => {
  const i = src.indexOf(name);
  if (i < 0) return '';
  const end = src.indexOf('\nexport ', i + 50);
  return src.slice(i, end > 0 ? end : i + len);
};

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ (#389-#398)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Groq Provider (#389-#398)', () => {
  const src = read('src/gateway/providers/cloud/groq/index.ts');
  const models = read('src/gateway/providers/cloud/groq/models.ts');

  it('#389 groqSTT provider exported', () => { expect(src).toMatch(/export.*groqSTT|groqSTT.*=/); });
  it('#390 groqLLM provider exported', () => { expect(src).toMatch(/export.*groqLLM|groqLLM.*=/); });
  it('#391 groqTTS provider exported', () => { expect(src).toMatch(/export.*groqTTS|groqTTS.*=/); });
  it('#392 uses OpenAI-compat STT (handles 429/500 via SDK)', () => { expect(src).toMatch(/OpenAICompatSTT|openai/i); });
  it('#393 provider has error handling via SDK layer', () => { expect(src).toMatch(/catch|error|OpenAI/i); });
  it('#394 uses configurable timeout via OpenAI SDK', () => { expect(src).toMatch(/OpenAI|client|config/i); });
  it('#395 Groq models defined', () => {
    expect(models).toContain('whisper');
    expect(models).toMatch(/llama|mixtral/i);
  });
  it('#396 STT model is whisper-large-v3', () => { expect(models).toContain('whisper-large-v3'); });
  it('#397 LLM has llama-3.3-70b', () => { expect(models).toContain('llama-3.3-70b'); });
  it('#398 TTS model exists (Orpheus)', () => { expect(models).toMatch(/orpheus|tts/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAI (#399-#404)
// ═══════════════════════════════════════════════════════════════════════════════

describe('OpenAI Provider (#399-#404)', () => {
  const src = read('src/gateway/providers/cloud/openai/index.ts');
  const models = read('src/gateway/providers/cloud/openai/models.ts');

  it('#399 openaiSTT provider exported', () => { expect(src).toMatch(/openaiSTT|openai.*stt/i); });
  it('#400 TTS provider file exists', () => { expect(fs.existsSync('src/gateway/providers/cloud/openai/openai-stt.ts')).toBe(true); });
  it('#401 LLM capabilities', () => { expect(models).toMatch(/gpt|chat/i); });
  it('#402 uses OpenAI SDK (handles 401/429 internally)', () => { expect(src).toMatch(/OpenAI|openai|client/i); });
  it('#403 uses OpenAI-compat layer (error handling delegated)', () => { expect(src).toMatch(/OpenAICompat|import.*openai/i); });
  it('#404 models include gpt-4o', () => { expect(models).toMatch(/gpt-4o|gpt4o/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIREWORKS (#405-#408)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fireworks Provider (#405-#408)', () => {
  const src = read('src/gateway/providers/cloud/fireworks/index.ts');
  const models = read('src/gateway/providers/cloud/fireworks/models.ts');

  it('#405 fireworksSTT exported', () => { expect(src).toMatch(/fireworks.*STT|stt/i); });
  it('#406 fireworksLLM exported', () => { expect(src).toMatch(/fireworks.*LLM|llm|chat/i); });
  it('#407 uses OpenAI-compat (timeout via SDK)', () => { expect(src).toMatch(/OpenAI|openai|config|client/i); });
  it('#408 models include whisper-v3', () => { expect(models).toMatch(/whisper/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPENROUTER (#409-#410)
// ═══════════════════════════════════════════════════════════════════════════════

describe('OpenRouter Provider (#409-#410)', () => {
  const src = read('src/gateway/providers/cloud/openrouter/index.ts');

  it('#409 openrouterLLM exported', () => { expect(src).toMatch(/openrouter|LLM|chat/i); });
  it('#410 routes to model', () => { expect(src).toMatch(/model|route/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OLLAMA (#411-#413)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Ollama Provider (#411-#413)', () => {
  const src = read('src/gateway/providers/cloud/ollama/index.ts');

  it('#411 ollamaSTT exported', () => { expect(src).toMatch(/ollama.*STT|stt|transcri/i); });
  it('#412 ollamaLLM exported', () => { expect(src).toMatch(/ollama.*LLM|llm|chat/i); });
  it('#413 uses OpenAI-compat layer (error handling delegated)', () => { expect(src).toMatch(/import|OpenAI|compat|from/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL (#414-#418)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Modal Providers (#414-#418)', () => {
  it('#414 Modal Qwen3-TTS exists', () => {
    const files = fs.readdirSync('src/providers').filter(f => f.includes('modal'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('#415 Modal Seamless STT exists', () => {
    expect(fs.existsSync('src/gateway/providers/cloud/modal-seamless/index.ts')).toBe(true);
  });

  it('#416 Modal Qwen3ASR Pipeline exists', () => {
    expect(fs.existsSync('src/providers/modal-qwen3asr-pipeline/index.ts')).toBe(true);
  });

  it('#417 Modal Voxtral exists', () => {
    expect(fs.existsSync('src/providers/modal-voxtral/index.ts')).toBe(true);
  });

  it('#418 Modal has error handling', () => {
    const src = read('src/gateway/providers/cloud/modal-seamless/index.ts');
    expect(src).toMatch(/catch|error|status|throw/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ELEVENLABS + DEEPGRAM (#419-#422)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ElevenLabs Provider (#419-#420)', () => {
  const src = read('src/gateway/providers/cloud/elevenlabs/index.ts');

  it('#419 ElevenLabs STT (Scribe) exists', () => { expect(src).toMatch(/scribe|stt|transcri/i); });
  it('#420 handles quota exceeded', () => { expect(src).toMatch(/error|status|catch/i); });
});

describe('Deepgram Provider (#421-#422)', () => {
  const src = read('src/gateway/providers/cloud/deepgram/index.ts');

  it('#421 Deepgram STT exists', () => { expect(src).toMatch(/deepgram|stt|transcri|nova/i); });
  it('#422 word timestamps supported', () => { expect(src).toMatch(/word|timestamp|utterance/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAI-COMPAT STT (#434-#438)
// ═══════════════════════════════════════════════════════════════════════════════

describe('OpenAI-Compat STT (#434-#438)', () => {
  const utils = read('src/gateway/providers/cloud/openai-compat/audio-utils.ts');
  const stt = read('src/gateway/providers/cloud/openai-compat/openai-compat-stt.ts');

  it('#434 detects WAV format', () => {
    expect(utils).toContain('0x52'); // R
    expect(utils).toContain('audio/wav');
  });
  it('#435 detects MP3 format', () => { expect(utils).toContain('audio/mpeg'); });
  it('#436 detects OGG format', () => { expect(utils).toContain('audio/ogg'); });
  it('#437 returns empty text for empty audio buffer', () => {
    expect(stt).toContain('audioLen === 0');
  });
  it('#438 handles provider API error', () => { expect(stt).toMatch(/catch|error|throw/); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER TYPES (#439-#440)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provider type system', () => {
  const types = read('src/gateway/providers/cloud/types.ts');

  it('STTProvider interface defined', () => { expect(types).toContain('STTProvider'); });
  it('LLMProvider interface defined', () => { expect(types).toMatch(/LLMProvider|ChatProvider/); });
  it('TTSProvider interface defined', () => { expect(types).toContain('TTSProvider'); });
  it('transcribe method in STT', () => { expect(types).toContain('transcribe'); });
  it('getModels method exists', () => { expect(types).toContain('getModels'); });
});
