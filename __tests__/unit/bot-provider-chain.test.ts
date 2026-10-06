/**
 * Unit tests for src/compute/bot-provider-chain.ts
 */

import { describe, it, expect } from 'vitest';
import {
  BOT_NAME_PREFIXES,
  isBotOwnedInstance,
  isBotActiveStatus,
  isBotCleanupCandidate,
  selectBotProviderChain,
  detectBotProviderFromEndpoint,
} from '../../src/compute/bot-provider-chain';

describe('BOT_NAME_PREFIXES', () => {
  it('includes Fly and Railway naming conventions', () => {
    expect(BOT_NAME_PREFIXES).toEqual(['babelcast-bot', 'aigw-bot']);
  });
});

describe('isBotOwnedInstance', () => {
  it('matches babelcast-bot prefix (Fly / Scaleway / RunPod)', () => {
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'babelcast-bot-1710000000' })).toBe(true);
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'babelcast-bot' })).toBe(true);
  });

  it('matches aigw-bot prefix (Railway)', () => {
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'aigw-bot-1710000000' })).toBe(true);
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'aigw-bot' })).toBe(true);
  });

  it('rejects untagged / foreign VMs', () => {
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'parle-livekit' })).toBe(false);
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'parle-qwen-tts' })).toBe(false);
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'other-pod' })).toBe(false);
    expect(isBotOwnedInstance({ instanceId: 'x', instanceName: 'babelcast' })).toBe(false);
  });

  it('rejects missing instanceName (never terminate ALL)', () => {
    expect(isBotOwnedInstance({ instanceId: 'svc-123' })).toBe(false);
    expect(isBotOwnedInstance({ instanceId: 'svc-123', instanceName: '' })).toBe(false);
    expect(isBotOwnedInstance({ instanceId: 'svc-123', instanceName: '   ' })).toBe(false);
  });
});

describe('isBotActiveStatus / isBotCleanupCandidate', () => {
  it('accepts running and booting statuses', () => {
    expect(isBotActiveStatus('running')).toBe(true);
    expect(isBotActiveStatus('RUNNING')).toBe(true);
    expect(isBotActiveStatus('booting')).toBe(true);
    expect(isBotActiveStatus('starting')).toBe(true);
  });

  it('rejects stopped / exited', () => {
    expect(isBotActiveStatus('stopped')).toBe(false);
    expect(isBotActiveStatus('EXITED')).toBe(false);
    expect(isBotActiveStatus(undefined)).toBe(false);
  });

  it('cleanup candidate requires both ownership and active status', () => {
    expect(
      isBotCleanupCandidate({
        instanceId: '1',
        instanceName: 'babelcast-bot-1',
        status: 'running',
      }),
    ).toBe(true);
    expect(
      isBotCleanupCandidate({
        instanceId: '1',
        instanceName: 'parle-livekit',
        status: 'running',
      }),
    ).toBe(false);
    expect(
      isBotCleanupCandidate({
        instanceId: '1',
        instanceName: 'babelcast-bot-1',
        status: 'stopped',
      }),
    ).toBe(false);
  });
});

describe('selectBotProviderChain', () => {
  it('returns empty when no credentials', () => {
    expect(selectBotProviderChain({})).toEqual([]);
  });

  it('orders flyio → railway → scaleway → runpod', () => {
    const chain = selectBotProviderChain({
      FLY_API_TOKEN: 'fly',
      RAILWAY_PROJECT_ID: 'proj',
      RAILWAY_TOKEN: 'rw',
      SCALEWAY_SECRET_KEY: 'scw',
      RUNPOD_API_KEY: 'rp',
    });
    expect(chain.map((c) => c.id)).toEqual(['flyio', 'railway', 'scaleway', 'runpod']);
  });

  it('includes flyio when BOT_FLY_APP_NAME set without token', () => {
    const chain = selectBotProviderChain({ BOT_FLY_APP_NAME: 'babelcast-bot' });
    expect(chain).toEqual([{ id: 'flyio', reason: 'BOT_FLY_APP_NAME set' }]);
  });

  it('includes railway with CLI reason when only PROJECT_ID set', () => {
    const chain = selectBotProviderChain({ RAILWAY_PROJECT_ID: 'proj-1' });
    expect(chain).toEqual([
      { id: 'railway', reason: 'RAILWAY_PROJECT_ID set (CLI auth ok)' },
    ]);
  });

  it('omits railway without PROJECT_ID even if token present', () => {
    expect(selectBotProviderChain({ RAILWAY_TOKEN: 'tok' })).toEqual([]);
  });

  it('skips missing providers', () => {
    const chain = selectBotProviderChain({
      FLY_API_TOKEN: 'fly',
      RUNPOD_API_KEY: 'rp',
    });
    expect(chain.map((c) => c.id)).toEqual(['flyio', 'runpod']);
  });
});

describe('detectBotProviderFromEndpoint', () => {
  it('detects fly / railway / runpod / scaleway', () => {
    expect(detectBotProviderFromEndpoint('https://babelcast-bot.fly.dev')).toBe('flyio');
    expect(detectBotProviderFromEndpoint('https://foo.up.railway.app')).toBe('railway');
    expect(detectBotProviderFromEndpoint('https://abc-8080.proxy.runpod.net')).toBe('runpod');
    expect(detectBotProviderFromEndpoint('http://1.2.3.4.scw.cloud:8080')).toBe('scaleway');
  });

  it('returns null for unknown', () => {
    expect(detectBotProviderFromEndpoint('http://10.0.0.1:8080')).toBeNull();
    expect(detectBotProviderFromEndpoint(undefined)).toBeNull();
  });
});
