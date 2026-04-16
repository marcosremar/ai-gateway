/**
 * Integration tests for backend WebSocket and WebRTC transport servers.
 *
 * These tests start the actual Bun servers as child processes on ephemeral
 * ports and exercise the real network protocols.  The ai-gateway pipeline
 * is NOT mocked — if API keys are missing the pipeline will error, and we
 * validate that the error propagates correctly through the transport.
 *
 * Run:  bunx vitest run --config vitest.config.backend.mts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

let RTCPeerConnection: any, RTCSessionDescription: any, useOPUS: any, MediaStreamTrack: any;
let WebSocket: any;
let hasWerift = false;
try {
  ({ RTCPeerConnection, RTCSessionDescription, useOPUS, MediaStreamTrack } = await import('werift'));
  WebSocket = (await import('ws')).default;
  hasWerift = true;
} catch {
  // werift not installed — tests will be skipped
}

const hasBackendServers =
  existsSync(resolve(process.cwd(), 'backend/ws-server.ts')) &&
  existsSync(resolve(process.cwd(), 'backend/webrtc-server.ts'));

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Test ports (ephemeral, unlikely to collide) ─────────────────────────────

const WS_PORT = 19_383;
const RTC_PORT = 19_384;

// ── Server processes ────────────────────────────────────────────────────────

let wsProc: ChildProcess | null = null;
let rtcProc: ChildProcess | null = null;

/** Wait until `url` returns HTTP 200 (up to `timeoutMs`). */
async function waitForHealth(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(300);
  }
  return false;
}

/** Create a simple 16-bit PCM WAV buffer with a 440Hz tone. */
function createTestWav(durationSec = 0.5, sampleRate = 16000): Buffer {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }

  return buf;
}

/** Connect a ws.WebSocket and resolve when open. */
function connectWS(url: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect timeout'));
    }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Send a JSON message and wait for the first JSON reply. */
function sendAndWaitJSON(ws: any, msg: unknown, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const handler = (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      } catch { /* not JSON — ignore binary */ }
    };
    ws.on('message', handler);
    ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!hasWerift || !hasBackendServers) return;

  const cwd = process.cwd();

  // NODE_PATH needed for werift's generate-function dep resolution in Bun
  const nodeModules = resolve(cwd, 'node_modules');

  wsProc = spawn('bun', ['backend/ws-server.ts'], {
    cwd,
    env: { ...process.env, WS_BACKEND_PORT: String(WS_PORT), NODE_PATH: nodeModules },
    stdio: 'pipe',
  });

  rtcProc = spawn('bun', ['backend/webrtc-server.ts'], {
    cwd,
    env: { ...process.env, WEBRTC_BACKEND_PORT: String(RTC_PORT), NODE_PATH: nodeModules },
    stdio: 'pipe',
  });

  const [wsOk, rtcOk] = await Promise.all([
    waitForHealth(`http://127.0.0.1:${WS_PORT}/health`),
    waitForHealth(`http://127.0.0.1:${RTC_PORT}/health`),
  ]);

  if (!wsOk) throw new Error(`WS server did not become healthy on port ${WS_PORT}`);
  if (!rtcOk) throw new Error(`WebRTC server did not become healthy on port ${RTC_PORT}`);
}, 30_000);

afterAll(() => {
  if (!hasWerift || !hasBackendServers) return;
  wsProc?.kill('SIGTERM');
  rtcProc?.kill('SIGTERM');
});

