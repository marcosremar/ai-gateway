/**
 * Example Service Manifest for babelcast-subtitle
 * 
 * This file should be served at GET /v1/manifest by the GPU service.
 * It enables automatic registration as an AI provider in the gateway.
 * 
 * For FastAPI (babelcast-subtitle), add this endpoint to server.py:
 * 
 * @app.get("/v1/manifest")
 * async def get_manifest():
 *     return {
 *         "id": "babelcast-subtitle",
 *         "name": "BabelCast Subtitle",
 *         "version": "1.0.0",
 *         "capabilities": ["stt", "llm"],
 *         "api": {
 *             "stt": {
 *                 "endpoint": "/v1/audio/transcriptions",
 *                 "method": "POST",
 *                 "model": "whisper-large-v3",
 *                 "contentType": "multipart/form-data",
 *                 "responseFormat": "json"
 *             },
 *             "llm": {
 *                 "endpoint": "/v1/translate/text",
 *                 "method": "POST",
 *                 "type": "translation",
 *                 "contentType": "application/json",
 *                 "responseFormat": "json"
 *             }
 *         },
 *         "models": ["whisper-large-v3", "translation-gemma-4b"],
 *         "latencyTargets": {
 *             "stt": 500,
 *             "llm": 1000
 *         },
 *         "healthEndpoint": "/health",
 *         "docsUrl": "/docs"
 *     }
 */

export const babelcastSubtitleManifest = {
  id: 'babelcast-subtitle',
  name: 'BabelCast Subtitle',
  version: '1.0.0',
  capabilities: ['stt', 'llm'],
  api: {
    stt: {
      endpoint: '/v1/audio/transcriptions',
      method: 'POST',
      model: 'whisper-large-v3',
      contentType: 'multipart/form-data',
      responseFormat: 'json',
    },
    llm: {
      endpoint: '/v1/translate/text',
      method: 'POST',
      type: 'translation',
      contentType: 'application/json',
      responseFormat: 'json',
    },
  },
  models: ['whisper-large-v3', 'translation-gemma-4b'],
  latencyTargets: {
    stt: 500,
    llm: 1000,
  },
  healthEndpoint: '/health',
  docsUrl: '/docs',
  metadata: {
    gpu: {
      minVramGb: 16,
      recommendedVramGb: 24,
    },
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    author: 'BabelCast Team',
    license: 'MIT',
  },
};

/**
 * Example: Simple vLLM service manifest
 */
export const vllmServiceManifest = {
  id: 'vllm-generic',
  name: 'vLLM Inference Server',
  version: '0.5.0',
  capabilities: ['llm'],
  api: {
    llm: {
      endpoint: '/v1/chat/completions',
      method: 'POST',
      model: 'meta-llama/Llama-3-8B-Instruct',
      contentType: 'application/json',
      responseFormat: 'stream',
    },
  },
  models: ['meta-llama/Llama-3-8B-Instruct'],
  latencyTargets: {
    llm: 2000,
  },
  healthEndpoint: '/health',
  metadata: {
    gpu: {
      minVramGb: 24,
      recommendedVramGb: 48,
    },
    dockerImage: 'vllm/vllm-openai:latest',
    author: 'vLLM Team',
    license: 'Apache-2.0',
  },
};

/**
 * Example: Whisper + TTS service manifest
 */
export const sttTtsServiceManifest = {
  id: 'speech-pipeline',
  name: 'Speech Pipeline (STT + TTS)',
  version: '2.1.0',
  capabilities: ['stt', 'tts'],
  api: {
    stt: {
      endpoint: '/v1/audio/transcriptions',
      method: 'POST',
      model: 'whisper-large-v3',
      contentType: 'multipart/form-data',
      responseFormat: 'json',
    },
    tts: {
      endpoint: '/v1/audio/speech',
      method: 'POST',
      model: 'kokoro-v1',
      contentType: 'application/json',
      responseFormat: 'binary',
    },
  },
  models: ['whisper-large-v3', 'kokoro-v1'],
  latencyTargets: {
    stt: 300,
    tts: 500,
  },
  healthEndpoint: '/health',
  metadata: {
    gpu: {
      minVramGb: 8,
      recommendedVramGb: 16,
    },
    dockerImage: 'user/speech-pipeline:latest',
    author: 'Speech Team',
    license: 'MIT',
  },
};
