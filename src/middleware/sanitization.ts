/**
 * Input sanitization middleware.
 *
 * Protects against injection attacks in user-provided strings
 * (prompts, model names, language codes, etc.).
 *
 * Sanitization rules:
 * - Strip control characters (except newlines/tabs)
 * - Limit string length
 * - Escape HTML entities
 * - Block known injection patterns
 */

/**
 * Sanitize a string for safe use in prompts and system messages.
 *
 * Removes control characters, limits length, and escapes HTML.
 */
export function sanitizePrompt(input: string, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 4096;

  return (
    input
      .slice(0, maxLength)
      // Strip control characters (keep newlines, tabs, carriage returns)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Escape HTML entities to prevent XSS in rendered output
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
  );
}

/**
 * Sanitize a model name for safe use in provider API calls.
 *
 * Only allows alphanumeric characters, hyphens, underscores, dots, and slashes.
 */
export function sanitizeModelName(input: string): string {
  return input.replace(/[^a-zA-Z0-9\-_./]/g, '').slice(0, 256);
}

/**
 * Sanitize a language code.
 *
 * Only allows ISO 639-1 style codes (2-3 lowercase letters) with optional region.
 */
export function sanitizeLanguageCode(input: string): string | null {
  const match = input.match(/^[a-z]{2,3}(-[A-Z]{2})?$/);
  return match ? match[0] : null;
}

/**
 * Sanitize a user ID.
 *
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
export function sanitizeUserId(input: string): string {
  return input.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 128);
}

/**
 * Strip control characters (and, by default, line breaks) from a string that
 * will be forwarded to a downstream service, header, or log line.
 *
 * Control chars / CR / LF in a user-influenced value enable header- and
 * log-injection (e.g. CRLF splitting, forging a fake log entry). This keeps
 * ordinary printable text intact and only removes the dangerous bytes.
 *
 * @param input  the raw string
 * @param opts.keepNewlines  when true, preserves `\n`/`\r`/`\t` (for prompt-
 *   like multi-line text); default false (single-line fields: names, ids).
 * @param opts.maxLength  optional length cap (applied after stripping).
 */
export function stripControlChars(
  input: string,
  opts: { keepNewlines?: boolean; maxLength?: number } = {},
): string {
  // Without keepNewlines, also remove \t (\x09), \n (\x0A), \r (\x0D).
  const pattern = opts.keepNewlines
    ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g
    : /[\x00-\x1F\x7F]/g;
  let out = input.replace(pattern, '');
  if (opts.maxLength != null && out.length > opts.maxLength) {
    out = out.slice(0, opts.maxLength);
  }
  return out;
}

/**
 * Sanitize a user-supplied filename so it can't be used for path traversal or
 * header/log injection when later used in a path, Content-Disposition header,
 * or log line.
 *
 * - Drops any directory component (`../`, `/`, `\`) — only the basename remains.
 * - Removes control characters and path separators.
 * - Collapses a name that reduces to empty / `.` / `..` to a safe placeholder.
 * - Caps length (default 255, the common filesystem limit).
 */
export function sanitizeFilename(input: string, maxLength = 255): string {
  // Take the last path segment for either separator style; this neutralizes
  // `../../etc/passwd` and `..\\..\\windows` before any further processing.
  const base = input.split(/[\\/]/).pop() ?? '';
  // Remove control chars and anything that is a path separator or NUL.
  let cleaned = base.replace(/[\x00-\x1F\x7F/\\]/g, '').trim();
  // A name that is empty or only dots ("." / "..") is unsafe/meaningless.
  if (cleaned === '' || /^\.+$/.test(cleaned)) cleaned = 'file';
  if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
  return cleaned;
}

/**
 * Sanitize an API key for logging (mask all but first/last chars).
 */
