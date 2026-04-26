/**
 * DLP - Data Loss Prevention for AI requests and responses.
 * 
 * Similar to Cloudflare AI Gateway DLP:
 * - Detects PII: credit cards, SSN, emails, phone numbers
 * - Custom patterns via regex
 * - Actions: flag, block
 * - Compliance support (GDPR, HIPAA, PCI DSS)
 */

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
}

// Built-in regex patterns
const PATTERNS = {
  // Credit Card - major brands (Visa, Mastercard, Amex, Discover)
  creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  
  // SSN - US Social Security Number (XXX-XX-XXXX)
  ssn: /\b(?!000|666|9\d{2})[0-9]{3}[-\s]?(?!00)[0-9]{2}[-\s]?(?!0000)[0-9]{4}\b/g,
  
  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  
  // Phone numbers - various formats
  phone: /\b(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
  
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
        const regex = new RegExp(custom.pattern, 'gi');
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
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

// Export default config
export { DEFAULT_DLP_CONFIG as defaultConfig };