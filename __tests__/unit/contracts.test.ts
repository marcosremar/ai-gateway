/**
 * Tests for contracts module.
 */

import { describe, it, expect } from 'vitest';
import { SpeechQuerySchema, ChatMessageSchema } from '../../src/contracts';

describe('Contracts', () => {
  it('should validate speech query', () => {
    const valid = SpeechQuerySchema.safeParse({ source: 'fr', target: 'en' });
    expect(valid.success).toBe(true);
  });

  it('should validate chat message', () => {
    const valid = ChatMessageSchema.safeParse({ role: 'user', content: 'Hello' });
    expect(valid.success).toBe(true);
  });
});
