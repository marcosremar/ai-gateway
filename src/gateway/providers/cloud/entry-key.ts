/**
 * Health key of a fallback chain entry.
 *
 * Entries that point at different endpoints of the same provider/model are replicas (e.g. three Qwen3-TTS servers).
 * Each replica must fail, cool down, time out and rank on its own: keyed by provider alone, one dead replica
 * would put its healthy siblings into cooldown and open their shared circuit breaker. Entries without an
 * endpoint keep the plain provider id, so existing chains behave exactly as before.
 *
 * Credit blocks stay keyed by provider: credit belongs to the account, not to a server.
 */
import type { FallbackEntry } from './fallback';

export function entryHealthKey(entry: Pick<FallbackEntry, 'provider' | 'endpoint'>): string {
  return entry.endpoint ? `${entry.provider}@${entry.endpoint}` : entry.provider;
}
