import { describe, expect, it } from 'vitest';
import { dockerRunCommand, nginxConfig, replicaCloudInit, shellQuote } from '../../../src/deployments/cloud-init';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec, parsePartialSpec, SpecError } from '../../../src/deployments/spec';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

describe('buildSpec', () => {
  it('fills defaults: Scaleway L4 in fr-par-2, scale to zero, GPU on', () => {
    const spec = buildSpec('my-model', { image: 'me/app:1', port: 8000 }, { profiles });
    expect(spec).toMatchObject({
      provider: 'scaleway', machineType: 'L4-1-24G', zone: 'fr-par-2', gpu: true, minReplicas: 0, maxReplicas: 1,
      healthPath: '/health', coldStartWaitSeconds: 240,
    });
  });

  it('starts from a profile and lets the body override it', () => {
    const spec = buildSpec('tts', { profile: 'qwen3-tts', maxReplicas: 3 }, { profiles });
    expect(spec.image).toBe('vllm/vllm-omni:v0.28.0');
    expect(spec.args).toContain('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice');
    expect(spec.maxReplicas).toBe(3);
  });

  it('an update keeps previous fields and only changes what the body sends', () => {
    const previous = buildSpec('tts', { profile: 'qwen3-tts' }, { profiles });
    const next = buildSpec('tts', { minReplicas: 1 }, { profiles, previous });
    expect(next.image).toBe(previous.image);
    expect(next.minReplicas).toBe(1);
  });

  it('CPU machine types run without --gpus', () => {
    expect(buildSpec('echo', { profile: 'cpu-echo' }, { profiles }).gpu).toBe(false);
    expect(() => buildSpec('x', { image: 'a', port: 1, machineType: 'DEV1-S', gpu: true }, { profiles })).toThrow(SpecError);
  });

  it.each([
    [{ port: 8000 }, /image is required/],
    [{ image: 'a', port: 8000, provider: 'vast' }, /only one supported/],
    [{ image: 'a', port: 8000, minReplicas: 3, maxReplicas: 2 }, /minReplicas cannot exceed/],
    [{ image: 'a', port: 8000, maxReplicas: 99 }, /maxReplicas/],
    [{ image: 'a', port: 8000, env: { 'BAD KEY': 'x' } }, /env key/],
    [{ image: 'a', port: 8000, env: { A: 'multi\nline' } }, /single-line/],
    [{ image: 'a', port: 8000, nope: 1 }, /unknown field/],
    [{ image: 'a; rm -rf /', port: 8000 }, /image is invalid/],
    [{ profile: 'missing' }, /unknown profile/],
  ])('rejects %j', (body, message) => {
    expect(() => buildSpec('ok-name', body as Record<string, unknown>, { profiles })).toThrow(message);
  });

  it('rejects bad names', () => {
    expect(() => buildSpec('Bad_Name', { image: 'a', port: 1 }, { profiles })).toThrow(/name/);
  });

  it('parsePartialSpec accepts numeric strings for integers', () => {
    expect(parsePartialSpec({ maxReplicas: '2' }).maxReplicas).toBe(2);
  });
});

describe('cloud-init', () => {
  it('shell-quotes every user value', () => {
    expect(shellQuote(`it's $(x)`)).toBe(`'it'"'"'s $(x)'`);
    const spec = buildSpec('x', { image: 'me/app:1', port: 9000, args: ['--flag', '$(reboot)'], entrypoint: 'python3' }, { profiles });
    const cmd = dockerRunCommand(spec);
    expect(cmd).toContain(`--entrypoint 'python3' 'me/app:1' '--flag' '$(reboot)'`);
    expect(cmd).toContain('-p 127.0.0.1:8000:9000');
    expect(cmd).toContain('--gpus all');
  });

  it('nginx requires the token on every path, including the ready marker', () => {
    const conf = nginxConfig(TOKEN);
    expect(conf.match(new RegExp(`\\$http_x_aigw_token != "${TOKEN}"`, 'g'))).toHaveLength(2);
    expect(conf).toContain('proxy_set_header X-Aigw-Token ""');
  });

  it('env and secrets travel base64-encoded, never as shell text', () => {
    const spec = buildSpec('x', { image: 'me/app:1', port: 1, env: { HF_TOKEN: 'secret value' } }, { profiles });
    const script = replicaCloudInit(spec, TOKEN);
    expect(script).not.toContain('secret value');
    expect(script).toContain(Buffer.from('HF_TOKEN=secret value\n').toString('base64'));
    expect(script).toMatch(/shutdown -h \+750/); // 12 h + 30 min safety net
  });

  it('refuses a weak replica token', () => {
    const spec = buildSpec('x', { image: 'me/app:1', port: 1 }, { profiles });
    expect(() => replicaCloudInit(spec, 'short')).toThrow(/token/);
  });
});