// ═════════════════════════════════════════════════════════════════════════════
// WebSocket Server Tests
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!hasWerift || !hasBackendServers)('WebSocket backend server', () => {

  // ── Health ──────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns status ok with transport info', async () => {
      const res = await fetch(`http://127.0.0.1:${WS_PORT}/health`);
      expect(res.status).toBe(200);

      const json = await res.json() as any;
      expect(json.status).toBe('ok');
      expect(json.transport).toBe('websocket');
      expect(json.port).toBe(WS_PORT);
      expect(typeof json.uptime).toBe('number');
    });
  });

  // ── 404 ─────────────────────────────────────────────────────────────────

  describe('Unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await fetch(`http://127.0.0.1:${WS_PORT}/unknown`);
      expect(res.status).toBe(404);
    });
  });

  // ── WebSocket connection ───────────────────────────────────────────────

  describe('WebSocket /ws/stream', () => {
    it('connects and receives pong for ping', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);

      const pong = await sendAndWaitJSON(ws, { type: 'ping' });
      expect(pong).not.toBeNull();
      expect(pong.type).toBe('pong');

      ws.close();
    });

    it('accepts config message without error', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);

      // Config should be accepted silently
      ws.send(JSON.stringify({
        type: 'config',
        systemPrompt: 'You are a Portuguese tutor.',
        history: [
          { role: 'user', content: 'Olá' },
          { role: 'assistant', content: 'Olá! Tudo bem?' },
        ],
      }));

      await sleep(200);

      // Verify connection is still alive
      const pong = await sendAndWaitJSON(ws, { type: 'ping' });
      expect(pong?.type).toBe('pong');

      ws.close();
    });

    it('returns error for unknown message type', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);

      const response = await sendAndWaitJSON(ws, { type: 'unknown_garbage' });
      expect(response).not.toBeNull();
      expect(response.status).toBe('error');
      expect(response.message).toContain('Unknown type');

      ws.close();
    });

    it('returns error for invalid JSON', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);

      const response = await sendAndWaitJSON(ws, 'this is not json{{{');
      expect(response).not.toBeNull();
      expect(response.status).toBe('error');
      expect(response.message).toContain('Invalid JSON');

      ws.close();
    });

    it('returns error for empty TTS text', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);

      const response = await sendAndWaitJSON(ws, { type: 'tts', text: '   ' });
      expect(response).not.toBeNull();
      expect(response.status).toBe('error');
      expect(response.message).toContain('Empty text');

      ws.close();
    });

    it('starts audio pipeline on binary message and sends status updates', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);

      // Collect all JSON messages until complete or error
      const messages: any[] = [];
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 30_000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            messages.push(msg);
            if (msg.status === 'complete' || msg.status === 'error') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* binary audio chunk — expected */ }
        });
      });

      // Send test audio as binary
      ws.send(createTestWav(0.3));
      await done;

      // Should have at least one status message
      expect(messages.length).toBeGreaterThan(0);

      const first = messages[0];
      // Either pipeline starts (processing/stt) or fails (error if no API key)
      expect(['processing', 'error']).toContain(first.status);

      if (first.status === 'processing') {
        expect(first.stage).toBe('stt');
      }

      // If pipeline completed fully, validate the shape
      const complete = messages.find((m) => m.status === 'complete');
      if (complete) {
        expect(complete.timing).toBeDefined();
        expect(typeof complete.timing.total_ms).toBe('number');
        expect(typeof complete.transcript).toBe('string');
        expect(typeof complete.response).toBe('string');
      }

      ws.close();
    }, 35_000);

    it('handles concurrent connections independently', async () => {
      const NUM = 3;

      // Connect all clients in parallel
      const sockets = await Promise.all(
        Array.from({ length: NUM }, () =>
          connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`),
        ),
      );

      expect(sockets).toHaveLength(NUM);

      // All should respond to ping independently
      const pongs = await Promise.all(
        sockets.map((ws) => sendAndWaitJSON(ws, { type: 'ping' })),
      );

      for (const pong of pongs) {
        expect(pong?.type).toBe('pong');
      }

      sockets.forEach((ws) => ws.close());
    });

    it('survives client disconnect without crashing', async () => {
      const ws = await connectWS(`ws://127.0.0.1:${WS_PORT}/ws/stream`);
      ws.close(1000, 'test close');

      await sleep(500);

      // Server must still be healthy
      const res = await fetch(`http://127.0.0.1:${WS_PORT}/health`);
      expect(res.status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// WebRTC Server Tests
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!hasWerift || !hasBackendServers)('WebRTC backend server', () => {

  // ── Health ──────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns status ok with transport info', async () => {
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/health`);
      expect(res.status).toBe(200);

      const json = await res.json() as any;
      expect(json.status).toBe('ok');
      expect(json.transport).toBe('webrtc');
      expect(json.port).toBe(RTC_PORT);
      expect(json.activePeers).toBe(0);
      expect(typeof json.uptime).toBe('number');
    });
  });

  // ── ICE Servers ─────────────────────────────────────────────────────────

  describe('GET /api/ice-servers', () => {
    it('returns at least a STUN server', async () => {
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/api/ice-servers`);
      expect(res.status).toBe(200);

      const json = await res.json() as any;
      expect(json.iceServers).toBeInstanceOf(Array);
      expect(json.iceServers.length).toBeGreaterThanOrEqual(1);
      expect(json.iceServers[0].urls).toContain('stun:stun.l.google.com:19302');
    });
  });

  // ── CORS ───────────────────────────────────────────────────────────────

  describe('CORS', () => {
    it('returns CORS headers on OPTIONS preflight', async () => {
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/api/offer`, {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('includes CORS headers on regular responses', async () => {
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/health`);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  // ── 404 ────────────────────────────────────────────────────────────────

  describe('Unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/unknown`);
      expect(res.status).toBe(404);
    });
  });

  // ── SDP Offer/Answer ──────────────────────────────────────────────────

  describe('POST /api/offer', () => {
    it('rejects request with missing SDP', async () => {
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/api/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'offer' }),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('Missing');
    });

    it('completes SDP exchange with a real werift client', async () => {
      // Simulate browser peer connection (like SmallWebRTCTransport)
      const clientPc = new RTCPeerConnection({
        codecs: { audio: [useOPUS()] },
      });

      const audioTrack = new MediaStreamTrack({ kind: 'audio' });
      clientPc.addTransceiver(audioTrack, { direction: 'sendrecv' });
      clientPc.createDataChannel('control');

      const offer = await clientPc.createOffer();
      await clientPc.setLocalDescription(offer);

      // Send offer to server
      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/api/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: clientPc.localDescription!.sdp,
          type: clientPc.localDescription!.type,
        }),
      });

      expect(res.status).toBe(200);

      const answer = await res.json() as { sdp: string; type: string };
      expect(answer.type).toBe('answer');
      expect(typeof answer.sdp).toBe('string');
      expect(answer.sdp.length).toBeGreaterThan(100);
      expect(answer.sdp).toContain('a=rtpmap');

      // Apply answer — signaling should reach stable state
      await clientPc.setRemoteDescription(
        new RTCSessionDescription(answer.sdp, answer.type as 'answer'),
      );
      expect(clientPc.signalingState).toBe('stable');

      await clientPc.close();
    }, 15_000);

    it('answer SDP contains OPUS codec', async () => {
      const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()] } });
      pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch(`http://127.0.0.1:${RTC_PORT}/api/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: pc.localDescription!.type,
        }),
      });

      const answer = await res.json() as { sdp: string };
      // OPUS should be negotiated in the answer SDP
      expect(answer.sdp.toLowerCase()).toContain('opus');

      await pc.close();
    }, 10_000);

    it('handles multiple concurrent SDP exchanges', async () => {
      const NUM = 3;

      const results = await Promise.all(
        Array.from({ length: NUM }, async () => {
          const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()] } });
          pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
          pc.createDataChannel('control');

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const res = await fetch(`http://127.0.0.1:${RTC_PORT}/api/offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sdp: pc.localDescription!.sdp,
              type: pc.localDescription!.type,
            }),
          });

          const answer = await res.json() as { sdp: string; type: string };
          await pc.close();

          return { status: res.status, hasAnswer: !!answer.sdp, type: answer.type };
        }),
      );

      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.hasAnswer).toBe(true);
        expect(r.type).toBe('answer');
      }
    }, 20_000);

    it('increments activePeers on offer', async () => {
      const healthBefore = await (await fetch(`http://127.0.0.1:${RTC_PORT}/health`)).json() as any;
      const peersBefore = healthBefore.activePeers;

      const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()] } });
      pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await fetch(`http://127.0.0.1:${RTC_PORT}/api/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: pc.localDescription!.type,
        }),
      });

      const healthAfter = await (await fetch(`http://127.0.0.1:${RTC_PORT}/health`)).json() as any;
      expect(healthAfter.activePeers).toBeGreaterThan(peersBefore);

      await pc.close();
    }, 10_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Discovery Probing Tests
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!hasWerift || !hasBackendServers)('Discovery probing', () => {
  async function probe(url: string, timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  it('detects running WS server', async () => {
    expect(await probe(`http://127.0.0.1:${WS_PORT}/health`)).toBe(true);
  });

  it('detects running WebRTC server', async () => {
    expect(await probe(`http://127.0.0.1:${RTC_PORT}/health`)).toBe(true);
  });

  it('returns false for non-existent server', async () => {
    expect(await probe('http://127.0.0.1:19999/health', 1000)).toBe(false);
  });

  it('returns false on unreachable host', async () => {
    // 10.255.255.1 is non-routable — will timeout
    expect(await probe('http://10.255.255.1:9999/health', 500)).toBe(false);
  });

  it('builds correct DiscoveryResponse-shaped transports', async () => {
    const host = '127.0.0.1';

    const transports: Record<string, any> = {
      sse: { endpoint: '/api/speech', audioPath: '/', healthPath: '/health' },
    };

    const [wsOk, rtcOk] = await Promise.all([
      probe(`http://${host}:${WS_PORT}/health`),
      probe(`http://${host}:${RTC_PORT}/health`),
    ]);

    if (wsOk) transports.websocket = { url: `ws://${host}:${WS_PORT}/ws/stream` };
    if (rtcOk) transports.webrtc = { signalingUrl: `http://${host}:${RTC_PORT}/api/offer`, clusterName: 'backend' };

    // All 3 should be present
    expect(transports.sse).toBeDefined();
    expect(transports.websocket).toBeDefined();
    expect(transports.webrtc).toBeDefined();

    // Validate URL shapes
    expect(transports.websocket.url).toMatch(/^ws:\/\/.+\/ws\/stream$/);
    expect(transports.webrtc.signalingUrl).toMatch(/^http:\/\/.+\/api\/offer$/);
    expect(transports.webrtc.clusterName).toBe('backend'); // truthy for browser guard
  });
});
