/**
 * Tests for providers/classification.ts
 * - ProviderClassification sets and methods
 */

import { describe, it, expect } from 'vitest';
import { ProviderClassification } from '../../src/providers/classification';

describe('ProviderClassification', () => {
  describe('cloud providers', () => {
    it('identifies openai as cloud', () => {
      expect(ProviderClassification.isCloud('openai')).toBe(true);
    });

    it('identifies groq as cloud', () => {
      expect(ProviderClassification.isCloud('groq')).toBe(true);
    });

    it('identifies openrouter as cloud', () => {
      expect(ProviderClassification.isCloud('openrouter')).toBe(true);
    });

    it('identifies fireworks as cloud', () => {
      expect(ProviderClassification.isCloud('fireworks')).toBe(true);
    });

    it('returns false for GPU providers', () => {
      expect(ProviderClassification.isCloud('runpod')).toBe(false);
      expect(ProviderClassification.isCloud('tensordock')).toBe(false);
      expect(ProviderClassification.isCloud('skypilot')).toBe(false);
    });

    it('returns false for unknown providers', () => {
      expect(ProviderClassification.isCloud('unknown')).toBe(false);
      expect(ProviderClassification.isCloud('')).toBe(false);
    });
  });

  describe('self-hosted GPU providers', () => {
    it('identifies skypilot as self-hosted GPU', () => {
      expect(ProviderClassification.isSelfHostedGpu('skypilot')).toBe(true);
    });

    it('identifies runpod as self-hosted GPU', () => {
      expect(ProviderClassification.isSelfHostedGpu('runpod')).toBe(true);
    });

    it('identifies tensordock as self-hosted GPU', () => {
      expect(ProviderClassification.isSelfHostedGpu('tensordock')).toBe(true);
    });

    it('returns false for cloud providers', () => {
      expect(ProviderClassification.isSelfHostedGpu('openai')).toBe(false);
      expect(ProviderClassification.isSelfHostedGpu('groq')).toBe(false);
    });

    it('returns false for serverless GPU providers', () => {
      expect(ProviderClassification.isSelfHostedGpu('modal')).toBe(false);
      expect(ProviderClassification.isSelfHostedGpu('vast-serverless')).toBe(false);
    });
  });

  describe('serverless GPU providers', () => {
    it('identifies modal as serverless GPU', () => {
      expect(ProviderClassification.isServerlessGpu('modal')).toBe(true);
    });

    it('identifies vast-serverless as serverless GPU', () => {
      expect(ProviderClassification.isServerlessGpu('vast-serverless')).toBe(true);
    });

    it('returns false for cloud providers', () => {
      expect(ProviderClassification.isServerlessGpu('openai')).toBe(false);
    });

    it('returns false for self-hosted GPU', () => {
      expect(ProviderClassification.isServerlessGpu('runpod')).toBe(false);
    });
  });

  describe('isGpuBacked()', () => {
    it('returns true for self-hosted GPU providers', () => {
      expect(ProviderClassification.isGpuBacked('runpod')).toBe(true);
      expect(ProviderClassification.isGpuBacked('tensordock')).toBe(true);
      expect(ProviderClassification.isGpuBacked('skypilot')).toBe(true);
    });

    it('returns true for serverless GPU providers', () => {
      expect(ProviderClassification.isGpuBacked('modal')).toBe(true);
      expect(ProviderClassification.isGpuBacked('vast-serverless')).toBe(true);
    });

    it('returns false for cloud providers', () => {
      expect(ProviderClassification.isGpuBacked('openai')).toBe(false);
      expect(ProviderClassification.isGpuBacked('groq')).toBe(false);
      expect(ProviderClassification.isGpuBacked('openrouter')).toBe(false);
      expect(ProviderClassification.isGpuBacked('fireworks')).toBe(false);
    });

    it('returns false for unknown providers', () => {
      expect(ProviderClassification.isGpuBacked('unknown')).toBe(false);
    });
  });

  describe('sets are accessible', () => {
    it('exposes cloud set', () => {
      expect(ProviderClassification.cloud).toBeInstanceOf(Set);
      expect(ProviderClassification.cloud.size).toBeGreaterThan(0);
    });

    it('exposes selfHostedGpu set', () => {
      expect(ProviderClassification.selfHostedGpu).toBeInstanceOf(Set);
      expect(ProviderClassification.selfHostedGpu.size).toBeGreaterThan(0);
    });

    it('exposes serverlessGpu set', () => {
      expect(ProviderClassification.serverlessGpu).toBeInstanceOf(Set);
      expect(ProviderClassification.serverlessGpu.size).toBeGreaterThan(0);
    });
  });
});
