import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '../..', file), 'utf-8');

describe('WebSocket security hardening', () => {
  it('requires gateway auth fallback when Recall WS secret is missing', () => {
    const source = readSource('server/ws-server.ts');
    expect(source).toContain('!recallAuthorized && !isGatewayWsAuthorized');
  });

  it('warns when Recall API is configured without a Recall WS secret', () => {
    const source = readSource('server/ws-server.ts');
    expect(source).toContain('RECALL_API_KEY is set but RECALL_WS_SECRET is missing');
  });
});
