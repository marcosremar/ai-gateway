import { describe, it, expect } from 'vitest';
import {
  buildCloudInit,
  b64,
  buildEnvFlags,
  buildExportLines,
  buildMonitorScript,
} from '@ai-gateway/gpu-providers/tensordock-cloud-init';

/** Decode base64 content from a write_files entry */
function decodeFile(config: Record<string, unknown>, filePath: string): string {
  const files = config.write_files as Array<{ path: string; content: string; encoding?: string }>;
  const entry = files.find(f => f.path === filePath);
  if (!entry) throw new Error(`File ${filePath} not found in write_files`);
  if (entry.encoding === 'b64') {
    return Buffer.from(entry.content, 'base64').toString('utf-8');
  }
  return entry.content;
}

describe('buildEnvFlags', () => {
  it('returns empty string for no env', () => {
    expect(buildEnvFlags()).toBe('');
    expect(buildEnvFlags({})).toBe('');
  });

  it('generates -e KEY=VALUE flags', () => {
    const result = buildEnvFlags({ FOO: 'bar', BAZ: 'qux' });
    expect(result).toContain('-e FOO="bar"');
    expect(result).toContain('-e BAZ="qux"');
  });
});

describe('buildExportLines', () => {
  it('returns empty string for no env', () => {
    expect(buildExportLines()).toBe('');
    expect(buildExportLines({})).toBe('');
  });

  it('generates export KEY=VALUE lines', () => {
    const result = buildExportLines({ FOO: 'bar', BAZ: 'qux' });
    expect(result).toContain('export FOO="bar"');
    expect(result).toContain('export BAZ="qux"');
  });
});

describe('buildMonitorScript', () => {
  it('generates a python script with phase-aware /health', () => {
    const script = buildMonitorScript({ setup: '/var/log/setup.log' });
    expect(script).toContain('#!/usr/bin/env python3');
    expect(script).toContain('STATE_FILE = "/tmp/parle-setup-state.json"');
    expect(script).toContain('def probe_app():');
    expect(script).toContain('"phase":');
    expect(script).toContain('"progress_pct":');
    expect(script).toContain('"elapsed_secs":');
    expect(script).toContain('"healthy":');
    expect(script).toContain('Monitor on :9090');
  });

  it('includes log file entries in debug output', () => {
    const script = buildMonitorScript({
      setup: '/var/log/setup.log',
      app: '/var/log/app.log',
    });
    expect(script).toContain('"setup": tail("/var/log/setup.log")');
    expect(script).toContain('"app": tail("/var/log/app.log")');
  });
});

describe('buildCloudInit — Docker mode', () => {
  it('generates cloud-init with write_files and bootstrap runcmd', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    expect(config.write_files).toBeDefined();
    // runcmd bootstraps the setup service (chmod, systemctl enable, launch)
    expect(Array.isArray(config.runcmd)).toBe(true);
    expect(config.bootcmd).toBeUndefined();
  });

  it('setup script includes write_phase calls', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('write_phase');
    expect(setup).toContain('"initializing"');
    expect(setup).toContain('"installing_toolkit"');
    expect(setup).toContain('"pulling_image"');
    expect(setup).toContain('"starting_container"');
    expect(setup).toContain('"ready"');
  });

  it('setup script includes nvidia-container-toolkit check', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('nvidia-container-toolkit');
    expect(setup).toContain('docker run --gpus all --rm nvidia/cuda');
  });

  it('setup script includes docker pull with retries', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('for i in 1 2 3');
    expect(setup).toContain('docker pull myimage:latest');
    expect(setup).toContain('PULL_OK');
  });

  it('setup script includes GPU fallback chain', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('--gpus all');
    expect(setup).toContain('--runtime=nvidia');
    // CPU-only fallback
    expect(setup).toContain('CPU-only fallback');
  });

  it('setup script includes container watchdog', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('Container died within 60s');
    expect(setup).toContain('sleep 60');
  });

  it('passes HF_TOKEN as env flag', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest', hfToken: 'hf_abc123' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('HF_TOKEN');
    expect(setup).toContain('hf_abc123');
  });

  it('passes extra env vars as -e flags', () => {
    const config = buildCloudInit({
      dockerImage: 'myimage:latest',
      env: { MY_VAR: 'hello', OTHER: 'world' },
    });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('-e MY_VAR="hello"');
    expect(setup).toContain('-e OTHER="world"');
  });

  it('includes HF cache volume mount', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('/root/hf-models:/root/.cache/huggingface/hub');
  });

  it('monitor script is phase-aware', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const monitor = decodeFile(config, '/opt/monitor.py');
    expect(monitor).toContain('parle-setup-state.json');
    expect(monitor).toContain('probe_app');
    expect(monitor).toContain('"phase"');
  });

  it('runcmd enables the setup service via systemctl', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    const runcmd = (config.runcmd as string[]).join('\n');
    expect(runcmd).toContain('systemctl');
    expect(runcmd).toContain('setup');
  });
});

