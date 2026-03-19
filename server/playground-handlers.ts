// ── BabelCast Gateway — Playground HTTP Handlers ──────────────────────────────
// Interactive model testing endpoints for all AI capabilities.
//
// GET  /v1/playground/catalog     — list all models grouped by capability
// POST /v1/playground/stt         — test STT with audio
// POST /v1/playground/llm         — test LLM chat completion
// POST /v1/playground/tts         — test TTS synthesis
// POST /v1/playground/pipeline    — test full STT→LLM→TTS pipeline

import type { IncomingMessage, ServerResponse } from 'http';
import {
  getOrCreateRequestId, setRequestIdHeader, readJsonBody, readRawBody,
  handleBodyError, validateLang, langNames,
} from './http-utils';
import { logRequest } from './metrics';
import {
  registry, client,
  groqAvailable, openaiAvailable, deepgramAvailable, fireworksAvailable,
  openrouterAvailable, ollamaAvailable, whisperAvailable, elevenlabsAvailable,
  groqSttModel, groqLlmModel, groqTtsModel, groqTtsVoice,
  ollamaModel,
} from './providers';
import { deployState, isGpuAvailable, gpuModelWarmth } from './state';
import type { ProviderCapability } from '../src/providers/types';
import type { AIProfile } from '../src/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogProvider {
  id: string;
  name: string;
  description: string;
  available: boolean;
  capabilities: ProviderCapability[];
}

interface CatalogModel {
  id: string;
  name: string;
  description: string;
  providerId: string;
  isDefault?: boolean;
  streaming?: boolean;  // STT only — true if provider supports WebSocket streaming
  metadata?: Record<string, unknown>;
}

interface CatalogVoice {
  id: string;
  name: string;
  description?: string;
  providerId: string;
}

interface CatalogCapability {
  models: CatalogModel[];
  voices?: CatalogVoice[];
}

// ── GET /v1/playground/catalog ─────────────────────────────────────────────────

export async function handlePlaygroundCatalog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  // Provider availability map
  const providerAvailability: Record<string, boolean> = {
    groq: groqAvailable,
    openai: openaiAvailable,
    deepgram: deepgramAvailable,
    fireworks: fireworksAvailable,
    openrouter: openrouterAvailable,
    ollama: ollamaAvailable,
    elevenlabs: elevenlabsAvailable,
    modal: true, // Modal TTS doesn't require API key
  };

  // Build providers list
  const allProviders = registry.listProviders();
  const providers: CatalogProvider[] = allProviders.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    available: providerAvailability[p.id] ?? false,
    capabilities: p.capabilities,
  }));

  // Build capabilities catalog
  const capabilities: Record<string, CatalogCapability> = {};

  // STT providers that support WebSocket streaming (real-time audio)
  const streamingSttProviders = new Set(['gpu', 'fireworks']);

  for (const cap of ['stt', 'tts', 'llm'] as ProviderCapability[]) {
    const models = registry.getAllModels(cap);
    const capEntry: CatalogCapability = {
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        providerId: m.providerId,
        isDefault: m.isDefault,
        ...(m.metadata && { metadata: m.metadata }),
        ...(cap === 'stt' && { streaming: streamingSttProviders.has(m.providerId) }),
      })),
    };

    // Add voices for TTS
    if (cap === 'tts') {
      const voices: CatalogVoice[] = [];
      for (const p of registry.listProvidersByCapability('tts')) {
        if (p.tts) {
          for (const v of p.tts.getVoices()) {
            voices.push({
              id: v.id,
              name: v.name,
              description: v.description,
              providerId: p.id,
            });
          }
        }
      }
      capEntry.voices = voices;
    }

    capabilities[cap] = capEntry;
  }

  // GPU status
  const gpu = {
    available: isGpuAvailable(),
    endpoint: deployState.endpoint || null,
    status: deployState.status,
    gpuType: deployState.gpuType || null,
    warmth: {
      stt: gpuModelWarmth.stt,
      llm: gpuModelWarmth.llm,
      tts: gpuModelWarmth.tts,
    },
  };

  // Streaming STT providers (for Python app's SttChainWidget)
  const streamingStt = {
    providers: [
      {
        id: 'gpu',
        name: 'GPU Streaming',
        available: deployState.status === 'ready' && !!deployState.endpoint,
        type: 'streaming',
      },
      {
        id: 'fireworks',
        name: 'Fireworks AI',
        available: !!process.env.FIREWORKS_API_KEY,
        type: 'streaming',
      },
      {
        id: 'groq',
        name: 'Groq Batch',
        available: groqAvailable,
        type: 'batch',
      },
    ],
  };

  // Defaults (what the gateway is currently configured to use)
  const defaults = {
    stt: { provider: groqAvailable ? 'groq' : 'ollama', model: groqAvailable ? groqSttModel : 'whisper-large-v3-turbo' },
    llm: { provider: groqAvailable ? 'groq' : 'ollama', model: groqAvailable ? groqLlmModel : ollamaModel },
    tts: { provider: groqAvailable ? 'groq' : (openaiAvailable ? 'openai' : null), model: groqAvailable ? groqTtsModel : 'gpt-4o-mini-tts', voice: groqTtsVoice },
  };

  // Available languages
  const languages = Object.entries(langNames).map(([code, name]) => ({ code, name }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ providers, capabilities, gpu, streamingStt, defaults, languages }));
}

