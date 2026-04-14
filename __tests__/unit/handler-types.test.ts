import { describe, it, expect } from 'vitest';
import { ok, err } from '@ai-gateway/handlers/types';

describe('handler-types', () => {
  describe('ok()', () => {
    it('returns status 200 by default', () => {
      const result = ok({ message: 'hello' });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ message: 'hello' });
    });

    it('accepts custom status', () => {
      const result = ok({ id: 1 }, 201);
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ id: 1 });
    });
  });

  describe('err()', () => {
    it('returns status 400 by default', () => {
      const result = err('bad request');
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'bad request' });
    });

    it('accepts custom status', () => {
      const result = err('not found', 404);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'not found' });
    });
  });
});
