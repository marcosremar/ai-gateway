/**
 * Unit tests for server/app-registry-handlers.ts
 *
 * Covers all four HTTP handlers:
 *   handleAppsList   — always 200 + { apps: [...] }
 *   handleAppsGet    — 200 with entry or 404 when missing
 *   handleAppsRegister — 200 on success, 400 on bad JSON / missing fields, 500 on registry error
 *   handleAppsDelete   — 200 when removed, 404 when not found
 *
 * The underlying app-registry module is mocked so no filesystem is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Module mock ────────────────────────────────────────────────────────────

const mockListImages = vi.fn();
const mockGetImage = vi.fn();
const mockRegisterImage = vi.fn();
const mockUnregisterImage = vi.fn();

vi.mock('../../server/app-registry', () => ({
  listImages: (...a: unknown[]) => mockListImages(...a),
  getImage: (...a: unknown[]) => mockGetImage(...a),
  registerImage: (...a: unknown[]) => mockRegisterImage(...a),
  unregisterImage: (...a: unknown[]) => mockUnregisterImage(...a),
}));

// ── Test helpers ───────────────────────────────────────────────────────────

interface FakeRes {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function fakeRes(): FakeRes {
  const r: FakeRes = {
    writeHead(code, hdrs) { r.status = code; r.headers = hdrs as Record<string, string>; },
    end(body) { r.body = body; },
  };
  return r;
}

function fakeReq(payload: unknown): IncomingMessage {
  const raw = JSON.stringify(payload);
  const req = {
    setEncoding: vi.fn(),
    on(event: string, cb: (c: string | Error) => void) {
      if (event === 'data') setTimeout(() => cb(raw), 0);
      else if (event === 'end') setTimeout(() => cb(''), 1);
    },
  } as unknown as IncomingMessage;
  return req;
}

function fakeReqBadJson(): IncomingMessage {
  const req = {
    setEncoding: vi.fn(),
    on(event: string, cb: (c: string | Error) => void) {
      if (event === 'data') setTimeout(() => cb('{not-json'), 0);
      else if (event === 'end') setTimeout(() => cb(''), 1);
    },
  } as unknown as IncomingMessage;
  return req;
}

function fakeReqEmpty(): IncomingMessage {
  const req = {
    setEncoding: vi.fn(),
    on(event: string, cb: (c: string | Error) => void) {
      if (event === 'end') setTimeout(() => cb(''), 0);
    },
  } as unknown as IncomingMessage;
  return req;
}

// ── Import handlers (after vi.mock is set up) ──────────────────────────────

import {
  handleAppsList,
  handleAppsGet,
  handleAppsRegister,
  handleAppsDelete,
} from '../../server/app-registry-handlers';

// ── handleAppsList ─────────────────────────────────────────────────────────

describe('handleAppsList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with empty apps array when registry is empty', async () => {
    mockListImages.mockReturnValue([]);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsList(req, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ apps: [] });
  });

  it('returns 200 with all registered apps', async () => {
    const apps = [
      { name: 'musetalk', image: 'marcosremar/musetalk', bootEstimateS: 300 },
      { name: 'wan-i2v', image: 'marcosremar/wan-i2v', bootEstimateS: 300, tags: ['video'] },
    ];
    mockListImages.mockReturnValue(apps);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsList(req, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ apps });
  });

  it('sets content-type application/json', async () => {
    mockListImages.mockReturnValue([]);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsList(req, res as unknown as ServerResponse);
    expect(res.headers?.['content-type']).toBe('application/json');
  });
});

// ── handleAppsGet ──────────────────────────────────────────────────────────

describe('handleAppsGet', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with entry when app exists', async () => {
    const entry = { name: 'musetalk', image: 'marcosremar/musetalk', bootEstimateS: 300 };
    mockGetImage.mockReturnValue(entry);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsGet(req, res as unknown as ServerResponse, 'musetalk');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual(entry);
    expect(mockGetImage).toHaveBeenCalledWith('musetalk');
  });

  it('returns 404 when app is not found', async () => {
    mockGetImage.mockReturnValue(null);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsGet(req, res as unknown as ServerResponse, 'missing-app');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body!)).toEqual({ error: 'app "missing-app" not found' });
  });

  it('returns 404 error message that includes the app name', async () => {
    mockGetImage.mockReturnValue(undefined);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsGet(req, res as unknown as ServerResponse, 'some-app');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.error).toContain('some-app');
  });

  it('passes the name argument to getImage', async () => {
    mockGetImage.mockReturnValue({ name: 'fbx2glb', image: 'marcosremar/fbx2glb' });
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsGet(req, res as unknown as ServerResponse, 'fbx2glb');
    expect(mockGetImage).toHaveBeenCalledWith('fbx2glb');
  });
});

// ── handleAppsRegister ────────────────────────────────────────────────────

describe('handleAppsRegister', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with registered entry on success', async () => {
    const entry = { name: 'musetalk', image: 'marcosremar/musetalk', bootEstimateS: 300, tags: ['lipsync'] };
    mockRegisterImage.mockResolvedValue(entry);
    const req = fakeReq({ name: 'musetalk', image: 'marcosremar/musetalk', bootEstimateS: 300, tags: ['lipsync'] });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual(entry);
  });

  it('calls registerImage with the provided fields', async () => {
    const entry = { name: 'wan-i2v', image: 'marcosremar/wan-i2v' };
    mockRegisterImage.mockResolvedValue(entry);
    const req = fakeReq({ name: 'wan-i2v', image: 'marcosremar/wan-i2v', bootEstimateS: 120, notes: 'video' });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(mockRegisterImage).toHaveBeenCalledWith({
      name: 'wan-i2v',
      image: 'marcosremar/wan-i2v',
      bootEstimateS: 120,
      notes: 'video',
      tags: undefined,
    });
  });

  it('returns 400 when JSON body is malformed', async () => {
    const req = fakeReqBadJson();
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'invalid JSON body' });
    expect(mockRegisterImage).not.toHaveBeenCalled();
  });

  it('returns 400 when name is missing', async () => {
    const req = fakeReq({ image: 'marcosremar/musetalk' });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'name and image are required' });
    expect(mockRegisterImage).not.toHaveBeenCalled();
  });

  it('returns 400 when image is missing', async () => {
    const req = fakeReq({ name: 'musetalk' });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'name and image are required' });
    expect(mockRegisterImage).not.toHaveBeenCalled();
  });

  it('returns 400 when both name and image are missing (empty body)', async () => {
    const req = fakeReqEmpty();
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: 'name and image are required' });
  });

  it('returns 400 when name is empty string', async () => {
    const req = fakeReq({ name: '', image: 'marcosremar/musetalk' });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(400);
  });

  it('returns 400 when image is empty string', async () => {
    const req = fakeReq({ name: 'musetalk', image: '' });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(400);
  });

  it('returns 500 when registerImage throws', async () => {
    mockRegisterImage.mockRejectedValue(new Error('disk full'));
    const req = fakeReq({ name: 'musetalk', image: 'marcosremar/musetalk' });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body!)).toEqual({ error: 'disk full' });
  });

  it('passes tags array through when provided', async () => {
    const entry = { name: 'musetalk', image: 'marcosremar/musetalk', tags: ['video', 'lipsync'] };
    mockRegisterImage.mockResolvedValue(entry);
    const req = fakeReq({ name: 'musetalk', image: 'marcosremar/musetalk', tags: ['video', 'lipsync'] });
    const res = fakeRes();
    await handleAppsRegister(req, res as unknown as ServerResponse);
    expect(mockRegisterImage).toHaveBeenCalledWith(expect.objectContaining({ tags: ['video', 'lipsync'] }));
  });
});

// ── handleAppsDelete ──────────────────────────────────────────────────────

describe('handleAppsDelete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with removed name when app exists', async () => {
    mockUnregisterImage.mockResolvedValue(true);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsDelete(req, res as unknown as ServerResponse, 'musetalk');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ removed: 'musetalk' });
  });

  it('calls unregisterImage with the provided name', async () => {
    mockUnregisterImage.mockResolvedValue(true);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsDelete(req, res as unknown as ServerResponse, 'fbx2glb');
    expect(mockUnregisterImage).toHaveBeenCalledWith('fbx2glb');
  });

  it('returns 404 when app is not found', async () => {
    mockUnregisterImage.mockResolvedValue(false);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsDelete(req, res as unknown as ServerResponse, 'nonexistent');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body!)).toEqual({ error: 'app "nonexistent" not found' });
  });

  it('returns 404 when unregisterImage returns null', async () => {
    mockUnregisterImage.mockResolvedValue(null);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsDelete(req, res as unknown as ServerResponse, 'some-app');
    expect(res.status).toBe(404);
  });

  it('includes the app name in 404 error message', async () => {
    mockUnregisterImage.mockResolvedValue(false);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsDelete(req, res as unknown as ServerResponse, 'target-app');
    const body = JSON.parse(res.body!);
    expect(body.error).toContain('target-app');
  });

  it('sets content-type on success response', async () => {
    mockUnregisterImage.mockResolvedValue(true);
    const req = {} as IncomingMessage;
    const res = fakeRes();
    await handleAppsDelete(req, res as unknown as ServerResponse, 'musetalk');
    expect(res.headers?.['content-type']).toBe('application/json');
  });
});
