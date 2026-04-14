/**
 * Error Summary — unit tests for the ErrorSummaryTracker.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { errorSummary } from '../../src/error-summary';
import { DeployError, categorizeDeployError } from '../../src/errors/deploy-errors';

describe('ErrorSummaryTracker', () => {
  beforeEach(() => {
    // Clear tracker before each test
    errorSummary.clear();
  });

  describe('record', () => {
    it('should record a DeployError and return it', () => {
      const deployErr = new DeployError('RESOURCE', 'RES_CUDA_OOM', { detail: 'test' });
      const result = errorSummary.record(deployErr, 'deploy-123');

      expect(result).toBe(deployErr);
      expect(errorSummary.count).toBe(1);
    });

    it('should return null for non-DeployError', () => {
      const result = errorSummary.record(new Error('plain error'), 'deploy-123');
      expect(result).toBeNull();
      expect(errorSummary.count).toBe(0);
    });

    it('should return null for non-Error values', () => {
      const result = errorSummary.record('string error', 'deploy-123');
      expect(result).toBeNull();
      expect(errorSummary.count).toBe(0);
    });

    it('should store the deployId with the error', () => {
      const deployErr = new DeployError('NETWORK', 'NET_TIMEOUT', {});
      errorSummary.record(deployErr, 'deploy-abc');
      errorSummary.record(deployErr, 'deploy-def');

      // Both should be recorded
      expect(errorSummary.count).toBe(2);
    });
  });

  describe('getSummary', () => {
    it('should return summary with period string', () => {
      const deployErr = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      errorSummary.record(deployErr);

      const summary = errorSummary.getSummary(24);
      expect(summary.period).toBe('Last 24h');
      expect(summary.totalErrors).toBe(1);
    });

    it('should filter errors by time period', () => {
      const deployErr = new DeployError('NETWORK', 'NET_TIMEOUT', {});
      errorSummary.record(deployErr);

      // 0 hours should return no errors (cutoff is now)
      const summary = errorSummary.getSummary(0);
      expect(summary.totalErrors).toBe(0);
    });

    it('should include errors within the time window', () => {
      const deployErr = new DeployError('PROVIDER', 'PRV_API_ERROR', { detail: 'test' });
      errorSummary.record(deployErr);

      const summary = errorSummary.getSummary(24);
      expect(summary.totalErrors).toBe(1);
      expect(summary.byCategory['PROVIDER']).toBe(1);
    });

    it('should aggregate errors by category', () => {
      const resourceErr = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      const networkErr = new DeployError('NETWORK', 'NET_TIMEOUT', {});

      errorSummary.record(resourceErr);
      errorSummary.record(networkErr);
      errorSummary.record(resourceErr);

      const summary = errorSummary.getSummary(24);
      expect(summary.byCategory['RESOURCE']).toBe(2);
      expect(summary.byCategory['NETWORK']).toBe(1);
    });

    it('should count retryable vs non-retryable errors', () => {
      const retryableErr = new DeployError('NETWORK', 'NET_TIMEOUT', {});
      const nonRetryableErr = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});

      errorSummary.record(retryableErr);
      errorSummary.record(nonRetryableErr);

      const summary = errorSummary.getSummary(24);
      expect(summary.retryableCount).toBe(1);
      expect(summary.nonRetryableCount).toBe(1);
    });

    it('should return top errors sorted by count', () => {
      const err1 = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      const err2 = new DeployError('NETWORK', 'NET_TIMEOUT', {});

      // Record err1 three times, err2 once
      errorSummary.record(err1);
      errorSummary.record(err1);
      errorSummary.record(err1);
      errorSummary.record(err2);

      const summary = errorSummary.getSummary(24);
      expect(summary.topErrors[0].code).toBe('RES_CUDA_OOM');
      expect(summary.topErrors[0].count).toBe(3);
      expect(summary.topErrors[1].code).toBe('NET_TIMEOUT');
      expect(summary.topErrors[1].count).toBe(1);
    });
  });

  describe('getByCategory', () => {
    it('should return errors filtered by category', () => {
      const resourceErr = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      const networkErr = new DeployError('NETWORK', 'NET_TIMEOUT', {});

      errorSummary.record(resourceErr);
      errorSummary.record(networkErr);
      errorSummary.record(resourceErr);

      const resourceErrors = errorSummary.getByCategory('RESOURCE');
      expect(resourceErrors).toHaveLength(2);
      expect(resourceErrors.every(e => e.category === 'RESOURCE')).toBe(true);
    });

    it('should return empty array for category with no errors', () => {
      const resourceErr = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      errorSummary.record(resourceErr);

      const networkErrors = errorSummary.getByCategory('NETWORK');
      expect(networkErrors).toHaveLength(0);
    });
  });

  describe('getTopErrors', () => {
    it('should return most frequent errors', () => {
      const err1 = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      const err2 = new DeployError('NETWORK', 'NET_TIMEOUT', {});

      errorSummary.record(err1);
      errorSummary.record(err1);
      errorSummary.record(err2);

      const topErrors = errorSummary.getTopErrors(5);
      expect(topErrors).toHaveLength(2);
      expect(topErrors[0].code).toBe('RES_CUDA_OOM');
      expect(topErrors[0].count).toBe(2);
    });

    it('should respect the limit parameter', () => {
      // Use different error codes so they appear as distinct entries in topErrors
      const errorCodes = [
        'RES_CUDA_OOM', 'RES_HOST_OOM', 'RES_DISK_FULL', 'RES_VRAM_INSUFFICIENT',
        'NET_DNS_FAILURE', 'NET_TIMEOUT', 'NET_CONNECTION_REFUSED',
        'PRV_API_ERROR', 'PRV_AUTH_FAILED', 'PRV_OFFER_UNAVAILABLE',
        'CNT_IMAGE_NOT_FOUND', 'CNT_PULL_FAILED', 'CNT_HEALTHCHECK_FAIL',
        'GPU_CUDA_MISMATCH', 'GPU_DRIVER_MISMATCH',
      ] as const;

      for (const code of errorCodes) {
        const err = new DeployError('PROVIDER', code, { detail: `error-${code}` });
        errorSummary.record(err);
      }

      const topErrors = errorSummary.getTopErrors(5);
      expect(topErrors).toHaveLength(5);
    });

    it('should include code, count, message, and category fields', () => {
      const err = new DeployError('RESOURCE', 'RES_CUDA_OOM', { detail: 'test OOM' });
      errorSummary.record(err);

      const topErrors = errorSummary.getTopErrors();
      expect(topErrors[0]).toHaveProperty('code');
      expect(topErrors[0]).toHaveProperty('count');
      expect(topErrors[0]).toHaveProperty('message');
      expect(topErrors[0]).toHaveProperty('category');
    });
  });

  describe('max entries limit', () => {
    it('should enforce maxEntries limit of 1000', () => {
      // Record 1100 errors
      for (let i = 0; i < 1100; i++) {
        const err = new DeployError('PROVIDER', 'PRV_API_ERROR', { detail: `error-${i}` });
        errorSummary.record(err);
      }

      // Should only keep 1000 (maxEntries)
      expect(errorSummary.count).toBe(1000);
    });

    it('should remove oldest entries when limit is exceeded', () => {
      // Record 1005 errors
      for (let i = 0; i < 1005; i++) {
        const err = new DeployError('PROVIDER', 'PRV_API_ERROR', { detail: `error-${i}` });
        errorSummary.record(err);
      }

      expect(errorSummary.count).toBe(1000);

      // The oldest 5 errors should have been removed
      const summary = errorSummary.getSummary(24);
      expect(summary.totalErrors).toBe(1000);
    });
  });

  describe('clear', () => {
    it('should remove all tracked errors', () => {
      const err1 = new DeployError('RESOURCE', 'RES_CUDA_OOM', {});
      const err2 = new DeployError('NETWORK', 'NET_TIMEOUT', {});

      errorSummary.record(err1);
      errorSummary.record(err2);
      expect(errorSummary.count).toBe(2);

      errorSummary.clear();
      expect(errorSummary.count).toBe(0);
    });

    it('should reset summary to zero errors', () => {
      errorSummary.record(new DeployError('RESOURCE', 'RES_CUDA_OOM', {}));
      errorSummary.clear();

      const summary = errorSummary.getSummary(24);
      expect(summary.totalErrors).toBe(0);
      expect(summary.topErrors).toHaveLength(0);
    });
  });

  describe('count', () => {
    it('should return current number of tracked errors', () => {
      expect(errorSummary.count).toBe(0);

      errorSummary.record(new DeployError('RESOURCE', 'RES_CUDA_OOM', {}));
      expect(errorSummary.count).toBe(1);

      errorSummary.record(new DeployError('NETWORK', 'NET_TIMEOUT', {}));
      expect(errorSummary.count).toBe(2);
    });
  });

  describe('integration with categorizeDeployError', () => {
    it('should record categorized errors correctly', () => {
      const err = new Error('CUDA out of memory');
      const deployErr = categorizeDeployError(err, { detail: 'test' });
      const result = errorSummary.record(deployErr, 'deploy-integration');

      expect(result).toBe(deployErr);
      expect(result?.category).toBe('RESOURCE');
      expect(result?.code).toBe('RES_CUDA_OOM');
      expect(errorSummary.count).toBe(1);
    });
  });
});
