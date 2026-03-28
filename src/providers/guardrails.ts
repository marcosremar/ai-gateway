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
      // Check if pattern is in text (case insensitive)
      if (textLower.includes(pattern.toLowerCase())) {
        triggeredCategories.push(category);
        allMatches.push(pattern);
        break; // Only flag category once
      }
    }

    // Check custom keywords
    if (config.customKeywords) {
      for (const keyword of config.customKeywords) {
        if (textLower.includes(keyword.toLowerCase())) {
          if (!triggeredCategories.includes('custom')) {
            triggeredCategories.push('custom');
          }
          allMatches.push(keyword);
        }
      }
    }
  }

  // Calculate confidence based on number of matches (1 match = 60 confidence)
  const confidence = Math.min(100, allMatches.length * 60);
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
            .map((m: any) => m.content)
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
            .map((c: any) => c.message?.content)
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

// Export default config
export { DEFAULT_GUARDRAIL_CONFIG as defaultConfig };