/**
 * Pure helpers for tracking `URL.createObjectURL` blobs (#951).
 *
 * Playground stores a per-message `audioUrl` (an object URL) for TTS/recording
 * playback, but `handleClear` (`setMessages([])`) dropped the references without
 * `URL.revokeObjectURL`, leaking blob memory over a long session. The collection
 * logic is extracted here as a pure function so the revoke pass is unit-testable
 * and reusable on clear + unmount.
 */

/** An object that may carry a revocable object URL. */
export interface HasAudioUrl {
  audioUrl?: string;
}

/**
 * Collect the distinct, truthy `audioUrl`s from a list of messages (#951).
 *
 * De-duplicates so the same blob URL isn't revoked twice. Pure.
 */
export function collectObjectUrls(items: ReadonlyArray<HasAudioUrl>): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.audioUrl) seen.add(item.audioUrl);
  }
  return [...seen];
}

/**
 * Revoke every object URL produced by {@link collectObjectUrls}.
 *
 * Tolerates a missing/odd `URL` (SSR / tests) and never throws. The `revoke`
 * function is injectable for testing without a DOM.
 */
export function revokeObjectUrls(
  items: ReadonlyArray<HasAudioUrl>,
  revoke: (url: string) => void = defaultRevoke,
): void {
  for (const url of collectObjectUrls(items)) {
    try {
      revoke(url);
    } catch {
      // Best-effort cleanup — a failed revoke must not break clear/unmount.
    }
  }
}

function defaultRevoke(url: string): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}
