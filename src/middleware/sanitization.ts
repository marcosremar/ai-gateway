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
 * Sanitize an API key for logging (mask all but first/last chars).
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
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
    // Command injection
    /[`$(){}]/,
    // Path traversal
    /\.\.\//,
    // XSS
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
  ];

  return patterns.some((pattern) => pattern.test(input));
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
