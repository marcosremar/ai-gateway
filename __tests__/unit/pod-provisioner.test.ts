/**
 * Unit tests for server/pod-provisioner.ts — buildEnvFile
 *
 * buildEnvFile() is a pure function that serialises a ProvisionConfig into a
 * shell-env file written to /etc/aigw-agent.env on the remote pod.  The key
 * security invariant is: ANTHROPIC_API_KEY is only shipped when `devClis`
 * explicitly requests Claude Code (matches "claude", "all", or "1").  Tests
 * here pin that invariant together with the full output format.
 */

import { describe, it, expect } from 'vitest';
import { buildEnvFile } from '../../server/pod-provisioner';
import type { ProvisionConfig } from '../../server/pod-provisioner';

// ── helpers ──────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<ProvisionConfig> = {}): ProvisionConfig {
  return {
    sshHost: 'host.example.com',
    sshPort: 22,
    podId: 'pod-abc123',
    ...overrides,
  };
}

/** Parse KEY=VALUE lines into a map for assertion convenience. */
function parseEnv(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue; // skip blank lines
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

// ── mandatory fields ─────────────────────────────────────────────────────────

describe('buildEnvFile — mandatory fields', () => {
  it('includes AIGW_POD_ID', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ podId: 'pod-xyz' })));
    expect(env.AIGW_POD_ID).toBe('pod-xyz');
  });

  it('defaults AIGW_INTERVAL to 30', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.AIGW_INTERVAL).toBe('30');
  });

  it('uses provided heartbeatInterval', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ heartbeatInterval: 60 })));
    expect(env.AIGW_INTERVAL).toBe('60');
  });

  it('defaults BACKUP_INTERVAL_HOURS to 6', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.BACKUP_INTERVAL_HOURS).toBe('6');
  });

  it('uses provided backupIntervalHours', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ backupIntervalHours: 12 })));
    expect(env.BACKUP_INTERVAL_HOURS).toBe('12');
  });

  it('defaults BACKUP_CHECK_SECS to 120', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.BACKUP_CHECK_SECS).toBe('120');
  });

  it('uses provided backupCheckSecs', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ backupCheckSecs: 60 })));
    expect(env.BACKUP_CHECK_SECS).toBe('60');
  });

  it('output ends with a trailing newline', () => {
    expect(buildEnvFile(baseConfig())).toMatch(/\n$/);
  });
});

// ── optional gateway fields ───────────────────────────────────────────────────

describe('buildEnvFile — optional gateway fields', () => {
  it('omits AIGW_URL when gatewayUrl not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.AIGW_URL).toBeUndefined();
  });

  it('includes AIGW_URL when gatewayUrl is set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ gatewayUrl: 'https://gw.example.com' })));
    expect(env.AIGW_URL).toBe('https://gw.example.com');
  });

  it('omits AIGW_TOKEN when gatewayToken not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.AIGW_TOKEN).toBeUndefined();
  });

  it('includes AIGW_TOKEN when gatewayToken is set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ gatewayToken: 'tok-secret' })));
    expect(env.AIGW_TOKEN).toBe('tok-secret');
  });

  it('omits AIGW_LOG_FILE when appLogFile not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.AIGW_LOG_FILE).toBeUndefined();
  });

  it('includes AIGW_LOG_FILE when appLogFile is set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ appLogFile: '/logs/app.log' })));
    expect(env.AIGW_LOG_FILE).toBe('/logs/app.log');
  });

  it('omits WORKSPACE_RESTORE_FROM when restoreFrom not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.WORKSPACE_RESTORE_FROM).toBeUndefined();
  });

  it('includes WORKSPACE_RESTORE_FROM when restoreFrom is set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ restoreFrom: 'r2://bucket/workspace' })));
    expect(env.WORKSPACE_RESTORE_FROM).toBe('r2://bucket/workspace');
  });
});

// ── devClis + ANTHROPIC_API_KEY security invariant ───────────────────────────

