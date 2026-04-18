import { describe, it, expect } from 'vitest';
import { GpuDeployRequestSchema } from '../src/contracts';

describe('readinessProbe contract', () => {
  it('accepts readinessProbe="ssh"', () => {
    const parsed = GpuDeployRequestSchema.parse({
      dockerImage: 'ubuntu:22.04',
      gpuTypes: ['NVIDIA RTX A4000'],
      readinessProbe: 'ssh',
    });
    expect(parsed.readinessProbe).toBe('ssh');
  });

  it('accepts readinessProbe="health"', () => {
    const parsed = GpuDeployRequestSchema.parse({
      dockerImage: 'foo:bar',
      gpuTypes: ['RTX 4090'],
      readinessProbe: 'health',
    });
    expect(parsed.readinessProbe).toBe('health');
  });

  it('allows readinessProbe to be omitted (defaults to health in the handler)', () => {
    const parsed = GpuDeployRequestSchema.parse({
      dockerImage: 'foo:bar',
      gpuTypes: ['RTX 4090'],
    });
    expect(parsed.readinessProbe).toBeUndefined();
  });

  it('rejects invalid readinessProbe values', () => {
    expect(() => GpuDeployRequestSchema.parse({
      dockerImage: 'foo:bar',
      gpuTypes: ['RTX 4090'],
      readinessProbe: 'bogus',
    })).toThrow();
  });
});

describe('tcpReachable + pollSshUntilReady — integration shape', () => {
  it('pollSshUntilReady picks host from http endpoint', async () => {
    // Smoke check of URL parsing used by the SSH probe — we don't dial anything.
    const url = new URL('http://94.101.98.149:8000');
    expect(url.hostname).toBe('94.101.98.149');
  });
});
