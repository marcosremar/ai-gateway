/**
 * GatewaySDK quickstart (#886) — a minimal "transcribe → translate → tts"
 * walkthrough using the canonical TypeScript HTTP client.
 *
 * The existing examples (hello_gpu.py, tts_service.py, …) are SnapGPU
 * `@app.cls` decorators — a *different* product. This is the missing
 * working starting point for the gateway's own SDK.
 *
 * Run (with a gateway reachable at $AI_GATEWAY_URL, default localhost:4000):
 *   bun run examples/gateway_sdk_quickstart.ts path/to/audio.wav
 *
 * Zero-config: `GatewaySDK.fromEnv()` mirrors the CLI's URL/key discovery
 * (AI_GATEWAY_URL > GATEWAY_URL > PORT), so no hardcoded baseUrl is required.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { GatewaySDK } from '../src/sdk/client';

async function main() {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error('usage: bun run examples/gateway_sdk_quickstart.ts <audio.wav>');
    process.exit(2);
  }

  // Zero-config construction from the environment (#824).
  const gw = GatewaySDK.fromEnv();

  // 1) Speech-to-text (GPU-aware: the gateway picks GPU or cloud).
  const audio = new Uint8Array(readFileSync(audioPath));
  const { text, usedGpu } = await gw.transcribe(audio, 'fr');
  console.log(`transcription (gpu=${usedGpu}): ${text}`);

  // 2) Translate fr → en.
  const { translatedText } = await gw.translate(text, 'fr', 'en');
  console.log(`translation: ${translatedText}`);

  // 3) Text-to-speech of the translation → out.wav.
  const tts = await gw.generateAudio(translatedText, { speaker: 'Ryan' });
  writeFileSync('out.wav', tts.audio);
  console.log(`wrote out.wav (${tts.audio.length} bytes)`);

  // 4) Streaming chat (#831) — token-by-token, same UX as the CLI.
  process.stdout.write('chat: ');
  for await (const chunk of gw.chatStream([{ role: 'user', content: 'Say OK only.' }])) {
    if (chunk.content) process.stdout.write(chunk.content);
  }
  process.stdout.write('\n');

  await gw.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
