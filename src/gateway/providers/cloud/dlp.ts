/**
 * DLP - Data Loss Prevention for AI requests and responses.
 * 
 * Similar to Cloudflare AI Gateway DLP:
 * - Detects PII: credit cards, SSN, emails, phone numbers
 * - Custom patterns via regex
 * - Actions: flag, block
 * - Compliance support (GDPR, HIPAA, PCI DSS)
 */

import { z } from 'zod';

export interface DLPConfig {
  /** Enable/disable DLP */
  enabled: boolean;
  /** Built-in patterns to detect */
  patterns: {
    /** Credit card numbers */
    creditCard?: boolean;
    /** Social Security Numbers */
    ssn?: boolean;
    /** Email addresses */
    email?: boolean;
    /** Phone numbers */
    phone?: boolean;
    /** IP addresses */
    ipAddress?: boolean;
    /** Date of birth patterns */
    dateOfBirth?: boolean;
  };
  /** Custom regex patterns */
  customPatterns?: Array<{
    name: string;
    pattern: string;
    /** Description for logging */
    description?: string;
  }>;
  /** Action when PII is detected */
  action: 'flag' | 'block' | 'allow';
  /** Minimum matches before triggering (default: 1) */
  minMatches?: number;
}

export interface DLPResult {
  /** Whether PII was detected */
  detected: boolean;
  /** Types of PII that were found */
  types: string[];
  /** Matches with their positions and values */
  matches: DLPMatch[];
  /** Action taken */
  action: 'flag' | 'block' | 'allow';
}

export interface DLPMatch {
  /** Type of PII detected */
  type: string;
  /** The matched value (masked for security) */
  value: string;
  /** Original value (only in debug mode) */
  original?: string;
  /** Start position in text */
  start: number;
  /** End position in text */
  end: number;
}

export interface DLPOptions {
  /** Override global config for this request */
  enabled?: boolean;
  /** Custom patterns for this request */
  patterns?: Partial<DLPConfig['patterns']>;
  /** Skip DLP for this request */
  skip?: boolean;
  /** Return original values (for debugging) */
  includeOriginal?: boolean;
  /** Gate credit-card matches behind a Luhn checksum to cut false positives
   *  on order IDs / timestamps (#681). Opt-in (default off for back-compat). */
  luhnValidate?: boolean;
}

// Built-in regex patterns
const PATTERNS = {
  // Credit Card - major brands (Visa, Mastercard, Amex, Discover)
  creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  
  // SSN - US Social Security Number (XXX-XX-XXXX)
  ssn: /\b(?!000|666|9\d{2})[0-9]{3}[-\s]?(?!00)[0-9]{2}[-\s]?(?!0000)[0-9]{4}\b/g,
  
  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  
  // Phone numbers — require area code or country code so we don't match
  // any 7-digit number (timestamps, IDs, line numbers etc). Previously the
  // first two groups were both optional, reducing the pattern to /\d{3}-?\d{4}/
  // which had massive false-positive rate.
  phone: /\b(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)[0-9]{3}[-.\s]?[0-9]{4}\b/g,
  
  // IP addresses (IPv4)
  ipAddress: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  
  // Date of birth patterns
  dateOfBirth: /\b(?:DOB|D\.O\.B|birth.?date)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/gi,
};

