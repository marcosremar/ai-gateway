/**
 * Bug: categorizeDeployFailure() lowercases the message into `m` and uses
 * it for every classifier check EXCEPT the api_error check on line 133,
 * which switches to the ORIGINAL `message` (case-sensitive).
 *
 * Result: a lowercase api error message like "api auth failed" misses
 * the `'API'` substring check and falls through to 'unknown' — even
 * though every other classifier is case-insensitive. The category
 * downstream (host reputation, cooldown, alerts) depends on this.
 */
import { describe, it, expect } from 'vitest';
import { categorizeDeployFailure } from '../../server/gpu-deploy-tiers';

describe('categorizeDeployFailure — case-insensitive api_error', () => {
  it('classifies lowercase "api" mentions as api_error (case-insensitive)', () => {
    expect(categorizeDeployFailure('api auth failed')).toBe('api_error');
    expect(categorizeDeployFailure('Api authorization rejected')).toBe('api_error');
  });

  it('still classifies uppercase "API" as api_error (regression)', () => {
    expect(categorizeDeployFailure('API call returned 500')).toBe('api_error');
  });

  it('classifies HTTP error codes regardless of casing', () => {
    expect(categorizeDeployFailure('upstream returned 401')).toBe('api_error');
    expect(categorizeDeployFailure('got 403 forbidden')).toBe('api_error');
  });
});