describe('buildCloudInit — Git clone mode', () => {
  it('generates cloud-init with write_files and bootstrap runcmd', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    expect(config.write_files).toBeDefined();
    expect(Array.isArray(config.runcmd)).toBe(true);
  });

  it('setup script uses uv for fast package management', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('astral.sh/uv/install.sh');
    expect(setup).toContain('uv venv');
    expect(setup).toContain('uv pip install');
  });

  it('setup script creates Python venv', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('venv');
    expect(setup).toContain('source /opt/parle/.venv/bin/activate');
  });

  it('setup script includes git clone with retries', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('for i in 1 2 3');
    expect(setup).toContain('git clone');
    expect(setup).toContain('CLONE_OK');
  });

  it('supports both requirements.txt and pyproject.toml', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('requirements.txt');
    expect(setup).toContain('pyproject.toml');
  });

  it('runs download_models.py if it exists', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('download_models.py');
  });

  it('waits for app on :8000', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('localhost:8000/health');
    expect(setup).toContain('seq 1 30');
    expect(setup).toContain('sleep 2');
  });

  it('exports extra env vars before app start', () => {
    const config = buildCloudInit({
      hfRepoUrl: 'user/repo',
      env: { MY_VAR: 'hello' },
    });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('export MY_VAR="hello"');
  });

  it('opens WebRTC UDP ports', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('50000:51000/udp');
  });

  it('includes write_phase calls', () => {
    const config = buildCloudInit({ hfRepoUrl: 'user/repo' });
    const setup = decodeFile(config, '/opt/setup.sh');
    expect(setup).toContain('write_phase');
    expect(setup).toContain('"initializing"');
    expect(setup).toContain('"installing_deps"');
    expect(setup).toContain('"cloning_repo"');
    expect(setup).toContain('"downloading_models"');
    expect(setup).toContain('"starting_app"');
  });
});

describe('buildCloudInit — SSH key injection', () => {
  it('injects SSH key into write_files + ssh_authorized_keys', () => {
    const config = buildCloudInit({
      dockerImage: 'myimage:latest',
      sshPubKey: 'ssh-ed25519 AAAA testkey',
    });
    expect(config.ssh_authorized_keys).toEqual(['ssh-ed25519 AAAA testkey']);

    const files = config.write_files as Array<{ path: string }>;
    const rootKey = files.find(f => f.path === '/root/.ssh/authorized_keys');
    expect(rootKey).toBeDefined();
    const userKey = files.find(f => f.path === '/home/user/.ssh/authorized_keys');
    expect(userKey).toBeDefined();
    const sshFix = files.find(f => f.path === '/opt/fix-ssh.sh');
    expect(sshFix).toBeDefined();
  });

  it('sets password fallback', () => {
    const config = buildCloudInit({ dockerImage: 'myimage:latest' });
    expect(config.password).toMatch(/^gpu-[0-9a-f]{16}$/);
    expect(config.chpasswd).toEqual({ expire: false });
  });
});

describe('b64', () => {
  it('encodes string to base64', () => {
    expect(b64('hello')).toBe(Buffer.from('hello').toString('base64'));
  });
});
