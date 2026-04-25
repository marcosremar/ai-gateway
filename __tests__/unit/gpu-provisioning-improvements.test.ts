import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoscalerEngine } from '../../src/autoscaler/engine';
import { GpuProviderRegistry } from '../../src/gpu-providers/registry';
import type { GpuProviderClient } from '../../src/gpu-providers/types';

describe('GPU Provisioning Improvements', () => {
  let registry: GpuProviderRegistry;
  
  beforeEach(() => {
    registry = new GpuProviderRegistry();
  });
  
  describe('Price Monitoring', () => {
    it('should initialize with default reliability score of 0.5', () => {
      const engine = new AutoscalerEngine({
        registry,
        sessionTracker: { countActiveSessions: async () => 0 } as any,
        latencyTracker: { getLatencyStats: async () => ({ p95: 100, samples: [], breaches: 0 }) } as any,
        persistence: { loadTierStates: async () => null, persistTierStates: async () => {} } as any,
        probeHealth: async () => true,
        cleanupInstance: async () => {},
      });
      
      const reliability = (engine as any).getProviderReliability('vast');
      expect(reliability).toBe(0.5);
    });
    
    it('should track health events and update reliability', () => {
      const engine = new AutoscalerEngine({
        registry,
        sessionTracker: { countActiveSessions: async () => 0 } as any,
        latencyTracker: { getLatencyStats: async () => ({ p95: 100, samples: [], breaches: 0 }) } as any,
        persistence: { loadTierStates: async () => null, persistTierStates: async () => {} } as any,
        probeHealth: async () => true,
        cleanupInstance: async () => {},
      });
      
      // Record success events
      (engine as any).recordProviderHealthEvent('vast', true);
      (engine as any).recordProviderHealthEvent('vast', true);
      (engine as any).recordProviderHealthEvent('vast', true);
      (engine as any).recordProviderHealthEvent('vast', true);
      
      // Record failure event
      (engine as any).recordProviderHealthEvent('vast', false);
      
      const reliability = (engine as any).getProviderReliability('vast');
      // After 5 events (4 success, 1 failure), reliability should be around 0.7-0.9
      expect(reliability).toBeGreaterThan(0.6);
      expect(reliability).toBeLessThanOrEqual(1);
    });
    
    it('should return null for unknown provider price', () => {
      const engine = new AutoscalerEngine({
        registry,
        sessionTracker: { countActiveSessions: async () => 0 } as any,
        latencyTracker: { getLatencyStats: async () => ({ p95: 100, samples: [], breaches: 0 }) } as any,
        persistence: { loadTierStates: async () => null, persistTierStates: async () => {} } as any,
        probeHealth: async () => true,
        cleanupInstance: async () => {},
      });
      
      const price = (engine as any).getProviderPrice('unknown-provider');
      expect(price).toBeNull();
    });
  });
  
  describe('resolveCredentials callback', () => {
    it('should accept resolveCredentials in constructor', () => {
      const resolveCredentials = async (provider: string) => {
        return { apiKey: 'test-key' };
      };
      
      const engine = new AutoscalerEngine({
        registry,
        sessionTracker: { countActiveSessions: async () => 0 } as any,
        latencyTracker: { getLatencyStats: async () => ({ p95: 100, samples: [], breaches: 0 }) } as any,
        persistence: { loadTierStates: async () => null, persistTierStates: async () => {} } as any,
        probeHealth: async () => true,
        cleanupInstance: async () => {},
        resolveCredentials,
      });
      
      expect(engine).toBeDefined();
    });
  });
  
  describe('Provider boot time scoring', () => {
    it('should have boot time constants exported', async () => {
      const { PROVIDER_BOOT_SECS } = await import('../../src/index');
      
      expect(PROVIDER_BOOT_SECS.tensordock).toBe(1200);
      expect(PROVIDER_BOOT_SECS.runpod).toBe(1200);
      expect(PROVIDER_BOOT_SECS.vast).toBe(900);
      expect(PROVIDER_BOOT_SECS.modal).toBe(60);
    });
  });
});