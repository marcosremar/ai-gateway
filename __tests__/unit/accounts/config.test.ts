import { describe, expect, it } from 'vitest';
import { accountsConfigFromEnv } from '../../../src/accounts/config';

describe('accounts config', () => {
  it('C8: a public base URL that is not an absolute http(s) URL falls back to the default, so e-mailed links still open', () => {
    expect(accountsConfigFromEnv({ ACCOUNTS_PUBLIC_BASE_URL: 'ucast.me' }).publicBaseUrl).toBe('https://ucast.me');
    expect(accountsConfigFromEnv({ ACCOUNTS_PUBLIC_BASE_URL: 'ftp://ucast.me' }).publicBaseUrl).toBe('https://ucast.me');
    expect(accountsConfigFromEnv({ ACCOUNTS_PUBLIC_BASE_URL: 'http://localhost:3000/' }).publicBaseUrl).toBe('http://localhost:3000');
    expect(accountsConfigFromEnv({}).publicBaseUrl).toBe('https://ucast.me');
  });

  it('C9: a plain-http public base gets a non-Secure session cookie unless ACCOUNTS_COOKIE_SECURE says otherwise', () => {
    expect(accountsConfigFromEnv({ ACCOUNTS_PUBLIC_BASE_URL: 'http://localhost:3000' }).cookieSecure).toBe(false);
    expect(accountsConfigFromEnv({ ACCOUNTS_PUBLIC_BASE_URL: 'http://localhost:3000', ACCOUNTS_COOKIE_SECURE: '1' }).cookieSecure).toBe(true);
    expect(accountsConfigFromEnv({}).cookieSecure).toBe(true);
    expect(accountsConfigFromEnv({ ACCOUNTS_COOKIE_SECURE: '0' }).cookieSecure).toBe(false);
  });
});
