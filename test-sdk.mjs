import { createAIClient, SPEECH_TO_SPEECH_PROFILE, initVaultFromEnv } from './src/index.js';
import { AIProviderRegistry } from './src/providers/registry.js';

// Import all providers to register them
import './src/providers/groq/index.js';
import './src/providers/openai/index.js';
import './src/providers/openrouter/index.js';
import './src/providers/fireworks/index.js';
import './src/providers/self-hosted/index.js';
import './src/providers/modal-tts/index.js';

import 'dotenv/config';

initVaultFromEnv();

const registry = new AIProviderRegistry();
const client = createAIClient({
  registry,
  defaultProfile: SPEECH_TO_SPEECH_PROFILE,
});

console.log('=== Testing AI Gateway SDK ===\n');

console.log('Providers registered:', registry.listProviders().map(p => p.id).join(', '));

console.log('\n1. Testing STT (Groq)...');
try {
  const audio = Buffer.from('test audio data');
  const stt = await client.transcribe(audio, { preset: 'speech-to-speech' });
  console.log('   STT OK:', stt.provider, stt.latencyMs, 'ms');
} catch (e) {
  console.error('   STT FAILED:', e.message);
}

console.log('\n2. Testing LLM (Groq)...');
try {
  const chat = await client.chat(
    [{ role: 'user', content: 'Hello' }],
    { preset: 'speech-to-speech' }
  );
  console.log('   LLM OK:', chat.provider, chat.latencyMs, 'ms');
  console.log('   Response:', chat.content.slice(0, 100) + '...');
} catch (e) {
  console.error('   LLM FAILED:', e.message);
}

console.log('\n3. Testing TTS (Groq)...');
try {
  const tts = await client.synthesize('Hello world', { preset: 'speech-to-speech' });
  console.log('   TTS OK:', tts.provider, tts.latencyMs, 'ms');
  console.log('   Audio size:', tts.audio.length, 'bytes');
} catch (e) {
  console.error('   TTS FAILED:', e.message);
}

console.log('\n=== Done ===');