// Mask value for security (show only last 4 chars)
function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Luhn (mod-10) checksum validation (#681). A random 13-16 digit run passes
 * Luhn only ~10% of the time, so gating credit-card matches behind this cuts
 * false positives on order IDs / timestamps sharply. Non-digit separators
 * (spaces, dashes) are ignored.
 *
 * @returns true iff the candidate's digits form a valid Luhn sequence.
 */
export function luhnCheck(candidate: string): boolean {
  const digits = candidate.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Default DLP configuration
 */
export const DEFAULT_DLP_CONFIG: DLPConfig = {
  enabled: false, // disabled by default
  patterns: {
    creditCard: true,
    ssn: true,
    email: true,
    phone: false,
    ipAddress: false,
    dateOfBirth: false,
  },
  action: 'flag',
  minMatches: 1,
};

/**
 * Detect PII in text.
 * 
 * @param text - Text to scan for PII
 * @param config - DLP configuration
 * @param options - Per-request options
 */
export function detectPII(
  text: string,
  config: DLPConfig = DEFAULT_DLP_CONFIG,
  options?: DLPOptions
): DLPResult {
  // Skip if disabled
  if (!config.enabled || options?.skip || options?.enabled === false) {
     return {
       detected: false,
       types: [],
       matches: [],
       action: 'flag',
     };
  }

  const detectedTypes: string[] = [];
  const matches: DLPMatch[] = [];
  
  // Determine which patterns to check
  const patternsToCheck = options?.patterns
    ? { ...config.patterns, ...options.patterns }
    : config.patterns;

  // Check each enabled pattern
  for (const [patternType, enabled] of Object.entries(patternsToCheck)) {
    if (!enabled) continue;

    const regex = PATTERNS[patternType as keyof typeof PATTERNS];
    if (!regex) continue;

    // Reset regex state
    regex.lastIndex = 0;
    
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      // Guard against zero-width matches (e.g. /a*/g) which would otherwise
      // pin lastIndex and spin forever.
      if (value.length === 0) { regex.lastIndex++; continue; }

      // #681: when Luhn gating is requested, drop credit-card "matches" whose
      // digits aren't a valid card number (cuts order-ID/timestamp FPs).
      if (options?.luhnValidate && patternType === 'creditCard' && !luhnCheck(value)) {
        continue;
      }

      detectedTypes.push(patternType);
      matches.push({
        type: patternType,
        value: maskValue(value),
        original: options?.includeOriginal ? value : undefined,
        start: match.index,
        end: match.index + value.length,
      });
    }
  }

  // Check custom patterns
  if (config.customPatterns) {
    for (const custom of config.customPatterns) {
      try {
        // ReDoS guard: reject patterns with nested quantifiers that are the
        // canonical catastrophic-backtracking shape `(...)+`, `(...){2,}`,
        // `(.*)+` etc. Operator-supplied patterns can otherwise lock the
        // event loop for seconds on adversarial input.
        if (/\([^)]*[+*][^)]*\)[+*{]/.test(custom.pattern) || /\(\.\*\)[+*]/.test(custom.pattern)) {
          continue;
        }
        // Length cap on input — even safe regex on 10MB text can churn.
        const scanText = text.length > 100_000 ? text.slice(0, 100_000) : text;
        const regex = new RegExp(custom.pattern, 'gi');
        let match: RegExpExecArray | null;
        let iterations = 0;
        const MAX_ITERS = 10_000;

        while ((match = regex.exec(scanText)) !== null) {
          if (++iterations > MAX_ITERS) break;
          const value = match[0];
          // Same zero-width guard as the built-in pattern loop above.
          if (value.length === 0) { regex.lastIndex++; continue; }

          detectedTypes.push(custom.name);
          matches.push({
            type: custom.name,
            value: maskValue(value),
            original: options?.includeOriginal ? value : undefined,
            start: match.index,
            end: match.index + value.length,
          });
        }
      } catch (e) {
        // Invalid regex, skip
        console.warn(`Invalid DLP custom pattern: ${custom.name}`, e);
      }
    }
  }

  // Check minimum matches.
  // The config field is named `minMatches` ("Minimum matches before
  // triggering"), so it must be compared against the total number of
  // matches — not the count of unique pattern types. Using unique-types
  // silently broke any threshold > 1 when the same type repeated (e.g.
  // 5 credit cards still counted as 1 type).
  const uniqueTypes = [...new Set(detectedTypes)];
  const detected = matches.length >= (config.minMatches || 1);
  
  // Determine action
  const action = detected ? config.action : 'allow';

  return {
    detected,
    types: uniqueTypes,
    matches,
    action,
  };
}

/**
 * Redact detected PII in-place (#682). Returns the text with every match
 * replaced by its masked form, so a request can proceed without leaking PII to
 * the upstream provider instead of being hard-blocked. Replacements are applied
 * right-to-left so earlier match offsets stay valid.
 *
 * @returns `{ text, result }` — the redacted text plus the underlying DLPResult.
 */
export function redactPII(
  text: string,
  config: DLPConfig = DEFAULT_DLP_CONFIG,
  options?: DLPOptions,
): { text: string; result: DLPResult } {
  // Force detection on so redaction works even when the config is flag/allow.
  const result = detectPII(text, { ...config, enabled: true, action: config.action }, options);
  if (result.matches.length === 0) return { text, result };

  let out = text;
  const ordered = [...result.matches].sort((a, b) => b.start - a.start);
  for (const m of ordered) {
    if (m.start < 0 || m.end > out.length || m.start >= m.end) continue;
    out = out.slice(0, m.start) + maskValue(out.slice(m.start, m.end)) + out.slice(m.end);
  }
  return { text: out, result };
}

/**
 * Scan both prompt and response for PII
 */