export function maskApiKey(key: string): string {
  // The prefix+suffix scheme exposes 8 chars (4 leading + 4 trailing).
  // For keys shorter than 12 the prefix and suffix would overlap,
  // exposing far more than half of the secret (e.g. 8 of 9 chars).
  // Collapse to "***" until the key is long enough for safe masking.
  if (key.length < 12) return '***';
  // Additionally cap the TOTAL revealed characters to <=25% of the key length.
  // A flat 8-char reveal exposes 2/3 of a 12-char key; for shorter-but-eligible
  // keys we trim the visible window so the masked form never leaks more than a
  // quarter of the secret. `reveal` is split across prefix/suffix.
  const maxReveal = Math.floor(key.length * 0.25);
  const each = Math.max(1, Math.min(4, Math.floor(maxReveal / 2)));
  return `${key.slice(0, each)}***${key.slice(-each)}`;
}

/**
 * Normalize text for keyword/injection matching so trivial obfuscation
 * (letter-spacing, punctuation insertion, common leetspeak) doesn't slip a
 * banned phrase past a substring/keyword check. This is BEST-EFFORT only — it
 * defeats `i g n o r e`, `i.g.n.o.r.e`, `1gn0r3`, but not semantic evasion;
 * real moderation needs the webhook rule to an external classifier.
 *
 * Transformations: lowercase → leetspeak digits to letters → strip everything
 * that isn't a letter (so spacing/punctuation between letters collapses).
 */
export function normalizeForKeywordMatch(input: string): string {
  const leet: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
  return input
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => leet[c] ?? c)
    .replace(/[^a-z]/g, '');
}

/**
 * Detect potential prompt injection patterns.
 *
 * Returns true if the input contains suspicious patterns
 * that might indicate an injection attempt.
 */
export function detectInjection(input: string): boolean {
  const patterns = [
    // System prompt injection attempts
    /ignore previous instructions/i,
    /ignore all previous/i,
    /you are now /i,
    /system prompt:/i,
    /developer mode/i,
    /DAN mode/i,
    // SQL injection
    /['"];\s*(DROP|DELETE|UPDATE|INSERT)/i,
    // Command injection — backticks or shell expansion `$(...)` / `${...}`.
    // Plain `{` or `}` was previously matched, flagging every JSON body
    // (effectively false-positive on every API call). Tighten to actual
    // shell-meta sequences only.
    /[`]|\$\(|\$\{/,
    // Path traversal
    /\.\.\//,
    // XSS
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
  ];

  if (patterns.some((pattern) => pattern.test(input))) return true;

  // Second pass: catch the highest-signal instruction-override phrases even
  // when obfuscated with spacing/punctuation/leetspeak (e.g. `i g n o r e
  // previous instructions`, `1gn0r3previousinstructions`). Only a short,
  // high-confidence allowlist is checked against the de-obfuscated text to
  // avoid false positives from collapsing all non-letters.
  const normalized = normalizeForKeywordMatch(input);
  const OBFUSCATION_RESISTANT_PHRASES = [
    'ignorepreviousinstructions',
    'ignoreallprevious',
    'ignoreallinstructions',
    'developermode',
    'danmode',
  ];
  return OBFUSCATION_RESISTANT_PHRASES.some((p) => normalized.includes(p));
}

/**
 * Sanitize and validate all fields in a request object.
 *
 * Returns a sanitized copy or throws if validation fails.
 */
export function sanitizeRequest<T extends Record<string, unknown>>(
  request: T,
  rules: {
    [K in keyof T]?: {
      sanitize?: (value: unknown) => unknown;
      required?: boolean;
      maxLength?: number;
    };
  },
): T {
  const sanitized = { ...request } as T;

  for (const [key, rule] of Object.entries(rules)) {
    if (!rule) continue;
    const value = request[key as keyof T];

    if (rule.required && (value === undefined || value === null)) {
      throw new Error(`Required field missing: ${key}`);
    }

    if (value !== undefined && value !== null) {
      if (rule.sanitize) {
        (sanitized as Record<string, unknown>)[key] = rule.sanitize(value);
      }

      if (rule.maxLength && typeof (sanitized as Record<string, unknown>)[key] === 'string') {
        const str = (sanitized as Record<string, unknown>)[key] as string;
        if (str.length > rule.maxLength) {
          (sanitized as Record<string, unknown>)[key] = str.slice(0, rule.maxLength);
        }
      }
    }
  }

  return sanitized;
}
