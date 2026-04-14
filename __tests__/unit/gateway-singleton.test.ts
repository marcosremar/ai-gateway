import { describe, it, expect, afterEach } from 'vitest';
import { initGateway, getGateway, resetGateway } from '../../src/gateway';

const GATEWAY_KEY = Symbol.for('__parle_ai_gateway_instance');

function makeDeps() {
  return {
    settingsStore: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      patch: async () => {},
    },
    stateStore: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      scan: async () => [] as string[],
      rpush: async () => {},
      ltrim: async () => {},
      lrange: async () => [] as string[],
      hset: async () => {},
      hdel: async () => {},
      hgetall: async () => ({} as Record<string, string>),
    },
    sessionResolver: {
      countDbSessions: async () => 0,
      resolveTeacher: async () => null,
    },
  };
}

describe('Gateway singleton', () => {
  afterEach(() => { resetGateway(); });

  it('getGateway throws before initGateway', () => {
    resetGateway();
    expect(() => getGateway()).toThrow('Not initialized');
  });

  it('initGateway returns an autoscaler instance', () => {
    const gw = initGateway(makeDeps());
    expect(gw).toBeDefined();
  });

  it('getGateway returns same instance after init', () => {
    const g1 = initGateway(makeDeps());
    const g2 = getGateway();
    expect(g2).toBe(g1);
  });

  it('resetGateway clears the singleton', () => {
    initGateway(makeDeps());
    resetGateway();
    expect(() => getGateway()).toThrow('Not initialized');
  });

  it('initGateway can be called again after reset', () => {
    const g1 = initGateway(makeDeps());
    resetGateway();
    const g2 = initGateway(makeDeps());
    expect(g2).not.toBe(g1);
  });

  it('stores instance on globalThis via symbol', () => {
    initGateway(makeDeps());
    const g = globalThis as any;
    expect(g[GATEWAY_KEY]).toBeDefined();
  });
});
