import { describe, expect, it } from 'bun:test';

delete process.env.SLACK_WEBHOOK_URL;
delete process.env.DISCORD_WEBHOOK_URL;
delete process.env.ALERT_WEBHOOK_URL;

import { recordDeployEvent, renderGpuTelemetryProm } from './gpu-telemetry';

describe('recordDeployEvent → renderGpuTelemetryProm', () => {
  it('counts a success and buckets boot time cumulatively', () => {
    recordDeployEvent('deploy_ready', 'tvast', true, { durationMs: 45_000, metadata: { gpuType: 'TGPU' } });
    const out = renderGpuTelemetryProm();
    expect(out).toContain('gateway_deploy_attempts_total{provider="tvast",gpu_type="TGPU",result="success"} 1');
    expect(out).toContain('gateway_deploy_boot_time_seconds_bucket{provider="tvast",le="30"} 0');
    expect(out).toContain('gateway_deploy_boot_time_seconds_bucket{provider="tvast",le="60"} 1');
    expect(out).toContain('gateway_deploy_boot_time_seconds_bucket{provider="tvast",le="120"} 1');
    expect(out).toContain('gateway_deploy_boot_time_seconds_bucket{provider="tvast",le="+Inf"} 1');
    expect(out).toContain('gateway_deploy_boot_time_seconds_sum{provider="tvast"} 45.0');
    expect(out).toContain('gateway_deploy_boot_time_seconds_count{provider="tvast"} 1');
  });

  it('counts a failure under its failure category', () => {
    recordDeployEvent('deploy_failed', 'tvast2', false, { error: 'boom', metadata: { gpuType: 'TGPU', failureCategory: 'ssh_timeout' } });
    expect(renderGpuTelemetryProm()).toContain('gateway_deploy_attempts_total{provider="tvast2",gpu_type="TGPU",result="ssh_timeout"} 1');
  });

  it('never throws on malformed events', () => {
    expect(() => recordDeployEvent('weird', '', true)).not.toThrow();
    expect(() => recordDeployEvent('deploy_failed', 'p', false, { metadata: undefined })).not.toThrow();
  });
});
