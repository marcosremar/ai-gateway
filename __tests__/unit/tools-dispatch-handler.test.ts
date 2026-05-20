/**
 * /v1/tools/dispatch HTTP handler test — black-box at handler level
 * (no live HTTP server). Uses fake req/res.
 */
import { describe, it, expect } from 'vitest';
import { handleToolsDispatch } from '../../server/tools-dispatch-handler';

interface FakeReq {
  on(event: string, cb: (chunk: Buffer | string) => void): void;
}
interface FakeRes {
  status?: number;
  body?: string;
  writeHead(code: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

function buildReq(json: unknown): FakeReq {
  const raw = JSON.stringify(json);
  return {
    on(event: string, cb: (c: Buffer | string) => void) {
      if (event === 'data') setTimeout(() => cb(raw), 0);
      else if (event === 'end') setTimeout(() => cb(''), 1);
    },
  };
}

function buildRes(): FakeRes {
  return {
    writeHead(code: number) { this.status = code; },
    end(body?: string) { this.body = body; },
  };
}

describe('POST /v1/tools/dispatch', () => {
  it('400 on invalid JSON', async () => {
    const req: FakeReq = {
      on(event: string, cb: (c: Buffer | string) => void) {
        if (event === 'data') setTimeout(() => cb('not json'), 0);
        else if (event === 'end') setTimeout(() => cb(''), 1);
      },
    };
    const res = buildRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleToolsDispatch(req as any, res as any);
    expect(res.status).toBe(400);
  });

  it('400 missing assistantMessage', async () => {
    const res = buildRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleToolsDispatch(buildReq({ tools: [] }) as any, res as any);
    expect(res.status).toBe(400);
    expect(res.body).toContain('assistantMessage');
  });

  it('400 missing tools array', async () => {
    const res = buildRes();
    await handleToolsDispatch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildReq({ assistantMessage: { role: 'assistant', content: [] } }) as any,
      res as any,
    );
    expect(res.status).toBe(400);
  });

  it('echo tool returns input verbatim', async () => {
    const res = buildRes();
    await handleToolsDispatch(
      buildReq({
        assistantMessage: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { hello: 'world' } }],
        },
        tools: [{ name: 'echo', kind: 'echo' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body!);
    expect(data.invoked).toBe(1);
    expect(data.errors).toBe(0);
    expect(data.toolMessage.content[0].content).toContain('"hello":"world"');
  });

  it('SSRF blocks webhook URLs targeting private IPs', async () => {
    const res = buildRes();
    await handleToolsDispatch(
      buildReq({
        assistantMessage: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'priv', input: {} }],
        },
        tools: [{ name: 'priv', kind: 'webhook', url: 'http://169.254.169.254/latest/meta' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body!);
    expect(data.errors).toBe(1);
    expect(data.toolMessage.content[0].content).toContain('SSRF');
  });

  it('returns null toolMessage when no tool_use blocks', async () => {
    const res = buildRes();
    await handleToolsDispatch(
      buildReq({
        assistantMessage: { role: 'assistant', content: [{ type: 'text', text: 'no tools' }] },
        tools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body!);
    expect(data.invoked).toBe(0);
    expect(data.toolMessage).toBeNull();
  });
});
