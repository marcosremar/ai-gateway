import { describe, it, expect } from 'vitest';
import {
  checkContent,
  checkPromptAndResponse,
  createGuardrailMiddleware,
  DEFAULT_GUARDRAIL_CONFIG,
} from '../src/providers/guardrails';

const enabledConfig: typeof DEFAULT_GUARDRAIL_CONFIG = {
  ...DEFAULT_GUARDRAIL_CONFIG,
  enabled: true,
  confidenceThreshold: 1,
};

describe('checkContent', () => {
  it('disabled by default → flagged: false, action: allow', () => {
    const result = checkContent('any text here');
    expect(result.flagged).toBe(false);
    expect(result.action).toBe('allow');
    expect(result.categories).toEqual([]);
  });

  it('with options.skip → flagged: false', () => {
    const result = checkContent('hate speech', enabledConfig, { skip: true });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe('allow');
  });

  it('detects hate speech keyword → flagged: true, categories includes hate', () => {
    const result = checkContent('I hate this', enabledConfig);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('hate');
    expect(result.action).toBe('block');
  });

  it('detects harassment → categories includes harassment', () => {
    const result = checkContent('stop harassing me', enabledConfig);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('harassment');
  });

  it('detects self_harm → categories includes self_harm', () => {
    const result = checkContent('I want to kill myself', enabledConfig);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('self_harm');
  });

  it('detects violence → categories includes violence', () => {
    const result = checkContent('I will murder him', enabledConfig);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('violence');
  });

  it('with sexual filter disabled → sexual keywords ignored', () => {
    const config = { ...enabledConfig, filters: { ...enabledConfig.filters, sexual: false } };
    const result = checkContent('sexual content here', config);
    expect(result.categories).not.toContain('sexual');
  });

  it('with custom keywords → categories includes custom', () => {
    const config = { ...enabledConfig, customKeywords: ['forbiddenword'] };
    const result = checkContent('this has a forbiddenword inside', config);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('custom');
    expect(result.matches).toContain('forbiddenword');
  });

  it('with low confidenceThreshold → still flags', () => {
    const config = { ...enabledConfig };
    const result = checkContent('hate', config);
    expect(result.flagged).toBe(true);
  });

  it('single match may not meet high confidenceThreshold', () => {
    const config = { ...DEFAULT_GUARDRAIL_CONFIG, enabled: true, confidenceThreshold: 100 };
    const result = checkContent('I hate this', config);
    expect(result.confidence).toBe(20);
    expect(result.flagged).toBe(false);
  });
});

describe('checkPromptAndResponse', () => {
  it('clean prompt + flagged response → overall flagged', () => {
    const result = checkPromptAndResponse('hello world', 'I hate everything', enabledConfig);
    expect(result.prompt.flagged).toBe(false);
    expect(result.response.flagged).toBe(true);
    expect(result.overall.flagged).toBe(true);
  });

  it('both clean → overall not flagged', () => {
    const result = checkPromptAndResponse('hello world', 'that is great', enabledConfig);
    expect(result.overall.flagged).toBe(false);
  });
});

describe('createGuardrailMiddleware', () => {
  const config = enabledConfig;

  it('checkRequest() extracts text from OpenAI messages array', () => {
    const middleware = createGuardrailMiddleware(config);
    const body = {
      messages: [
        { role: 'user', content: 'I hate you' },
        { role: 'assistant', content: 'sorry' },
      ],
    };
    const result = middleware.checkRequest(body);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('hate');
  });

  it('checkRequest() extracts text from string body', () => {
    const middleware = createGuardrailMiddleware(config);
    const result = middleware.checkRequest('I will kill you');
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('violence');
  });

  it('checkRequest() extracts text from prompt field', () => {
    const middleware = createGuardrailMiddleware(config);
    const result = middleware.checkRequest({ prompt: 'I hate this' });
    expect(result.flagged).toBe(true);
  });

  it('checkResponse() extracts text from OpenAI choices format', () => {
    const middleware = createGuardrailMiddleware(config);
    const body = {
      choices: [
        { message: { content: 'I hate everything' } },
        { message: { content: '' } },
      ],
    };
    const result = middleware.checkResponse(body);
    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('hate');
  });

  it('checkResponse() passes clean content', () => {
    const middleware = createGuardrailMiddleware(config);
    const body = {
      choices: [{ message: { content: 'Hello, how can I help?' } }],
    };
    const result = middleware.checkResponse(body);
    expect(result.flagged).toBe(false);
  });
});