// ── POST /v1/playground/stt ───────────────────────────────────────────────────

export async function handlePlaygroundStt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const bodyResult = readRawBody(req, res);
  if (!bodyResult) return; // 413 already sent
  const audioBuffer = await bodyResult;

  if (!audioBuffer.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No audio data in request body' }));
    return;
  }

  // Parse query params
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const provider = url.searchParams.get('provider') || undefined;
  const model = url.searchParams.get('model') || undefined;
  const language = url.searchParams.get('language') || undefined;

  // Build profile override
  const profile: AIProfile = {};
  if (provider && model) {
    profile.stt = [{ provider, model }];
  } else if (provider) {
    profile.stt = [{ provider }];
  }
  // Always set language to override the default profile's 'fr' (translation default).
  // undefined = Whisper auto-detects the language.
  profile.language = language;

  // Inject API keys
  profile.keys = buildKeysMap();

  try {
    const t0 = Date.now();
    const result = await client.transcribe(audioBuffer, profile);
    const latencyMs = Date.now() - t0;

    logRequest({ timestamp: Date.now(), stage: 'stt', provider: result.provider as any, model: result.model, latencyMs, success: true, inputSize: audioBuffer.length, outputPreview: result.text?.slice(0, 80) });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      text: result.text,
      language: result.language,
      duration: result.duration,
      words: result.words,
      provider: result.provider,
      model: result.model,
      fallbackUsed: result.fallbackUsed,
      latencyMs,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ── POST /v1/playground/llm ───────────────────────────────────────────────────

export async function handlePlaygroundLlm(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array is required' }));
    return;
  }

  const provider = body.provider as string | undefined;
  const model = body.model as string | undefined;
  const temperature = body.temperature as number | undefined;
  const maxTokens = body.max_tokens as number | undefined;
  const systemPrompt = body.system_prompt as string | undefined;

  // Build profile override
  const profile: AIProfile = {};
  if (provider && model) {
    profile.llm = [{ provider, model }];
  } else if (provider) {
    profile.llm = [{ provider }];
  }
  if (temperature !== undefined) profile.temperature = temperature;
  if (maxTokens !== undefined) profile.maxTokens = maxTokens;
  profile.keys = buildKeysMap();

  // Prepend system prompt if provided and not already in messages
  const chatMessages = [...messages];
  if (systemPrompt && (!chatMessages.length || chatMessages[0].role !== 'system')) {
    chatMessages.unshift({ role: 'system', content: systemPrompt });
  }

  try {
    const t0 = Date.now();
    const result = await client.chat(
      chatMessages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      profile,
    );
    const latencyMs = Date.now() - t0;

    logRequest({ timestamp: Date.now(), stage: 'llm', provider: result.provider as any, model: result.model, latencyMs, success: true, outputPreview: result.content?.slice(0, 80), inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: result.content,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      fallbackUsed: result.fallbackUsed,
      latencyMs,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ── POST /v1/playground/tts ───────────────────────────────────────────────────

export async function handlePlaygroundTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const text = body.text as string | undefined;
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }

  const provider = body.provider as string | undefined;
  const model = body.model as string | undefined;
  const voice = body.voice as string | undefined;
  const audioFormat = body.audio_format as string | undefined;
  const instructions = body.instructions as string | undefined;

  // Build profile override
  const profile: AIProfile = {};
  if (provider && model) {
    profile.tts = [{ provider, model }];
  } else if (provider) {
    profile.tts = [{ provider }];
  }
  if (voice) profile.voice = voice;
  if (audioFormat) profile.audioFormat = audioFormat as AIProfile['audioFormat'];
  if (instructions) profile.voiceInstructions = instructions;
  profile.keys = buildKeysMap();

  try {
    const t0 = Date.now();
    const result = await client.synthesize(text, profile);
    const latencyMs = Date.now() - t0;

    logRequest({ timestamp: Date.now(), stage: 'tts', provider: result.provider as any, model: result.model, latencyMs, success: true, outputPreview: `${result.audio.length} bytes` });

    // Return audio as base64 + metadata (JSON response for playground testing)
    const returnAudio = body.return_audio !== false; // default true
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      provider: result.provider,
      model: result.model,
      contentType: result.contentType,
      audioSizeBytes: result.audio.length,
      ...(returnAudio && { audioBase64: result.audio.toString('base64') }),
      fallbackUsed: result.fallbackUsed,
      latencyMs,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ── POST /v1/playground/pipeline ──────────────────────────────────────────────

export async function handlePlaygroundPipeline(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const bodyResult = readRawBody(req, res);
  if (!bodyResult) return;
  const rawBody = await bodyResult;

  if (!rawBody.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No audio data in request body' }));
    return;
  }

  // Parse query params
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const sourceLang = url.searchParams.get('source') || undefined;
  const targetLang = url.searchParams.get('target') || 'en';
  const voice = url.searchParams.get('voice') || undefined;
  const sttProvider = url.searchParams.get('stt_provider') || undefined;
  const llmProvider = url.searchParams.get('llm_provider') || undefined;
  const ttsProvider = url.searchParams.get('tts_provider') || undefined;

  // Build profile
  const profile: AIProfile = { language: targetLang };
  if (sttProvider) profile.stt = [{ provider: sttProvider }];
  if (llmProvider) profile.llm = [{ provider: llmProvider }];
  if (ttsProvider) profile.tts = [{ provider: ttsProvider }];
  if (voice) profile.voice = voice;
  profile.keys = buildKeysMap();

  const systemPrompt = `You are a real-time translator. Translate the following from ${sourceLang || 'auto-detected language'} to ${langNames[targetLang] || targetLang}. Output ONLY the translation, nothing else.`;

  try {
    const result = await client.pipeline(rawBody, systemPrompt, [], Object.keys(profile).length > 1 ? profile : undefined);

    // Log per-stage metrics
    logRequest({ timestamp: Date.now(), stage: 'stt', provider: result.stt.provider as any, model: result.stt.model, latencyMs: result.stt.latencyMs, success: true, inputSize: rawBody.length, outputPreview: result.stt.text?.slice(0, 80) });
    logRequest({ timestamp: Date.now(), stage: 'llm', provider: result.chat.provider as any, model: result.chat.model, latencyMs: result.chat.latencyMs, success: true, outputPreview: result.chat.content?.slice(0, 80), inputTokens: result.chat.usage?.promptTokens, outputTokens: result.chat.usage?.completionTokens });
    logRequest({ timestamp: Date.now(), stage: 'tts', provider: result.tts.provider as any, model: result.tts.model, latencyMs: result.tts.latencyMs, success: true, outputPreview: `${result.tts.audio.length} bytes` });
    logRequest({ timestamp: Date.now(), stage: 'pipeline', provider: (result.usedGpu ? 'gpu' : result.stt.provider) as any, latencyMs: result.totalLatencyMs, success: true, inputSize: rawBody.length, outputPreview: result.chat.content?.slice(0, 80) });

    const returnAudio = url.searchParams.get('return_audio') !== 'false';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      transcription: result.stt.text,
      translation: result.chat.content,
      stt: {
        text: result.stt.text,
        language: result.stt.language,
        provider: result.stt.provider,
        model: result.stt.model,
        latencyMs: result.stt.latencyMs,
      },
      llm: {
        content: result.chat.content,
        provider: result.chat.provider,
        model: result.chat.model,
        latencyMs: result.chat.latencyMs,
      },
      tts: {
        provider: result.tts.provider,
        model: result.tts.model,
        contentType: result.tts.contentType,
        audioSizeBytes: result.tts.audio.length,
        ...(returnAudio && { audioBase64: result.tts.audio.toString('base64') }),
        latencyMs: result.tts.latencyMs,
      },
      usedGpu: result.usedGpu,
      totalLatencyMs: result.totalLatencyMs,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build keys map from environment for profile overrides. */
function buildKeysMap(): Record<string, string> {
  const keys: Record<string, string> = {};
  if (process.env.GROQ_API_KEY) keys.groq = process.env.GROQ_API_KEY;
  if (process.env.OPENAI_API_KEY) keys.openai = process.env.OPENAI_API_KEY;
  if (process.env.DEEPGRAM_API_KEY) keys.deepgram = process.env.DEEPGRAM_API_KEY;
  if (process.env.FIREWORKS_API_KEY) keys.fireworks = process.env.FIREWORKS_API_KEY;
  if (process.env.OPENROUTER_API_KEY) keys.openrouter = process.env.OPENROUTER_API_KEY;
  return keys;
}
