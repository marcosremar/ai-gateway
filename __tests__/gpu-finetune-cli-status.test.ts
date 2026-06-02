import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(__dirname, '..', 'bin', 'ai-gateway.ts');

const tempHomes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const dir of tempHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aigw-finetune-cli-'));
  tempHomes.push(home);
  return home;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync('bun', [CLI, ...args], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      HOME: makeHome(),
      AI_GATEWAY_URL: '',
      GATEWAY_URL: '',
      AIGW_APP_KEY: '',
      AI_GATEWAY_KEY: '',
      GATEWAY_API_KEY: '',
      GATEWAY_API_KEYS: '',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function runCliAsync(args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; output: string }>((resolveRun, rejectRun) => {
    const child = spawn('bun', [CLI, ...args], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        HOME: makeHome(),
        AI_GATEWAY_URL: '',
        GATEWAY_URL: '',
        AIGW_APP_KEY: '',
        AI_GATEWAY_KEY: '',
        GATEWAY_API_KEY: '',
        GATEWAY_API_KEYS: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`CLI timed out. Output:\n${output}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, output });
    });
  });
}

function writeFinetuneJob(home: string): void {
  const dir = join(home, '.babelcast', 'finetune_jobs', 'ft-cli-status');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'job.log');
  const specPath = join(dir, 'spec.json');
  const exitPath = join(dir, 'exit.json');
  writeFileSync(specPath, JSON.stringify({
    type: 'flow-matching-tts',
    r2Bucket: 'tts-ptbr-training',
    r2Prefix: 'smoke/full-flow',
  }));
  writeFileSync(logPath, [
    'Provisioning instance',
    'Setting up workspace',
    'hf download dataset',
    'preparing data',
    'encoded.pt ready',
    'Running job: train',
    'step=2/2 loss=0.42',
    'saved erinome_step2.pt',
    '[r2] backup final',
    'terminate may have failed',
    'Job completed',
  ].join('\n'));
  writeFileSync(exitPath, JSON.stringify({ code: 0, endedAt: '2026-05-31T00:05:00.000Z' }));
  writeFileSync(join(dir, 'job.json'), JSON.stringify({
    jobId: 'ft-cli-status',
    status: 'completed',
    spec: {
      type: 'flow-matching-tts',
      r2Bucket: 'tts-ptbr-training',
      r2Prefix: 'smoke/full-flow',
    },
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:05:00.000Z',
    startedAt: '2026-05-31T00:00:00.000Z',
    endedAt: '2026-05-31T00:05:00.000Z',
    exitCode: 0,
    specPath,
    logPath,
    exitPath,
    instanceId: 'inst-test',
    provider: 'vast',
    gpuType: 'RTX 3090',
    pricePerHr: 0.30,
    gpuStartedAt: '2026-05-31T00:00:00.000Z',
    cleanupStatus: 'failed',
    cleanupError: 'termination verification failed',
  }, null, 2));
}

function writeRun(home: string, id: string, ts: string, gpu: string): void {
  const dir = join(home, '.babelcast', 'finetune_runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id,
    ts,
    spec: { type: 'custom', lr: 1e-8, gpu },
    instance: {},
  }));
}

describe('gpu finetune CLI local status', () => {
  it('renders latest durable job status without starting or requiring a gateway', () => {
    const home = makeHome();
    writeFinetuneJob(home);

    const result = runCli(['gpu', 'finetune', 'status'], {
      HOME: home,
      PORT: '65534',
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('gpu finetune status');
    expect(result.output).toContain('job:');
    expect(result.output).toContain('ft-cli-status');
    expect(result.output).toContain('status:');
    expect(result.output).toContain('completed');
    expect(result.output).toContain('B2/S3:');
    expect(result.output).toContain('tts-ptbr-training/smoke/full-flow/checkpoints');
    expect(result.output).toContain('cleanup:');
    expect(result.output).toContain('failed');
    expect(result.output).not.toContain('Starting local gateway');
    expect(result.output).not.toContain('Gateway failed to start');
  });

  it('limits list-runs output and includes job records in the same history view', () => {
    const home = makeHome();
    writeRun(home, 'run-old', '2026-05-31T00:00:00.000Z', '4090');
    writeRun(home, 'run-mid', '2026-05-31T01:00:00.000Z', '5090');
    writeRun(home, 'run-new', '2026-05-31T02:00:00.000Z', '5090');
    writeFinetuneJob(home);

    const result = runCli(['gpu', 'finetune', 'list-runs', '-n', '2'], {
      HOME: home,
      PORT: '65534',
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('Fine-tune runs (2/4');
    expect(result.output).toContain('run-mid');
    expect(result.output).toContain('run-new');
    expect(result.output).not.toContain('run-old');
    expect(result.output).not.toContain('Starting local gateway');
  });
});

describe('CLI gateway discovery', () => {
  it('defaults to the Fly.io gateway even when PORT is present', () => {
    const result = runCli(['version'], {
      PORT: '4000',
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('Gateway: https://parle-ai-gateway.fly.dev');
    expect(result.output).not.toContain('127.0.0.1:4000');
    expect(result.output).not.toContain('localhost:4000');
  });

  it('uses an explicit local gateway URL and sends auth on health checks', async () => {
    const home = makeHome();
    const seen: { healthAuth: Array<string | undefined>; listAuth?: string } = { healthAuth: [] };
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        seen.healthAuth.push(req.headers.authorization);
        res.writeHead(req.headers.authorization === 'Bearer test-key' ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', providerBalances: [] }));
        return;
      }
      if (req.url?.startsWith('/v1/gpu/list')) {
        seen.listAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ instances: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    const port = typeof address === 'object' && address ? String(address.port) : '';

    const result = await runCliAsync(['gpu', 'list', '--mine', '--no-probe'], {
      HOME: home,
      PORT: port,
      GATEWAY_URL: `http://127.0.0.1:${port}`,
      GATEWAY_API_KEY: 'dev-only-key',
      GATEWAY_API_KEYS: 'test-key:default',
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('No active GPU instances');
    expect(result.output).not.toContain('Starting local gateway');
    expect(seen.healthAuth).toContain('Bearer test-key');
    expect(seen.listAuth).toBe('Bearer test-key');
  });
});
