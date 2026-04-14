/**
 * Tests for otel (OpenTelemetry) module.
 */

import { describe, it, expect } from 'vitest';
import { SPAN_NAMES } from '../../src/observability/otel';

describe('OTel', () => {
  it('should have all span names', () => {
    expect(SPAN_NAMES.PIPELINE_SPEECH).toBe('pipeline.speech');
    expect(SPAN_NAMES.PIPELINE_LLM).toBe('pipeline.llm');
    expect(SPAN_NAMES.PIPELINE_TTS).toBe('pipeline.tts');
    expect(SPAN_NAMES.PROVIDER_CHAT).toBe('provider.chat');
    expect(SPAN_NAMES.GPU_BOOT).toBe('gpu.boot');
  });
});