describe('buildEnvFile — devClis: ANTHROPIC_API_KEY inclusion', () => {
  const apiKey = 'sk-ant-test-key';

  it('does NOT include AIGW_DEV_CLIS when devClis is absent', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ anthropicApiKey: apiKey })));
    expect(env.AIGW_DEV_CLIS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('includes AIGW_DEV_CLIS but NOT ANTHROPIC_API_KEY for non-claude devClis', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'opencode', anthropicApiKey: apiKey })));
    expect(env.AIGW_DEV_CLIS).toBe('opencode');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('ships ANTHROPIC_API_KEY for devClis="claude"', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'claude', anthropicApiKey: apiKey })));
    expect(env.AIGW_DEV_CLIS).toBe('claude');
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('ships ANTHROPIC_API_KEY for devClis="all"', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'all', anthropicApiKey: apiKey })));
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('ships ANTHROPIC_API_KEY for devClis="1" (short form)', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: '1', anthropicApiKey: apiKey })));
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('ships ANTHROPIC_API_KEY for devClis="claude,opencode" (claude first)', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'claude,opencode', anthropicApiKey: apiKey })));
    expect(env.AIGW_DEV_CLIS).toBe('claude,opencode');
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('ships ANTHROPIC_API_KEY for devClis="opencode,claude" (claude last)', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'opencode,claude', anthropicApiKey: apiKey })));
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('ships ANTHROPIC_API_KEY for devClis="opencode,all,cursor"', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'opencode,all,cursor', anthropicApiKey: apiKey })));
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('does NOT ship ANTHROPIC_API_KEY for devClis="1claudekit" (no boundary match)', () => {
    // "1claudekit" contains "1" as a substring but not at a csv boundary
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: '1claudekit', anthropicApiKey: apiKey })));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does NOT ship ANTHROPIC_API_KEY when anthropicApiKey is absent even if devClis=claude', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ devClis: 'claude' })));
    expect(env.AIGW_DEV_CLIS).toBe('claude');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ── S3 / B2 credentials ───────────────────────────────────────────────────────

describe('buildEnvFile — S3/B2 credentials', () => {
  const s3Minimal = { accountId: 'acc', applicationKey: 'appkey', bucket: 'mybucket' };

  it('omits all B2_ vars when s3 is absent', () => {
    const env = parseEnv(buildEnvFile(baseConfig()));
    expect(env.B2_ACCOUNT_ID).toBeUndefined();
    expect(env.B2_APPLICATION_KEY).toBeUndefined();
    expect(env.B2_BUCKET).toBeUndefined();
  });

  it('includes mandatory S3 fields', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: s3Minimal })));
    expect(env.B2_ACCOUNT_ID).toBe('acc');
    expect(env.B2_APPLICATION_KEY).toBe('appkey');
    expect(env.B2_BUCKET).toBe('mybucket');
  });

  it('omits optional B2_ENDPOINT when not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: s3Minimal })));
    expect(env.B2_ENDPOINT).toBeUndefined();
  });

  it('includes B2_ENDPOINT when provided', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: { ...s3Minimal, endpoint: 'https://s3.cloudflare.com' } })));
    expect(env.B2_ENDPOINT).toBe('https://s3.cloudflare.com');
  });

  it('omits optional B2_REGION when not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: s3Minimal })));
    expect(env.B2_REGION).toBeUndefined();
  });

  it('includes B2_REGION when provided', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: { ...s3Minimal, region: 'us-east-1' } })));
    expect(env.B2_REGION).toBe('us-east-1');
  });

  it('omits optional B2_PREFIX when not set', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: s3Minimal })));
    expect(env.B2_PREFIX).toBeUndefined();
  });

  it('includes B2_PREFIX when provided', () => {
    const env = parseEnv(buildEnvFile(baseConfig({ s3: { ...s3Minimal, prefix: 'workspace/' } })));
    expect(env.B2_PREFIX).toBe('workspace/');
  });

  it('includes all optional S3 fields together', () => {
    const env = parseEnv(buildEnvFile(baseConfig({
      s3: { ...s3Minimal, endpoint: 'https://r2.example.com', region: 'auto', prefix: 'pod/' },
    })));
    expect(env.B2_ENDPOINT).toBe('https://r2.example.com');
    expect(env.B2_REGION).toBe('auto');
    expect(env.B2_PREFIX).toBe('pod/');
  });
});

// ── output format ─────────────────────────────────────────────────────────────

describe('buildEnvFile — output format', () => {
  it('produces KEY=VALUE lines with no spaces around =', () => {
    const out = buildEnvFile(baseConfig({ gatewayUrl: 'https://gw.example.com' }));
    for (const line of out.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^[A-Z_]+=.*/);
    }
  });

  it('does not produce any blank mid-file lines (only trailing newline is blank)', () => {
    const out = buildEnvFile(baseConfig({ gatewayUrl: 'https://x.com', gatewayToken: 'tok' }));
    const lines = out.split('\n');
    // Only the very last element (after trailing \n) may be empty
    const midLines = lines.slice(0, -1);
    expect(midLines.every(l => l.length > 0)).toBe(true);
  });

  it('full config produces expected line count', () => {
    const out = buildEnvFile(baseConfig({
      gatewayUrl: 'https://gw.example.com',
      gatewayToken: 'tok',
      appLogFile: '/logs/app.log',
      restoreFrom: 'r2://bucket/ws',
      devClis: 'claude,opencode',
      anthropicApiKey: 'sk-ant',
      s3: { accountId: 'a', applicationKey: 'k', bucket: 'b', endpoint: 'e', region: 'r', prefix: 'p/' },
    }));
    // 4 mandatory + 4 optional gateway + 2 devClis lines + 6 S3 lines = 16
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(16);
  });
});
