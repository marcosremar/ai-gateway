import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachineRoutes, jobReportRoute } from '../../../src/machines/http';
import { jobScript } from '../../../src/machines/job-script';
import { clock, FakeMachineCloud, HOUR, input, makeController } from './_fake-machines';

const KEYS: Record<string, string> = { 'k-admin': 'admin', 'k-palco': 'palco', 'k-school': 'school', 'k-student': 'student' };
const userOf = (req: IncomingMessage) => KEYS[(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')] ?? null;

let server: Server | null = null;
afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

async function serve(ctl: ReturnType<typeof makeController>) {
  const handle = createMachineRoutes({
    controller: ctl, userOf, isAdmin: req => userOf(req) === 'admin', allowedUsers: new Set(['palco', 'school']),
  });
  const report = jobReportRoute(ctl);
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === report.path && req.method === 'POST') { void report.handler(req, res); return; }
    if (!handle(req, res, path, req.method ?? 'GET')) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return async (method: string, path: string, key: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
}

const SECRET = 'sk-live-very-secret-value';
const SSH = `ssh-ed25519 ${'A'.repeat(68)} me@laptop`;
const machineBody = {
  provider: 'vast', machineType: 'RTX 4090', maxUsdPerHour: 0.5, image: 'ghcr.io/me/app:1', maxHours: 2,
  env: { API_TOKEN: SECRET }, onstart: `echo ${SECRET} > /x`, sshPublicKey: SSH, ports: [{ protocol: 'tcp', port: 8080 }],
};

describe('machines HTTP', () => {
  it('only admins and MACHINES_USERS rent; owners see only their own; nothing secret comes back', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const call = await serve(makeController({ backends: { vast }, now: c.now }));
    expect((await call('POST', '/v1/machines', 'k-student', machineBody)).status).toBe(403);
    expect((await call('POST', '/v1/machines', 'k-palco', machineBody, { 'X-App': 'school' })).status).toBe(403);
    expect((await call('POST', '/v1/machines', 'k-palco', { ...machineBody, maxHours: undefined })).json.error).toMatch(/maxHours is required/);
    const created = await call('POST', '/v1/machines', 'k-palco', machineBody);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ owner: 'palco', status: 'running', ssh: true, onstart: true, envKeys: ['API_TOKEN'] });
    const id = created.json.id as string;
    for (const r of [created, await call('GET', `/v1/machines/${id}`, 'k-palco'), await call('GET', '/v1/machines', 'k-admin'),
      await call('GET', '/v1/machines/costs', 'k-admin')]) {
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain('AAAAAAAA');
    }
    expect((await call('GET', `/v1/machines/${id}`, 'k-school')).status).toBe(404);
    expect((await call('GET', '/v1/machines', 'k-school')).json.machines).toEqual([]);
    expect((await call('GET', '/v1/machines', 'k-admin')).json).toMatchObject({ namespace: 'prod', scope: 'all' });
    expect((await call('POST', `/v1/machines/${id}/extend`, 'k-palco', { hours: 1 })).json.deadlineAt).toBe(new Date(c.now() + 3 * HOUR).toISOString());
    expect((await call('DELETE', `/v1/machines/${id}`, 'k-palco')).json).toMatchObject({ status: 'released', endReason: 'deleted' });
    expect(vast.released).toHaveLength(1);
  });

  it('job: the machine reports through the public route; a failed job releases its machine; a bad token is refused', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now, publicUrl: 'https://gw.example' });
    const call = await serve(ctl);
    const signed = 'https://bucket.example/in.mp4?X-Amz-Signature=abcdef123';
    const made = await call('POST', '/v1/jobs', 'k-palco', {
      provider: 'vast', machineType: 'RTX 4090', maxUsdPerHour: 0.5, image: 'ghcr.io/me/gvhmr:1', maxHours: 2, command: 'python run.py',
      inputs: [{ url: signed, path: 'in/video.mp4' }], output: { url: 'https://bucket.example/out.tgz?sig=zzz', path: 'out' },
    });
    expect(made.status).toBe(201);
    expect(made.text).not.toContain('X-Amz-Signature');
    expect(made.text).not.toContain('sig=zzz');
    const jobId = made.json.id as string;
    const script = [...vast.machines.values()][0].input!.request.onstart!;
    const token = /T='([^']+)'/.exec(script)![1];
    expect(script).toContain("R='https://gw.example/v1/job-report'");
    expect(made.text).not.toContain(token);

    const report = (tok: string, status: string, exit = '') => call('POST', '/v1/job-report', 'none', 'step 1\nboom', {
      'x-job-id': jobId, 'x-job-token': tok, 'x-job-status': status, 'x-job-exit': exit, 'content-type': 'text/plain',
    });
    expect((await report('wrong', 'failed', '1')).status).toBe(404);
    expect((await report(token, 'running')).status).toBe(200);
    expect((await call('GET', `/v1/jobs/${jobId}`, 'k-palco')).json.status).toBe('running');
    expect((await report(token, 'failed', '3')).status).toBe(200);
    const done = await call('GET', `/v1/jobs/${jobId}`, 'k-palco');
    expect(done.json).toMatchObject({ status: 'failed', exitCode: 3, machine: { status: 'released', endReason: 'job-failed' } });
    expect((await call('GET', `/v1/jobs/${jobId}/logs`, 'k-palco')).text).toBe('step 1\nboom');
    expect(vast.released).toHaveLength(1);
  });

  it('job that never reports ends as timeout at its deadline and its machine goes', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now, publicUrl: 'https://gw.example' });
    const job = await ctl.createJob('palco', input({}, 1), { command: 'sleep 99999', inputs: [], output: null });
    c.advance(2 * HOUR);
    await ctl.reconcile();
    expect(ctl.job(job.id)).toMatchObject({ status: 'timeout' });
    expect(ctl.get(job.machineId)).toMatchObject({ status: 'released', endReason: 'deadline' });
  });

  it('a job whose machine cannot be created fails at once; a succeeded job records the uploaded result', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    const ctl = makeController({ backends: { vast }, now: c.now, publicUrl: 'https://gw.example' });
    vast.failCreate = 'out_of_stock: none';
    await expect(ctl.createJob('palco', input(), { command: 'true', inputs: [], output: null })).rejects.toMatchObject({ status: 409 });
    expect(ctl.jobs('palco')[0]).toMatchObject({ status: 'failed' });
    vast.failCreate = null;
    const job = await ctl.createJob('palco', input(), { command: 'true', inputs: [], output: { url: 'https://b.example/o', path: 'out' } });
    const token = /T='([^']+)'/.exec([...vast.machines.values()][0].input!.request.onstart!)![1];
    const sha = 'a'.repeat(64);
    expect(await ctl.report(job.id, token, { status: 'succeeded', exitCode: 0, log: 'ok', bytes: 1234, sha256: sha })).toBe(true);
    expect(ctl.job(job.id)).toMatchObject({ status: 'succeeded', result: { uploaded: true, bytes: 1234, sha256: sha } });
    expect(ctl.get(job.machineId)!.status).toBe('released');
  });

  it('the job script downloads inputs, runs the command, uploads the result and reports each end', () => {
    const script = jobScript({
      id: 'j-1', token: 't', reportUrl: 'https://gw/v1/job-report', command: "echo 'hi'", inputs: [{ url: 'https://a/b?s=1', path: 'in/x' }],
      output: { url: 'https://o/p', path: 'out' },
    });
    expect(script).toContain("curl -fsSL --retry 3 -o 'in/x' 'https://a/b?s=1'");
    expect(script).toContain("bash -c 'echo '\\''hi'\\''' >> \"$L\" 2>&1; C=$?");
    expect(script).toContain("--upload-file /job/.result.tgz 'https://o/p'");
    expect(script).toMatch(/rep succeeded 0 "\$B" "\$S"; else rep failed "\$C"/);
  });
});
