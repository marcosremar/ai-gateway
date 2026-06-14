/**
 * Guardrails - Content moderation for AI prompts and responses.
 * 
 * Similar to Cloudflare AI Gateway guardrails:
 * - Filters: hate, harassment, self_harm, sexual, violence
 * - Actions: block, audit, allow
 * - Per-request configuration
 * 
 * Uses local keyword matching + optional external moderation API.
 */

import { z } from 'zod';

export interface GuardrailConfig {
  /** Enable/disable guardrails */
  enabled: boolean;
  /** Content categories to check */
  filters: {
    /** Hate speech, discrimination */
    hate?: boolean;
    /** Harassment, bullying */
    harassment?: boolean;
    /** Self-harm, suicide */
    self_harm?: boolean;
    /** Sexual content */
    sexual?: boolean;
    /** Violence, gore */
    violence?: boolean;
  };
  /** Action when content is flagged */
  action: 'block' | 'audit' | 'allow';
  /** Custom keywords to block (additional to built-in) */
  customKeywords?: string[];
  /** Confidence threshold (0-100) */
  confidenceThreshold?: number;
}

export interface GuardrailResult {
  /** Whether content was flagged */
  flagged: boolean;
  /** Categories that were triggered */
  categories: string[];
  /** Matched keywords or phrases */
  matches: string[];
  /** Confidence score (0-100) */
  confidence: number;
  /** Action taken */
  action: 'block' | 'audit' | 'allow';
}

export interface GuardrailOptions {
  /** Override global config for this request */
  enabled?: boolean;
  /** Custom filters for this request */
  filters?: Partial<GuardrailConfig['filters']>;
  /** Skip guardrails for this request */
  skip?: boolean;
  /** Also match against a de-obfuscated copy of the text (#680): collapse
   *  inter-letter spacing/punctuation and map common leetspeak so `k i l l`
   *  and `k1ll` still trip the keyword filter. Opt-in (default off) — best
   *  effort, NOT a substitute for an external moderation API. */
  deobfuscate?: boolean;
}

/**
 * Normalize text for obfuscation-resistant keyword matching (#680). Lowercases,
 * maps common leetspeak digits/symbols to letters, and removes separators
 * (spaces, dots, dashes, underscores) that are used to break up keywords. This
 * is intentionally aggressive and lossy — only used as an *additional* matching
 * pass behind the `deobfuscate` opt-in, never as the sole/primary check.
 */
export function normalizeForMatching(text: string): string {
  const leet: Record<string, string> = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i',
  };
  return text
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => leet[c] ?? c)
    .replace(/[\s._-]+/g, '');
}

// Built-in keyword patterns for each category
const KEYWORD_PATTERNS: Record<string, string[]> = {
  hate: [
    'hate', 'hatred', 'prejudice', 'discriminat', 'racist', 'sexist', 'homophob', 'transphob',
    'nazi', 'fascist', 'supremac'
  ],
  harassment: [
    'harass', 'bully', 'stalk', 'threat', 'intimidat', 'abus',
    'insult', 'humiliate', 'denigrat', 'mock'
  ],
  self_harm: [
    'suicide', 'self harm', 'self injury', 'kill myself', 'end my life',
    'cut myself', 'burn myself', 'punch myself'
  ],
  sexual: [
    'sexual', 'erotic', 'porn', 'xxx', 'adult', 'nsfw',
    'foreplay', 'orgasm', 'masturbat'
  ],
  violence: [
    'kill', 'murder', 'assassin', 'terroris', 'attack', 'violent',
    'shoot', 'stab', 'bludgeon', 'strangle', 'poison'
  ],
};

/**
 * Default guardrail configuration
 */
export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  enabled: false, // disabled by default
  filters: {
    hate: true,
    harassment: true,
    self_harm: true,
    sexual: false,
    violence: true,
  },
  action: 'block',
  confidenceThreshold: 50,
};

/**
 * Check content against guardrails.
 * 
 * @param text - Text to check (prompt or response)
 * @param config - Guardrail configuration
 * @param options - Per-request options
 */
