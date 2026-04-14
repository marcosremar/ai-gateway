import { describe, it, expect } from 'vitest';
import { WS_CLIENT_PY } from '../src/benchmarking/ws-bench-client';

describe('WS_CLIENT_PY', () => {
  it('is a non-empty string', () => {
    expect(typeof WS_CLIENT_PY).toBe('string');
    expect(WS_CLIENT_PY.length).toBeGreaterThan(0);
  });

  it('contains websocket import', () => {
    expect(WS_CLIENT_PY).toContain('websockets');
  });

  it('contains audio handling', () => {
    expect(WS_CLIENT_PY).toContain('audio');
  });

  it('contains connect and send logic', () => {
    expect(WS_CLIENT_PY).toContain('connect');
    expect(WS_CLIENT_PY).toContain('ws.send');
  });

  it('contains JSON output format with expected fields', () => {
    expect(WS_CLIENT_PY).toContain('"ok"');
    expect(WS_CLIENT_PY).toContain('"connect_ms"');
    expect(WS_CLIENT_PY).toContain('"ttfa_ms"');
    expect(WS_CLIENT_PY).toContain('"total_ms"');
    expect(WS_CLIENT_PY).toContain('"chunks"');
    expect(WS_CLIENT_PY).toContain('"stt_ms"');
    expect(WS_CLIENT_PY).toContain('"llm_ms"');
    expect(WS_CLIENT_PY).toContain('"tts_ms"');
    expect(WS_CLIENT_PY).toContain('"transcript"');
    expect(WS_CLIENT_PY).toContain('"response"');
  });

  it('contains async main entry point', () => {
    expect(WS_CLIENT_PY).toContain('asyncio.run');
    expect(WS_CLIENT_PY).toContain('sys.argv');
  });

  it('contains websocket URL argument handling', () => {
    expect(WS_CLIENT_PY).toContain('ws_url');
    expect(WS_CLIENT_PY).toContain('ws://localhost:8000/ws/stream');
  });
});
