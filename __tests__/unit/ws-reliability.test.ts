/**
 * WebSocket Reliability — Integration Tests
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '../..', file), 'utf-8');

describe('WebSocket State Management', () => {

  describe('Dub subscription cleanup', () => {
    it('should clean up empty target sets after broadcast', () => {
      const source = readSource('server/ws-state.ts');
      expect(source).toContain('if (clients.size === 0) dubTargetClients.delete(target)');
    });

    it('should log errors in broadcastGpuStatusEvent', () => {
      const source = readSource('server/ws-state.ts');
      expect(source).not.toContain(".catch(() => { /* suppress");
      expect(source).toContain('broadcastGpuStatusEvent failed');
    });
  });

  describe('Connection limits', () => {
    it('should define MAX_WS_CLIENTS and reject excess', () => {
      const source = readSource('server/ws-server.ts');
      expect(source).toContain('MAX_WS_CLIENTS');
      expect(source).toContain('1013');
      expect(source).toContain('Too many connections');
    });
  });

  describe('Bot audio buffer safety', () => {
    it('should cap buffer size', () => {
      const source = readSource('server/ws/bot-audio.ts');
      expect(source).toContain('BOT_AUDIO_MAX_BUFFER_BYTES');
      expect(source).toContain('dropping oldest chunks');
    });

    it('should flush on disconnect', () => {
      const source = readSource('server/ws-server.ts');
      expect(source).toContain('Bot audio source disconnected');
    });
  });

  describe('STT session safety', () => {
    it('should check readyState before reconnecting', () => {
      const source = readSource('server/ws/stt-lifecycle.ts');
      expect(source).toContain('ws.readyState === 1');
    });

    it('should check readyState before sending results', () => {
      const source = readSource('server/ws/stt-lifecycle.ts');
      expect(source).toContain('if (ws.readyState !== 1) return');
    });

    it('should catch speculative cache errors', () => {
      // speculativeCache.speculate calls were moved to ws/handlers.ts and ws/stt-lifecycle.ts
      const handlersSrc = readSource('server/ws/handlers.ts');
      const sttSrc = readSource('server/ws/stt-lifecycle.ts');
      const source = handlersSrc + '\n' + sttSrc;
      const matches = [...source.matchAll(/speculativeCache\.speculate\([^)]+\)/g)];
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches) {
        const before = source.slice(Math.max(0, match.index! - 30), match.index!);
        expect(before + match[0]).toMatch(/try\s*\{.*speculativeCache\.speculate|\.speculate\([^)]+\)\s*;\s*\}\s*catch|\.speculate\([^)]+\)\.catch\(/);
      }
    });
  });
});
