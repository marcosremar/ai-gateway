/**
 * Centralized maskKey utility.
 *
 * Fixes: #132 (duplicated maskKey in 3+ files)
 *
 * Usage:
 * ```ts
 * import { maskKey } from './mask-key';
 *
 * console.log(maskKey('gsk_abc123def456')); // 'gsk_***f456'
 * ```
 */

/**
 * Mask an API key for safe logging — shows first 4 and last 4 chars.
 *
 * @example
 * ```ts
 * maskKey('gsk_abc123def456ghi789') → 'gsk_***i789'
 * maskKey('short') → '***'
 * maskKey('') → '***'
 * ```
 */
export function maskKey(key: string | undefined | null): string {
  if (!key || key.length <= 8) return '***';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

/**
 * Mask multiple keys in an object.
 */
export function maskKeys(
  obj: Record<string, string | undefined | null>,
  keysToMask: string[] = Object.keys(obj),
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keysToMask) {
    result[key] = maskKey(obj[key]);
  }
  return result;
}
