import { describe, it, expect } from 'vitest';
import { AutoscalerSettingsSchema, AutoscalerTierSchema } from '@ai-gateway/handlers/autoscaler-schemas';

describe('autoscaler-schemas', () => {
  describe('AutoscalerSettingsSchema', () => {
    it('applies correct defaults for empty object', () => {
      const result = AutoscalerSettingsSchema.parse({});
      expect(result).toEqual({
        enabled: false,
        threshold: 1,
        windowMinutes: 5,
        maxLatencyMs: 3000,
        tiers: [],
        idleGraceMinutes: 15,
      });
    });

    it('accepts valid full config', () => {
      const input = {
        enabled: true,
        threshold: 3,
        windowMinutes: 10,
        maxLatencyMs: 2000,
        gpuProvider: 'tensordock',
        gpuTypes: ['RTX3090'],
        tiers: [{ provider: 'tensordock', instanceId: 'i-123' }],
        idleGraceMinutes: 30,
      };
      const result = AutoscalerSettingsSchema.parse(input);
      expect(result.enabled).toBe(true);
      expect(result.threshold).toBe(3);
      expect(result.tiers).toHaveLength(1);
      expect(result.tiers[0].provider).toBe('tensordock');
      expect(result.idleGraceMinutes).toBe(30);
    });

    it('rejects invalid types', () => {
      expect(() =>
        AutoscalerSettingsSchema.parse({ enabled: 'not-a-boolean' }),
      ).toThrow();

      expect(() =>
        AutoscalerSettingsSchema.parse({ threshold: 'not-a-number' }),
      ).toThrow();

      expect(() =>
        AutoscalerSettingsSchema.parse({ tiers: 'not-an-array' }),
      ).toThrow();
    });

    it('preserves optional gpuProvider and gpuTypes', () => {
      const result = AutoscalerSettingsSchema.parse({
        gpuProvider: 'runpod',
        gpuTypes: ['A100', 'H100'],
      });
      expect(result.gpuProvider).toBe('runpod');
      expect(result.gpuTypes).toEqual(['A100', 'H100']);
    });

    it('omits gpuProvider and gpuTypes when not provided', () => {
      const result = AutoscalerSettingsSchema.parse({});
      expect(result.gpuProvider).toBeUndefined();
      expect(result.gpuTypes).toBeUndefined();
    });
  });

  describe('AutoscalerTierSchema', () => {
    it('requires provider field', () => {
      expect(() => AutoscalerTierSchema.parse({})).toThrow();
    });

    it('accepts provider only', () => {
      const result = AutoscalerTierSchema.parse({ provider: 'modal' });
      expect(result.provider).toBe('modal');
      expect(result.instanceId).toBeUndefined();
      expect(result.apiKey).toBeUndefined();
    });

    it('accepts full tier config', () => {
      const input = {
        provider: 'tensordock',
        instanceId: 'i-abc',
        apiKey: 'key-123',
        authId: 'auth-456',
        endpoint: 'http://10.0.0.1:8000',
        gpuTypes: ['RTX3090', 'RTX4090'],
      };
      const result = AutoscalerTierSchema.parse(input);
      expect(result).toEqual(input);
    });
  });
});
