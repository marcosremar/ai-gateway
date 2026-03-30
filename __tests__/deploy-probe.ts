#!/usr/bin/env bun
/**
 * Probe test: start a simple Python HTTP server on port 8000 (no torch) 
 * to verify RunPod proxy works with this image.
 */
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';

try {
  const { readFileSync } = await import('fs');
  const env = readFileSync('.env', 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const apiKey = process.env.RUNPOD_API_KEY!;
const creds: ProviderCredentials = { apiKey };
const client = new RunpodClient();

// Tiny Python HTTP server — no imports of torch/ML libs
const startCmd = `python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(b'{\"status\":\"probe-ok\"}')
import socketserver
with socketserver.TCPServer(('', 8000), H) as s:
    s.serve_forever()
"`;

console.log('Deploying probe server (no torch)...');
const t0 = Date.now();
const instance = await client.createInstance(
  {
    gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
    gpuCount: 1,
    storageGb: 0,
    dockerImage: 'marcosremar/ultravox-s2s:blackwell',
    ports: ['8000/http', '22/tcp'],
    dockerStartCmd: startCmd,
  },
  creds,
);
console.log(`Pod: ${instance.instanceId} → ${instance.endpoint}`);

for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 10_000));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const podStatus = await client.getInstanceStatus(instance.instanceId, creds).catch(() => 'error');
  let health = 'skipped';
  if (podStatus === 'RUNNING') {
    try {
      const res = await fetch(`${instance.endpoint}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await res.text().catch(() => '');
      health = `${res.status} ${body.slice(0, 80)}`;
    } catch (e: unknown) {
      health = e instanceof Error ? e.message.slice(0, 60) : String(e);
    }
  }
  console.log(`[${elapsed}s] pod=${podStatus} health=${health}`);
  if (podStatus === null || podStatus === 'EXITED') { console.log('Pod terminated!'); break; }
  if (health.startsWith('200')) { console.log(`✅ Probe works! Torch is the bottleneck.`); break; }
}

// Delete after test
await client.deleteInstance(instance.instanceId, creds).catch(() => {});
console.log('Done.');
