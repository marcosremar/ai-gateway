/**
 * Route-entry ids of the gateway's own speech server (`docker/kokoro-stream`, see route-tts.ts). No imports: the
 * routing core reads them.
 */

export const KOKORO_STREAM_PROVIDER = 'kokoro-stream';
export const POCKET_PROVIDER = 'pocket';
export const OWN_SPEECH_PROVIDERS: ReadonlySet<string> = new Set([KOKORO_STREAM_PROVIDER, POCKET_PROVIDER]);
export const isOwnSpeechProvider = (providerId: string): boolean => OWN_SPEECH_PROVIDERS.has(providerId);

/** Env var whose presence mounts each one (named in the 503 when it is missing). */
export const OWN_SPEECH_KEY_ENV: Readonly<Record<string, string>> = {
  [KOKORO_STREAM_PROVIDER]: 'KOKORO_STREAM_API_KEY',
  [POCKET_PROVIDER]: 'POCKET_TTS_API_KEY',
};

/**
 * Time to the FIRST audio before the next link starts in parallel (`OWN_TTS_HEDGE_MS`), and before this one is given
 * up (`OWN_TTS_TIMEOUT_MS`). The server is next to the gateway and starts speaking in ~0.15–0.4 s (docs/rooms.md);
 * past 1.5 s it is overloaded or stuck, and the cloud link behind it still has ~6 s of the 8 s TTS budget.
 */
export const OWN_TTS_HEDGE_MS = 1_500;
export const OWN_TTS_TIMEOUT_MS = 4_000;
