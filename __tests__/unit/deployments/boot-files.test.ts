import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOT_FILES_PATH, bootFile, bootFilesRoute, filesByUrl, signedFileUrls } from '../../../src/deployments/boot-files';
import { fetchFilesScript } from '../../../src/deployments/cloud-init';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec, vastRefusal } from '../../../src/deployments/spec';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const VOICE = Buffer.from('RIFF-reference-voice-of-a-real-person');
const spec = buildSpec('parle-speech', {
  image: 'ghcr.io/me/speech-stack:1', bootScript: 'serve', port: 8010, machineType: 'L40S-1-48G', maxEurPerHour: 2, bootTimeoutMinutes: 45,
  files: { 'voices.json': Buffer.from('{"lia":"lia.wav"}').toString('base64'), 'lia.wav': VOICE.toString('base64') },
}, { profiles });
const source = { specOf: (name: string) => (name === spec.name ? spec : null), deploymentSecretsOf: (name: string) => (name === spec.name ? [TOKEN] : []) };
const NOW = 1_760_000_000_000;
const EXP = NOW / 1000 + 600;
const query = (url: string) => new URL(url).searchParams;

describe('signed boot files', () => {
  const urls = signedFileUrls(spec, TOKEN, 'https://gw.example/', EXP);

  it('one link per file, with the sha256 of its bytes and nothing of the replica token or an API key in it', () => {
    expect(Object.keys(urls)).toEqual(['voices.json', 'lia.wav']);
    expect(urls['lia.wav'].sha256).toBe(createHash('sha256').update(VOICE).digest('hex'));
    expect(urls['lia.wav'].url).toMatch(new RegExp(`^https://gw\\.example${BOOT_FILES_PATH}\\?d=parle-speech&k=lia\\.wav&exp=${EXP}&sig=[A-Za-z0-9_-]{43}$`));
    expect(urls['lia.wav'].url).not.toContain(TOKEN);
  });

  it('the link returns the bytes until it expires', () => {
    expect(bootFile(source, query(urls['lia.wav'].url), NOW)).toEqual(VOICE);
    expect(bootFile(source, query(urls['lia.wav'].url), EXP * 1000)).toEqual(VOICE);
    expect(bootFile(source, query(urls['lia.wav'].url), EXP * 1000 + 1)).toBeNull();
  });

  it('a link opens its own file only: another key, a later expiry, another deployment or another token do not verify', () => {
    const tamper = (change: (q: URLSearchParams) => void) => { const q = query(urls['lia.wav'].url); change(q); return q; };
    expect(bootFile(source, tamper(q => q.set('k', 'voices.json')), NOW)).toBeNull();
    expect(bootFile(source, tamper(q => q.set('exp', String(EXP + 3600))), NOW)).toBeNull();
    expect(bootFile(source, tamper(q => q.set('d', 'other')), NOW)).toBeNull();
    expect(bootFile(source, tamper(q => q.set('sig', '')), NOW)).toBeNull();
    expect(bootFile(source, tamper(q => q.delete('sig')), NOW)).toBeNull();
    expect(bootFile(source, tamper(q => q.set('sig', TOKEN)), NOW)).toBeNull();
    expect(bootFile({ ...source, deploymentSecretsOf: () => ['another-replica-token-0123456789'] }, query(urls['lia.wav'].url), NOW)).toBeNull();
    const gone = signedFileUrls({ ...spec, files: { ...spec.files, 'old.wav': 'YQ==' } }, TOKEN, 'https://gw.example', EXP)['old.wav'].url;
    expect(bootFile(source, query(gone), NOW)).toBeNull();
    expect(bootFile(source, new URLSearchParams(), NOW)).toBeNull();
  });

  it('filesByUrl turns files into fileUrls valid for the boot timeout, keeps existing fileUrls, and is a no-op without a public URL', () => {
    const withUrl = { ...spec, fileUrls: { 'big.bin': { url: 'https://cdn.example/big.bin', sha256: 'a'.repeat(64) } } };
    const moved = filesByUrl(withUrl, TOKEN, 'https://gw.example', NOW);
    expect(moved.files).toBeUndefined();
    expect(Object.keys(moved.fileUrls!)).toEqual(['big.bin', 'voices.json', 'lia.wav']);
    expect(query(moved.fileUrls!['lia.wav'].url).get('exp')).toBe(String(NOW / 1000 + 45 * 60));
    expect(vastRefusal({ ...moved, provider: 'vast', machineType: 'RTX 5090' }, true)).toBeNull();
    expect(vastRefusal({ ...spec, provider: 'vast', machineType: 'RTX 5090' }, true)).toMatch(/files are not supported on vast/);
    expect(filesByUrl(spec, TOKEN, undefined, NOW)).toBe(spec);
    expect(fetchFilesScript(moved.fileUrls)).toContain(`aigw_fetch '${moved.fileUrls!['lia.wav'].url}' /srv/aigw/files/lia.wav ${moved.fileUrls!['lia.wav'].sha256}`);
  });
});

describe('GET /v1/boot-files', () => {
  const route = bootFilesRoute(source, () => NOW);
  const server = createServer((req, res) => { void route.handler(req, res); });
  afterEach(() => new Promise<void>((done) => { server.close(() => done()); }));

  it('serves the file to the signed link without any API key and answers the same 404 to everything else', async () => {
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { url, sha256 } = signedFileUrls(spec, TOKEN, base, EXP)['lia.wav'];
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(createHash('sha256').update(Buffer.from(await ok.arrayBuffer())).digest('hex')).toBe(sha256);
    const answers = await Promise.all([
      `${base}${BOOT_FILES_PATH}`, `${base}${BOOT_FILES_PATH}?d=parle-speech`, `${base}${BOOT_FILES_PATH}?d=parle-speech&k=lia.wav`,
      url.replace('k=lia.wav', 'k=voices.json'), url.replace('d=parle-speech', 'd=nothing'), `${url}x`,
    ].map(async (u) => { const res = await fetch(u); return [res.status, await res.text()]; }));
    expect(new Set(answers.map(a => JSON.stringify(a)))).toEqual(new Set(['[404,"{\\"error\\":\\"not found\\"}"]']));
    expect(route).toMatchObject({ method: 'GET', path: '/v1/boot-files' });
  });
});
