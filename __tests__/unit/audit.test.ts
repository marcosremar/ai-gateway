/**
 * Tests for audit module.
 */

import { describe, it, expect } from 'vitest';
import { AUDIT_EVENTS } from '../../src/audit';

describe('Audit', () => {
  it('should have all event types', () => {
    expect(AUDIT_EVENTS.AUTH_SUCCESS).toBe('AUTH_SUCCESS');
    expect(AUDIT_EVENTS.GPU_DEPLOY).toBe('GPU_DEPLOY');
    expect(AUDIT_EVENTS.BUDGET_ALERT).toBe('BUDGET_ALERT');
  });
});