export function checkContent(
  text: string,
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG,
  options?: GuardrailOptions
): GuardrailResult {
  // Skip if disabled or skip option is set
  if (!config.enabled || options?.skip || options?.enabled === false) {
    return {
      flagged: false,
      categories: [],
      matches: [],
      confidence: 0,
      action: 'allow',
    };
  }

  const textLower = text.toLowerCase();
  // #680: opt-in de-obfuscated haystack (separators stripped, leetspeak mapped).
  // Built only when requested so default behavior/confidence math is unchanged.
  const textDeobfuscated = options?.deobfuscate ? normalizeForMatching(text) : null;
  const triggeredCategories: string[] = [];
  const allMatches: string[] = [];

  // Determine which filters to check
  const filtersToCheck = options?.filters
    ? { ...config.filters, ...options.filters }
    : config.filters;

  // Check each enabled category
  for (const [category, enabled] of Object.entries(filtersToCheck)) {
    if (!enabled) continue;

    // Handle self_harm -> self_harm mapping
    const patternKey = category;
    const patterns = KEYWORD_PATTERNS[patternKey] || [];

    for (const pattern of patterns) {
      // Prefix word-boundary match — `\b<pattern>` lets stems match their
      // inflected forms ("harass" → "harassing", "kill" → "killing") but
      // still rejects substring false positives like "kill" in "skillet"
      // or "hate" in "whatever" where there's no leading word boundary.
      const escaped = pattern.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}`, 'i');
      // The de-obfuscated pass strips separators, so word boundaries no longer
      // apply there — match the (already separator-free) keyword as a substring.
      const deobfKeyword = textDeobfuscated ? normalizeForMatching(pattern) : '';
      const hit = re.test(textLower) ||
        (textDeobfuscated !== null && deobfKeyword.length > 0 && textDeobfuscated.includes(deobfKeyword));
      if (hit) {
        triggeredCategories.push(category);
        allMatches.push(pattern);
        break; // Only flag category once
      }
    }
  }

  // Custom keywords scanned ONCE per request (was previously inside the
  // per-category loop, recording each match N times where N = enabled
  // category count, inflating `confidence = matches.length * 20` and
  // triggering false-positive blocks).
  if (config.customKeywords) {
    const seenCustomKeyword = new Set<string>();
    for (const keyword of config.customKeywords) {
      if (textLower.includes(keyword.toLowerCase()) && !seenCustomKeyword.has(keyword)) {
        seenCustomKeyword.add(keyword);
        if (!triggeredCategories.includes('custom')) {
          triggeredCategories.push('custom');
        }
        allMatches.push(keyword);
      }
    }
  }

  // Calculate confidence based on number of matches (1 match = 20 confidence)
  const confidence = Math.min(100, allMatches.length * 20);
  const flagged = triggeredCategories.length > 0 && confidence >= (config.confidenceThreshold || 50);

  // Determine action based on config and results
  let action: 'block' | 'audit' | 'allow' = 'allow';
  if (flagged) {
    action = config.action;
  }

  return {
    flagged,
    categories: [...new Set(triggeredCategories)],
    matches: [...new Set(allMatches)],
    confidence,
    action,
  };
}

/**
 * Check both prompt and response against guardrails
 */
export function checkPromptAndResponse(
  prompt: string,
  response: string,
  config: GuardrailConfig,
  options?: GuardrailOptions
): {
  prompt: GuardrailResult;
  response: GuardrailResult;
  overall: GuardrailResult;
} {
  const promptResult = checkContent(prompt, config, options);
  const responseResult = checkContent(response, config, options);

  // Overall is blocked if either is blocked
  const overallFlagged = promptResult.flagged || responseResult.flagged;
  const overallCategories = [...new Set([...promptResult.categories, ...responseResult.categories])];
  const overallMatches = [...new Set([...promptResult.matches, ...responseResult.matches])];
  const overallConfidence = Math.max(promptResult.confidence, responseResult.confidence);

  const overallAction = overallFlagged ? config.action : 'allow';

  return {
    prompt: promptResult,
    response: responseResult,
    overall: {
      flagged: overallFlagged,
      categories: overallCategories,
      matches: overallMatches,
      confidence: overallConfidence,
      action: overallAction,
    },
  };
}

/**
 * Create guardrail middleware for HTTP requests
 */
export function createGuardrailMiddleware(config: GuardrailConfig) {
  return {
    /**
     * Check a request before sending to AI provider
     */
    checkRequest: (body: unknown, options?: GuardrailOptions): GuardrailResult => {
      // Extract text from common request formats
      let text = '';
      
      if (typeof body === 'string') {
        text = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        // OpenAI format
        if (Array.isArray(b.messages)) {
          text = b.messages
            .map((m: { content?: string }) => m.content)
            .filter(Boolean)
            .join(' ');
        } else if (b.prompt) {
          text = String(b.prompt);
        } else if (b.text) {
          text = String(b.text);
        }
      }

      return checkContent(text, config, options);
    },

    /**
     * Check a response from AI provider
     */
    checkResponse: (body: unknown, options?: GuardrailOptions): GuardrailResult => {
      let text = '';

      if (typeof body === 'string') {
        text = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        // OpenAI format
        if (b.choices && Array.isArray(b.choices)) {
          text = b.choices
            .map((c: { message?: { content?: string } }) => c.message?.content)
            .filter(Boolean)
            .join(' ');
        } else if (b.text) {
          text = String(b.text);
        }
      }

      return checkContent(text, config, options);
    },
  };
}

/**
 * Zod schema for operator-supplied guardrail config (#685 sibling). Validates
 * the `action` enum and filter/threshold shapes so a malformed config fails
 * loud instead of silently degrading to `allow`. Pure validator, opt-in.
 */
export const GuardrailConfigSchema = z.object({
  enabled: z.boolean(),
  filters: z
    .object({
      hate: z.boolean().optional(),
      harassment: z.boolean().optional(),
      self_harm: z.boolean().optional(),
      sexual: z.boolean().optional(),
      violence: z.boolean().optional(),
    })
    .default({}),
  action: z.enum(['block', 'audit', 'allow']),
  customKeywords: z.array(z.string().min(1)).optional(),
  confidenceThreshold: z.number().min(0).max(100).optional(),
});

export type GuardrailConfigValidation =
  | { ok: true; config: GuardrailConfig }
  | { ok: false; errors: string[] };

/** Validate a candidate guardrail config; discriminated result, never throws. */
export function validateGuardrailConfig(input: unknown): GuardrailConfigValidation {
  const parsed = GuardrailConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data as GuardrailConfig };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/**
 * Coerce an untrusted guardrail `action` to a valid value, falling back to a
 * SAFE default (#685 companion). Unknown/typo'd → fallback, not silent allow.
 */
export function coerceGuardrailAction(
  value: unknown,
  fallback: 'block' | 'audit' | 'allow' = 'block',
): 'block' | 'audit' | 'allow' {
  return value === 'block' || value === 'audit' || value === 'allow' ? value : fallback;
}

// Export default config
export { DEFAULT_GUARDRAIL_CONFIG as defaultConfig };