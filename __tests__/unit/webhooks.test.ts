/**
 * Tests for webhooks module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWebhookDelivery, WEBHOOK_EVENTS } from '../../src/webhooks';

describe('WebhookDelivery', () => {
  it('should have all event types', () => {
    expect(WEBHOOK_EVENTS.GPU_DEPLOYED).toBe('gpu.deployed');
    expect(WEBHOOK_EVENTS.PIPELINE_COMPLETED).toBe('pipeline.completed');
    expect(WEBHOOK_EVENTS.BUDGET_EXCEEDED).toBe('budget.exceeded');
  });

  it('should create delivery instance', () => {
    const delivery = createWebhookDelivery({
      url: 'https://example.com/webhook',
    });

    expect(delivery).toBeDefined();
    expect(typeof delivery.send).toBe('function');
  });

  it('should track dead letters', () => {
    const delivery = createWebhookDelivery({
      url: 'https://invalid-url-that-does-not-exist.local',
      retries: 1,
    });

    expect(delivery.getDeadLetters()).toHaveLength(0);
  });
});
