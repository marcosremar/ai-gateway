/**
 * SnapGPU SDK Unit Tests — validates the Python SDK from TypeScript.
 *
 * Tests the SDK + Gateway by running Python subprocess.
 * Also tests the Gateway API directly with fetch.
 *
 * Run: bun run test:snapgpu
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

const PYTHON = '/tmp/snapgpu-venv/bin/python3';
const SKIP = !require('fs').existsSync(PYTHON);

let gatewayProcess: ChildProcess | null = null;
let gatewayPort = 9876;

describe.skipIf(SKIP)('SnapGPU SDK Tests', { timeout: 60_000 }, () => {

  beforeAll(async () => {
    // Start gateway in background
    gatewayProcess = spawn(PYTHON, ['-m', 'uvicorn', 'gateway.main:app', '--host', '127.0.0.1', '--port', String(gatewayPort)], {
      env: { ...process.env, SNAPGPU_DB_URL: 'sqlite:///test-snapgpu.db' },
      stdio: 'pipe',
    });
    // Wait for startup
    await new Promise(r => setTimeout(r, 2000));
  });

  afterAll(() => {
    gatewayProcess?.kill();
    try { require('fs').unlinkSync('test-snapgpu.db'); } catch {}
  });

  it('SDK: App + function decorator + local call', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
import snapgpu
app = snapgpu.App('test')

@app.function(gpu='T4')
def add(a, b): return a + b

assert add.local(2, 3) == 5
assert 'add' in app.registered_functions
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('SDK: Image builder generates Dockerfile', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
import snapgpu
img = snapgpu.Image.debian_slim('3.11').pip_install('numpy', 'torch').apt_install('ffmpeg')
df = img.to_dockerfile()
assert 'FROM python:3.11-slim' in df
assert 'pip install' in df
assert 'numpy' in df
assert 'ffmpeg' in df
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('SDK: GPU presets and parsing', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
import snapgpu
from snapgpu.gpu import parse_gpu, gpu
assert gpu.T4.memory_gb == 16
assert gpu.A100.memory_gb == 80
assert gpu.H100.memory_gb == 80
p = parse_gpu('A100:2')
assert p.count == 2
assert p.name == 'A100'
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('SDK: Volume validation', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
import snapgpu
v = snapgpu.Volume('my-vol', size_gb=100)
assert v.name == 'my-vol'
assert v.size_gb == 100
assert v.persistent == True
try:
    snapgpu.Volume('bad name!')
    assert False, 'should have raised'
except ValueError:
    pass
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('SDK: Cls with enter/exit lifecycle', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
import snapgpu
from snapgpu.cls import enter

app = snapgpu.App('test-cls')

@app.cls(gpu='A100', enable_memory_snapshot=True)
class MyModel:
    @enter(snap=True)
    def load(self): pass

    @enter(snap=False)
    def reconnect(self): pass

    def predict(self, x): return x * 2

spec = app._classes['MyModel'].to_spec()
assert 'load' in spec['snap_true_methods']
assert 'reconnect' in spec['snap_false_methods']
assert 'predict' in spec['methods']
assert spec['enable_memory_snapshot'] == True
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('SDK: Serialization roundtrip', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
from snapgpu.serialization import *
def add(a, b): return a + b
data = serialize_function(add)
fn = deserialize_function(data)
assert fn(10, 20) == 30

args = serialize_args((1, 2), {'c': 3})
a, k = deserialize_args(args)
assert a == (1, 2) and k == {'c': 3}

b64 = encode_b64(data)
assert decode_b64(b64) == data
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('SDK: App.to_spec() serialization', { timeout: 10_000 }, () => {
    const output = execSync(`${PYTHON} -c "
import snapgpu, json
app = snapgpu.App('spec-test')
img = snapgpu.Image.debian_slim()
vol = snapgpu.Volume('data')

@app.function(image=img, gpu='T4', keep_warm=2, volumes={'/data': vol})
def process(x): return x

spec = app.to_spec()
assert spec['name'] == 'spec-test'
assert 'process' in spec['functions']
fn_spec = spec['functions']['process']
assert fn_spec['gpu'] == 'T4'
assert fn_spec['keep_warm'] == 2
assert fn_spec['volumes'] == {'/data': 'data'}
assert fn_spec['image'] is not None
print('OK')
"`, { encoding: 'utf-8' });
    expect(output.trim()).toBe('OK');
  });

  it('Gateway: health endpoint', { timeout: 10_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/health`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.service).toBe('snapgpu-gateway');
  });

  it('Gateway: CRUD app lifecycle', { timeout: 15_000 }, async () => {
    const base = `http://127.0.0.1:${gatewayPort}`;

    // Create
    let res = await fetch(`${base}/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bench-app', spec: { functions: { hello: { gpu: 'T4' } }, classes: {} } }),
    });
    expect(res.status).toBe(201);

    // List
    res = await fetch(`${base}/v1/apps`);
    const apps = await res.json() as any[];
    expect(apps.some((a: any) => a.name === 'bench-app')).toBe(true);

    // Deploy update
    res = await fetch(`${base}/v1/apps/bench-app/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { functions: { hello: { gpu: 'A100' }, world: { gpu: 'T4' } }, classes: {} } }),
    });
    expect(res.status).toBe(200);
    const deploy = await res.json() as any;
    expect(deploy.functions).toContain('hello');
    expect(deploy.functions).toContain('world');

    // Delete
    res = await fetch(`${base}/v1/apps/bench-app`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('Gateway: invoke function remotely', { timeout: 15_000 }, async () => {
    const base = `http://127.0.0.1:${gatewayPort}`;

    // Create app (ensure it exists)
    const createRes = await fetch(`${base}/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'invoke-test', spec: { functions: { multiply: {} }, classes: {} } }),
    });
    expect([201, 400]).toContain(createRes.status);

    // Also deploy to ensure spec is registered
    await fetch(`${base}/v1/apps/invoke-test/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { functions: { multiply: {} }, classes: {} } }),
    });

    // Invoke with serialized function
    const fnCode = execSync(`${PYTHON} -c "
from snapgpu.serialization import serialize_function, serialize_args, encode_b64
def multiply(a, b): return a * b
print(encode_b64(serialize_function(multiply)))
print(encode_b64(serialize_args((6, 7), {})))
"`, { encoding: 'utf-8' }).trim().split('\n');

    const res = await fetch(`${base}/v1/invoke/invoke-test/multiply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn_data: fnCode[0], args_data: fnCode[1] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe('completed');
    expect(data.latency_ms).toBeLessThan(1000);

    // Verify result
    const result = execSync(`${PYTHON} -c "
from snapgpu.serialization import decode_b64, deserialize_result
result = deserialize_result(decode_b64('${data.result}'))
print(result)
"`, { encoding: 'utf-8' }).trim();
    expect(result).toBe('42');

    // Cleanup
    await fetch(`${base}/v1/apps/invoke-test`, { method: 'DELETE' });
  });
});
