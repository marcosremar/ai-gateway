/**
 * CLI cluster benchmark — orchestrates health, SSE, WS, and WebRTC TTFA
 * measurements against a GPU backend endpoint.
 *
 * Framework-agnostic: uses only Node.js built-ins + sibling bench utilities.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execAsync } from '../infra/gpu-backend';
import { WS_CLIENT_PY } from './ws-bench-client';
import { runHealthCheck, runSSEBench, makeTestWav, type ProtoResult, type HealthResult } from './bench';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CliBenchResult {
  endpoint: string;
  timestamp: string;
  health: HealthResult;
  sse: ProtoResult | null;
  ws: ProtoResult | null;
  webrtc: ProtoResult | null;
  ttfa_summary: string;
}

// ── WebRTC Python client ─────────────────────────────────────────────────────

export const WEBRTC_BENCH_PY = `#!/usr/bin/env python3
"""
Server-side WebRTC TTFA benchmark using aiortc.
Connects to <api_url>/api/offer from this machine (Next.js server → GPU public IP).
Measures time-to-first-audio-chunk from the moment the offer is accepted.

Usage: python3 script.py http://IP:8000
"""
import asyncio, json, sys, time, math, struct, wave, tempfile, os, fractions

try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, AudioStreamTrack
    from av import AudioFrame
    import numpy as np
    import urllib.request
except ImportError:
    import subprocess, sys as _sys
    subprocess.check_call(
        [_sys.executable, "-m", "pip", "install", "-q", "aiortc av numpy"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    from aiortc import RTCPeerConnection, RTCSessionDescription, AudioStreamTrack
    from av import AudioFrame
    import numpy as np
    import urllib.request

FRAME_SAMPLES = 960
FRAME_RATE    = 48000

class WavThenSilenceTrack(AudioStreamTrack):
    kind = "audio"
    def __init__(self, wav_path):
        super().__init__()
        self._pts = 0
        self._wav_frames = self._load_wav(wav_path)
        self._idx = 0
    @staticmethod
    def _load_wav(p):
        with wave.open(p, 'rb') as wf:
            sr = wf.getframerate()
            raw = wf.readframes(wf.getnframes())
        s = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        ratio = FRAME_RATE // sr
        r = np.repeat(s, ratio) if ratio > 1 else s
        frames = []
        for i in range(0, len(r), FRAME_SAMPLES):
            c = r[i:i+FRAME_SAMPLES]
            if len(c) < FRAME_SAMPLES:
                c = np.pad(c, (0, FRAME_SAMPLES - len(c)))
            frames.append(c)
        return frames
    async def recv(self):
        await asyncio.sleep(FRAME_SAMPLES / FRAME_RATE)
        s = self._wav_frames[self._idx] if self._idx < len(self._wav_frames) else np.zeros(FRAME_SAMPLES, dtype=np.float32)
        if self._idx < len(self._wav_frames):
            self._idx += 1
        pcm = (s * 32768).astype(np.int16)
        frame = AudioFrame(format='s16', layout='mono', samples=FRAME_SAMPLES)
        frame.planes[0].update(pcm.tobytes())
        frame.sample_rate = FRAME_RATE
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, FRAME_RATE)
        self._pts += FRAME_SAMPLES
        return frame

def make_test_wav():
    fd, p = tempfile.mkstemp(suffix='.wav')
    os.close(fd)
    sr, n = 16000, 32000
    with wave.open(p, 'wb') as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
        data = bytearray()
        for i in range(n):
            data += struct.pack('<h', int(math.sin(2*math.pi*440*i/sr)*0.9*32767))
        wf.writeframes(bytes(data))
    return p

async def run(api_url):
    wav = make_test_wav()
    pc = RTCPeerConnection()
    dc = pc.createDataChannel('control')
    pc.addTrack(WavThenSilenceTrack(wav))

    result = {}
    done = asyncio.Event()
    ttfa_detected = asyncio.Event()
    t_start = time.time()

    async def watch_audio(track):
        while True:
            try:
                frame = await asyncio.wait_for(track.recv(), timeout=35)
                raw = bytes(frame.planes[0])
                samples = np.frombuffer(raw, dtype=np.int16)
                if np.any(samples != 0) and 'ttfa_ms' not in result:
                    result['ttfa_ms'] = int((time.time() - t_start) * 1000)
                    ttfa_detected.set()
            except: break

    @pc.on('track')
    def on_track(track):
        if track.kind == 'audio':
            asyncio.ensure_future(watch_audio(track))

    @dc.on('message')
    def on_message(msg):
        try:
            d = json.loads(msg)
            if d.get('transcript'): result['transcript'] = d['transcript']
            if d.get('response'):   result['response']   = d['response']
            if d.get('timing'):
                t = d['timing']
                for k in ('stt_ms','llm_ms','tts_ms'):
                    if t.get(k): result[k] = t[k]
                # Server-reported TTFA as fallback
                if t.get('ttfa_ms') and 'ttfa_ms' not in result:
                    result['ttfa_ms'] = t['ttfa_ms']
            if d.get('status') == 'complete':
                result['ok'] = True
                result['total_ms'] = int((time.time() - t_start) * 1000)
                done.set()
        except: pass

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    # ICE gathering
    if pc.iceGatheringState != 'complete':
        gathered = asyncio.Event()
        @pc.on('icegatheringstatechange')
        def _ice():
            if pc.iceGatheringState == 'complete': gathered.set()
        try: await asyncio.wait_for(gathered.wait(), timeout=5)
        except asyncio.TimeoutError: pass

    try:
        payload = json.dumps({'sdp': pc.localDescription.sdp, 'type': pc.localDescription.type}).encode()
        req = urllib.request.Request(api_url+'/api/offer', data=payload,
            headers={'Content-Type':'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=15) as resp:
            answer = json.loads(resp.read())
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'], type=answer['type']))

        try:
            await asyncio.wait_for(done.wait(), timeout=40)
        except asyncio.TimeoutError:
            result = {'ok': False, 'error': 'Timeout (40s) — pipeline did not complete'}
        else:
            if 'ttfa_ms' not in result:
                try: await asyncio.wait_for(ttfa_detected.wait(), timeout=3)
                except asyncio.TimeoutError: pass
            result.setdefault('ok', True)
    except Exception as e:
        result = {'ok': False, 'error': str(e)}
    finally:
        await pc.close()
        try: os.unlink(wav)
        except: pass

    print(json.dumps(result))

asyncio.run(run(sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8000'))
`.trim();

// ── WebSocket bench ──────────────────────────────────────────────────────────

export async function runWSBench(base: string, testWav: Buffer): Promise<ProtoResult> {
  const ts = Date.now();
  const tmpDir = os.tmpdir();
  const audioPath = path.join(tmpDir, `cbench-ws-audio-${ts}.wav`);
  const scriptPath = path.join(tmpDir, `cbench-ws-${ts}.py`);

  try {
    const url = new URL(base);
    const wsUrl = `ws://${url.host}/ws/stream`;

    await fs.writeFile(audioPath, testWav);
    await fs.writeFile(scriptPath, WS_CLIENT_PY);

    const { stdout, stderr } = await execAsync(
      `python3 "${scriptPath}" "${audioPath}" "${wsUrl}"`,
      { timeout: 60_000 },
    );

    const output = stdout.trim();
    if (!output) {
      return { ok: false, total_ms: Date.now() - ts, error: stderr.trim() || 'No output from WS client' };
    }
    const r = JSON.parse(output);
    return {
      ok: r.ok ?? false,
      ttfa_ms: r.ttfa_ms,
      total_ms: r.total_ms ?? Date.now() - ts,
      connect_ms: r.connect_ms,
      stt_ms: r.stt_ms,
      llm_ms: r.llm_ms,
      tts_ms: r.tts_ms,
      transcript: r.transcript,
      response: r.response,
      error: r.error,
    };
  } catch (err: unknown) {
    return { ok: false, total_ms: Date.now() - ts, error: err instanceof Error ? err.message : 'Unknown error' };
  } finally {
    await Promise.all([
      fs.unlink(audioPath).catch(e => console.warn('[bench] temp file cleanup failed:', e instanceof Error ? e.message : e)),
      fs.unlink(scriptPath).catch(e => console.warn('[bench] temp file cleanup failed:', e instanceof Error ? e.message : e)),
    ]);
  }
}

// ── WebRTC bench ─────────────────────────────────────────────────────────────

export async function runWebRTCBench(base: string): Promise<ProtoResult> {
  const ts = Date.now();
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, `cbench-rtc-${ts}.py`);

  try {
    await fs.writeFile(scriptPath, WEBRTC_BENCH_PY);

    const { stdout, stderr } = await execAsync(
      `python3 "${scriptPath}" "${base}"`,
      { timeout: 60_000 },
    );

    const output = stdout.trim();
    if (!output) {
      return { ok: false, total_ms: Date.now() - ts, error: stderr.trim() || 'No output from WebRTC client' };
    }
    const r = JSON.parse(output);
    return {
      ok: r.ok ?? false,
      ttfa_ms: r.ttfa_ms,
      total_ms: r.total_ms ?? Date.now() - ts,
      stt_ms: r.stt_ms,
      llm_ms: r.llm_ms,
      tts_ms: r.tts_ms,
      transcript: r.transcript,
      response: r.response,
      error: r.error,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isUnavailable = msg.includes('Connection refused') || msg.includes('404') || msg.includes('ModuleNotFound');
    return {
      ok: false,
      total_ms: Date.now() - ts,
      error: isUnavailable ? 'WebRTC not available on this backend (missing /api/offer or aiortc)' : msg,
    };
  } finally {
    await fs.unlink(scriptPath).catch(e => console.warn('[bench] temp file cleanup failed:', e instanceof Error ? e.message : e));
  }
}

// ── TTFA comparison table ────────────────────────────────────────────────────

export function buildTtfaTable(results: {
  sse?: ProtoResult | null;
  ws?: ProtoResult | null;
  webrtc?: ProtoResult | null;
}): string {
  const rows: Array<{ proto: string; ttfa?: string; total?: string; ok: boolean; note?: string }> = [];

  const fmtMs = (ms?: number) => ms !== undefined ? `${ms} ms` : '—';

  if (results.sse) {
    rows.push({
      proto: 'SSE',
      ttfa: fmtMs(results.sse.ttfa_ms),
      total: fmtMs(results.sse.total_ms),
      ok: results.sse.ok,
      note: results.sse.error,
    });
  }
  if (results.ws) {
    rows.push({
      proto: 'WebSocket',
      ttfa: fmtMs(results.ws.ttfa_ms),
      total: fmtMs(results.ws.total_ms),
      ok: results.ws.ok,
      note: results.ws.error,
    });
  }
  if (results.webrtc) {
    rows.push({
      proto: 'WebRTC',
      ttfa: fmtMs(results.webrtc.ttfa_ms),
      total: fmtMs(results.webrtc.total_ms),
      ok: results.webrtc.ok,
      note: results.webrtc.error,
    });
  }

  const lines = [
    '┌──────────┬────────────┬────────────┬────────┐',
    '│ Protocol │ TTFA       │ Total      │ Status │',
    '├──────────┼────────────┼────────────┼────────┤',
    ...rows.map((r) =>
      `│ ${r.proto.padEnd(8)} │ ${(r.ttfa ?? '—').padEnd(10)} │ ${(r.total ?? '—').padEnd(10)} │ ${r.ok ? '✓ pass' : '✗ fail'} │${r.note ? ` ← ${r.note}` : ''}`,
    ),
    '└──────────┴────────────┴────────────┴────────┘',
  ];
  return lines.join('\n');
}

// ── Main orchestrator ────────────────────────────────────────────────────────

export async function runCliBench(
  endpoint: string,
  protocols: string[] = ['sse', 'ws', 'webrtc'],
): Promise<CliBenchResult> {
  const base = endpoint.replace(/\/$/, '');
  const testWav = makeTestWav();

  const health = await runHealthCheck(base);

  let sse: ProtoResult | null = null;
  let ws: ProtoResult | null = null;
  let webrtc: ProtoResult | null = null;

  if (health.ok) {
    const tasks: Array<Promise<void>> = [];

    if (protocols.includes('sse')) {
      tasks.push(runSSEBench(base, testWav).then((r) => { sse = r; }));
    }
    if (protocols.includes('ws')) {
      tasks.push(runWSBench(base, testWav).then((r) => { ws = r; }));
    }
    if (protocols.includes('webrtc')) {
      tasks.push(runWebRTCBench(base).then((r) => { webrtc = r; }));
    }

    await Promise.all(tasks);
  }

  const table = buildTtfaTable({ sse, ws, webrtc });

  return {
    endpoint: base,
    timestamp: new Date().toISOString(),
    health,
    sse,
    ws,
    webrtc,
    ttfa_summary: table,
  };
}
