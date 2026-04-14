import { describe, it, expect, vi } from 'vitest';
import {
  detectPII,
  scanPromptAndResponse,
  createDLPMiddleware,
  createComplianceConfig,
  DEFAULT_DLP_CONFIG,
  COMPLIANCE_PATTERNS,
} from '../../src/providers/dlp';

const enabledConfig: typeof DEFAULT_DLP_CONFIG = {
  ...DEFAULT_DLP_CONFIG,
  enabled: true,
  patterns: { creditCard: true, ssn: true, email: true, phone: true, ipAddress: true, dateOfBirth: false },
};

describe('detectPII', () => {
  it('disabled by default → detected: false', () => {
    const result = detectPII('my email is test@example.com');
    expect(result.detected).toBe(false);
    expect(result.types).toEqual([]);
  });

  it('with options.skip → detected: false', () => {
    const result = detectPII('my email is test@example.com', enabledConfig, { skip: true });
    expect(result.detected).toBe(false);
  });

  it('detects credit card (Visa: starts with 4, 16 digits)', () => {
    const result = detectPII('Card: 4123456789012345', enabledConfig);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('creditCard');
  });

  it('detects credit card (Amex: starts with 37, 15 digits)', () => {
    const result = detectPII('Card: 371449635398431', enabledConfig);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('creditCard');
  });

  it('detects email address', () => {
    const result = detectPII('Contact me at user@example.com please', enabledConfig);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('email');
  });

  it('detects SSN (XXX-XX-XXXX format)', () => {
    const result = detectPII('SSN: 123-45-6789', enabledConfig);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('ssn');
  });

  it('detects phone number', () => {
    const result = detectPII('Call me at 555-123-4567', enabledConfig);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('phone');
  });

  it('detects IP address', () => {
    const result = detectPII('Server is at 192.168.1.100', enabledConfig);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('ipAddress');
  });

  it('masking: values are masked (show last 4 only)', () => {
    const result = detectPII('email: user@example.com', enabledConfig);
    expect(result.detected).toBe(true);
    for (const match of result.matches) {
      if (match.original) {
        expect(match.value.length).toBeLessThanOrEqual(match.original.length);
        expect(match.value.endsWith(match.original.slice(-4))).toBe(true);
      }
    }
  });

  it('with custom regex pattern', () => {
    const config = {
      ...DEFAULT_DLP_CONFIG,
      enabled: true,
      customPatterns: [{ name: 'api_key', pattern: 'sk-[a-zA-Z0-9]{20,}' }],
    };
    const result = detectPII('key is sk-abcdefghijklmnopqrst123456', config);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('api_key');
  });

  it('with invalid regex → does not crash', () => {
    const config = {
      ...DEFAULT_DLP_CONFIG,
      enabled: true,
      customPatterns: [{ name: 'bad', pattern: '[invalid(' }],
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = detectPII('some text', config);
    expect(result.detected).toBe(false);
    warnSpy.mockRestore();
  });

  it('with minMatches=2 and only 1 type → detected: false', () => {
    const config = { ...enabledConfig, minMatches: 2 };
    const result = detectPII('email: user@example.com', config);
    expect(result.detected).toBe(false);
  });

  it('with minMatches=2 and 2 types → detected: true', () => {
    const config = { ...enabledConfig, minMatches: 2 };
    const result = detectPII('email: user@example.com at 192.168.1.1', config);
    expect(result.detected).toBe(true);
  });
});

describe('scanPromptAndResponse', () => {
  it('PII in prompt + clean response → overall detected', () => {
    const result = scanPromptAndResponse('my email is test@example.com', 'hello there', enabledConfig);
    expect(result.prompt.detected).toBe(true);
    expect(result.response.detected).toBe(false);
    expect(result.overall.detected).toBe(true);
  });

  it('both clean → overall not detected', () => {
    const result = scanPromptAndResponse('hello world', 'hi there', enabledConfig);
    expect(result.overall.detected).toBe(false);
  });
});

describe('createDLPMiddleware', () => {
  it('scanRequest() extracts from OpenAI messages', () => {
    const middleware = createDLPMiddleware(enabledConfig);
    const body = {
      messages: [
        { role: 'user', content: 'email me at test@example.com' },
      ],
    };
    const result = middleware.scanRequest(body);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('email');
  });

  it('scanRequest() extracts from prompt field', () => {
    const middleware = createDLPMiddleware(enabledConfig);
    const result = middleware.scanRequest({ prompt: 'SSN: 123-45-6789' });
    expect(result.detected).toBe(true);
    expect(result.types).toContain('ssn');
  });

  it('scanResponse() extracts from OpenAI choices', () => {
    const middleware = createDLPMiddleware(enabledConfig);
    const body = {
      choices: [{ message: { content: 'Call 555-123-4567' } }],
    };
    const result = middleware.scanResponse(body);
    expect(result.detected).toBe(true);
    expect(result.types).toContain('phone');
  });
});

describe('createComplianceConfig', () => {
  it('gdpr → email, phone, ip, dob enabled', () => {
    const config = createComplianceConfig('gdpr');
    expect(config.enabled).toBe(true);
    expect(config.patterns.email).toBe(true);
    expect(config.patterns.phone).toBe(true);
    expect(config.patterns.ipAddress).toBe(true);
    expect(config.patterns.dateOfBirth).toBe(true);
    expect(config.patterns.creditCard).toBe(true);
    expect(config.patterns.ssn).toBe(false);
  });

  it('hipaa → ssn, email, phone, dob enabled', () => {
    const config = createComplianceConfig('hipaa');
    expect(config.enabled).toBe(true);
    expect(config.patterns.ssn).toBe(true);
    expect(config.patterns.email).toBe(true);
    expect(config.patterns.phone).toBe(true);
    expect(config.patterns.dateOfBirth).toBe(true);
    expect(config.patterns.creditCard).toBe(false);
    expect(config.patterns.ipAddress).toBe(false);
  });

  it('pci → only creditCard enabled', () => {
    const config = createComplianceConfig('pci');
    expect(config.enabled).toBe(true);
    expect(config.patterns.creditCard).toBe(true);
    expect(config.patterns.ssn).toBe(false);
    expect(config.patterns.email).toBe(false);
    expect(config.patterns.phone).toBe(false);
    expect(config.patterns.ipAddress).toBe(false);
    expect(config.patterns.dateOfBirth).toBe(false);
  });
});

describe('action block vs flag', () => {
  it('block config → action is block when detected', () => {
    const config = { ...enabledConfig, action: 'block' as const };
    const result = detectPII('email: user@example.com', config);
    expect(result.detected).toBe(true);
    expect(result.action).toBe('block');
  });

  it('flag config → action is flag when detected', () => {
    const config = { ...enabledConfig, action: 'flag' as const };
    const result = detectPII('email: user@example.com', config);
    expect(result.detected).toBe(true);
    expect(result.action).toBe('flag');
  });

  it('clean text → action is allow regardless of config', () => {
    const config = { ...enabledConfig, action: 'block' as const };
    const result = detectPII('hello world', config);
    expect(result.detected).toBe(false);
    expect(result.action).toBe('allow');
  });
});