export function scanPromptAndResponse(
  prompt: string,
  response: string,
  config: DLPConfig,
  options?: DLPOptions
): {
  prompt: DLPResult;
  response: DLPResult;
  overall: DLPResult;
} {
  const promptResult = detectPII(prompt, config, options);
  const responseResult = detectPII(response, config, options);

  // Overall is flagged if either is flagged
  const overallDetected = promptResult.detected || responseResult.detected;
  const overallTypes = [...new Set([...promptResult.types, ...responseResult.types])];
  const overallMatches = [...promptResult.matches, ...responseResult.matches];
  const overallAction = overallDetected ? config.action : 'allow';

  return {
    prompt: promptResult,
    response: responseResult,
    overall: {
      detected: overallDetected,
      types: overallTypes,
      matches: overallMatches,
      action: overallAction,
    },
  };
}

/**
 * Create DLP middleware for HTTP requests
 */
export function createDLPMiddleware(config: DLPConfig) {
  return {
    /**
     * Scan request body for PII
     */
    scanRequest: (body: unknown, options?: DLPOptions): DLPResult => {
      let text = '';
      
      if (typeof body === 'string') {
        text = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        // Extract text from messages
        if (Array.isArray(b.messages)) {
          text = b.messages
            .map((m: { content?: string }) => m.content)
            .filter(Boolean)
            .join(' ');
        } else if (b.prompt) {
          text = String(b.prompt);
        }
      }

      return detectPII(text, config, options);
    },

    /**
     * Scan response body for PII
     */
    scanResponse: (body: unknown, options?: DLPOptions): DLPResult => {
      let text = '';

      if (typeof body === 'string') {
        text = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        if (b.choices && Array.isArray(b.choices)) {
          text = b.choices
            .map((c: { message?: { content?: string } }) => c.message?.content)
            .filter(Boolean)
            .join(' ');
        } else if (b.text) {
          text = String(b.text);
        }
      }

      return detectPII(text, config, options);
    },
  };
}

/**
 * Built-in patterns for common compliance frameworks
 */
export const COMPLIANCE_PATTERNS = {
  // GDPR (EU Personal Data)
  gdpr: {
    creditCard: true,
    ssn: false,
    email: true,
    phone: true,
    ipAddress: true,
    dateOfBirth: true,
  },
  
  // HIPAA (Healthcare)
  hipaa: {
    creditCard: false,
    ssn: true,
    email: true,
    phone: true,
    ipAddress: false,
    dateOfBirth: true,
  },
  
  // PCI DSS (Payment Cards)
  pci: {
    creditCard: true,
    ssn: false,
    email: false,
    phone: false,
    ipAddress: false,
    dateOfBirth: false,
  },
};

/**
 * Create DLP config for specific compliance framework
 */
export function createComplianceConfig(framework: 'gdpr' | 'hipaa' | 'pci'): DLPConfig {
  const patterns = COMPLIANCE_PATTERNS[framework];
  return {
    enabled: true,
    patterns,
    action: 'block',
  };
}

/**
 * Zod schema for operator-supplied DLP config (#685). Without it a malformed
 * `action` (typo'd `"bock"`, etc.) or a bad custom pattern is trusted verbatim
 * and can silently degrade the filter. Pure validator — no I/O, opt-in.
 */
export const DLPConfigSchema = z.object({
  enabled: z.boolean(),
  patterns: z
    .object({
      creditCard: z.boolean().optional(),
      ssn: z.boolean().optional(),
      email: z.boolean().optional(),
      phone: z.boolean().optional(),
      ipAddress: z.boolean().optional(),
      dateOfBirth: z.boolean().optional(),
    })
    .default({}),
  customPatterns: z
    .array(
      z.object({
        name: z.string().min(1),
        pattern: z.string().min(1).max(1000),
        description: z.string().optional(),
      }),
    )
    .optional(),
  action: z.enum(['flag', 'block', 'allow']),
  minMatches: z.number().int().positive().optional(),
});

export type DLPConfigValidation =
  | { ok: true; config: DLPConfig }
  | { ok: false; errors: string[] };

/**
 * Validate a candidate DLP config. Returns a discriminated result instead of
 * throwing so callers can reject or fall back to a safe default.
 */
export function validateDLPConfig(input: unknown): DLPConfigValidation {
  const parsed = DLPConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data as DLPConfig };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/**
 * Coerce an untrusted DLP `action` to a valid value (#685 companion), falling
 * back to a SAFE default. An unknown/typo'd action returns the fallback rather
 * than silently behaving as `allow`.
 */
export function coerceDLPAction(
  value: unknown,
  fallback: 'flag' | 'block' | 'allow' = 'flag',
): 'flag' | 'block' | 'allow' {
  return value === 'flag' || value === 'block' || value === 'allow' ? value : fallback;
}

// Export default config
export { DEFAULT_DLP_CONFIG as defaultConfig };