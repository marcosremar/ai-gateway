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
    [{ port: 8000 }, /image or bootScript is required/],
    [{ image: 'a', port: 8000, provider: 'vast' }, /vast replicas need bootScript and image/],
    [{ image: 'a', port: 8000, provider: 'aws' }, /provider must be 'scaleway' or 'vast'/],
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

describe('boot-script mode', () => {
  it('needs no image, defaults the upstream to 127.0.0.1:8000 and runs the script after the nginx front', () => {
    const spec = buildSpec('vm', { bootScript: 'echo hello', files: { 'ref-1': Buffer.from('abc').toString('base64') } }, { profiles });
    expect(spec.image).toBe('');
    const script = replicaCloudInit(spec, TOKEN);
    expect(script).not.toContain('docker run');
    expect(script).toContain(Buffer.from('echo hello').toString('base64'));
    expect(script.indexOf('systemctl restart nginx')).toBeLessThan(script.indexOf('/srv/aigw/boot.sh'));
    expect(script).toContain('curl -sf -o /dev/null http://127.0.0.1:8000/health');
  });

  it('rejects files that do not fit in 14 packed user_data keys', () => {
    const big = Buffer.alloc(14 * 120_000 + 1).toString('base64');
    expect(() => buildSpec('x', { bootScript: 'x', files: { a: big } }, { profiles })).toThrow(/fit in Scaleway/);
  });

  it('a Docker app gets its files read-only at /files', () => {
    const spec = buildSpec('x', { image: 'me/app:1', port: 8000, files: { 'voices.json': 'W10=' } }, { profiles });
    expect(dockerRunCommand(spec)).toContain('-v /srv/aigw/files:/files:ro');
    expect(replicaCloudInit(spec, TOKEN)).toContain('/srv/aigw/files/voices.json');
  });

  it('rejects bad file keys and non-base64', () => {
    expect(() => buildSpec('x', { bootScript: 'x', files: { 'cloud-init': 'YQ==' } }, { profiles })).toThrow(/key/);
    expect(() => buildSpec('x', { bootScript: 'x', files: { a: 'not base64!' } }, { profiles })).toThrow(/base64/);
  });
});

describe('exposure and idleAction', () => {
  const base = { image: 'a/b:1', port: 7880 };
  it('accepts tcp/udp ports and the stop idle action', () => {
    const spec = buildSpec('rtc', { ...base, idleAction: 'stop', exposure: { ports: [{ protocol: 'udp', port: 7882 }, { protocol: 'tcp', port: 443 }] } },
      { profiles: new Map() });
    expect(spec.exposure?.ports).toEqual([{ protocol: 'udp', port: 7882 }, { protocol: 'tcp', port: 443 }]);
    expect(spec.idleAction).toBe('stop');
  });

  it('refuses the probe port, empty or bad ports, and unknown idle actions', () => {
    const bad = (body: Record<string, unknown>) => () => buildSpec('rtc', { ...base, ...body }, { profiles: new Map() });
    expect(bad({ exposure: { ports: [{ protocol: 'tcp', port: 8089 }] } })).toThrow(/probe port/);
    expect(bad({ exposure: { ports: [] } })).toThrow(/1–20 ports/);
    expect(bad({ exposure: { ports: [{ protocol: 'icmp', port: 1 }] } })).toThrow(/tcp' or 'udp/);
    expect(bad({ idleAction: 'hibernate' })).toThrow(/idleAction/);
  });
});

describe('candidates, near and provider vast', () => {
  const vast = { provider: 'vast', image: 'vllm/vllm-omni:v0.28.0', bootScript: 'serve', machineType: 'RTX 5090' };

  it('accepts a ladder across Scaleway zones and Vast, plus near/allowFar', () => {
    const spec = buildSpec('speech', {
      bootScript: 'serve', image: 'vllm/vllm-omni:v0.28.0', near: 'FR', allowFar: false,
      candidates: [
        { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 0.9 },
        { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.6 },
      ],
    }, { profiles });
    expect(spec.candidates).toEqual([
      { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 0.9 },
      { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.6 },
    ]);
    expect(spec.near).toBe('FR');
  });

  it.each([
    [{ candidates: [] }, /1–20 entries/],
    [{ candidates: Array(21).fill({ machineType: 'L4-1-24G', maxEurPerHour: 1 }) }, /1–20 entries/],
    [{ candidates: [{ machineType: 'L4-1-24G', maxEurPerHour: 1, gpu: 'x' }] }, /unknown field 'gpu'/],
    [{ candidates: [{ machineType: 'L4-1-24G' }] }, /candidates\[0\].maxEurPerHour/],
    [{ candidates: [{ machineType: 'L4-1-24G', maxEurPerHour: 1, zone: 'paris' }] }, /candidates\[0\].zone/],
    [{ candidates: [{ machineType: 'L4-1-24G', maxEurPerHour: 1, provider: 'aws' }] }, /'scaleway' or 'vast'/],
    [{ candidates: [{ machineType: 'RTX 5090', maxEurPerHour: 1 }] }, /not a Scaleway type/],
    [{ near: 'France' }, /near is invalid/],
  ])('rejects %j', (body, message) => {
    expect(() => buildSpec('x', { image: 'a', port: 8000, ...body }, { profiles })).toThrow(message);
  });

  it('vast: boot-script mode with the base image, GPU on, any port; no files, exposure or stop', () => {
    const spec = buildSpec('x', { ...vast, port: 8010 }, { profiles });
    expect(spec).toMatchObject({ provider: 'vast', gpu: true, port: 8010, machineType: 'RTX 5090' });
    expect(() => buildSpec('x', { ...vast, port: 8000, bootScript: undefined }, { profiles })).toThrow(/need bootScript and image/);
    expect(() => buildSpec('x', { ...vast, files: { a: 'YQ==' } }, { profiles })).toThrow(/files are not supported on vast/);
    expect(() => buildSpec('x', { ...vast, exposure: { ports: [{ protocol: 'tcp', port: 443 }] } }, { profiles })).toThrow(/exposure/);
    expect(() => buildSpec('x', { ...vast, idleAction: 'stop' }, { profiles })).toThrow(/idleAction 'stop'/);
    // A Vast candidate on a Scaleway spec brings the same rules.
    expect(() => buildSpec('x', { image: 'a', port: 8000, candidates: [{ provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 1 }] },
      { profiles })).toThrow(/need bootScript and image/);
  });
});
