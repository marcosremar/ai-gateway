// ── BabelCast Gateway — Relay & Stream Handlers ──────────────────────────────
// Scaleway relay instance management + HLS stream status.

import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, handleBodyError } from './http-utils';
import { createLogger } from '../src/logger';

const log = createLogger('relay-handlers');

// ── Relay state ─────────────────────────────────────────────────────────────

interface RelayState {
  active: boolean;
  ip: string | null;
  instanceId: string | null;
  startedAt: number | null;
}

const relayState: RelayState = {
  active: false,
  ip: null,
  instanceId: null,
  startedAt: null,
};

// ── Scaleway API helpers ────────────────────────────────────────────────────

const SCW_API = 'https://api.scaleway.com/instance/v1/zones';

function scwHeaders(): Record<string, string> {
  const key = process.env.SCALEWAY_SECRET_KEY;
  if (!key) throw new Error('SCALEWAY_SECRET_KEY not set');
  return {
    'X-Auth-Token': key,
    'Content-Type': 'application/json',
  };
}

function scwZone(): string {
  return process.env.SCALEWAY_ZONE || 'fr-par-1';
}

function scwInstanceId(): string {
  const id = process.env.SCALEWAY_INSTANCE_ID;
  if (!id) throw new Error('SCALEWAY_INSTANCE_ID not set');
  return id;
}

async function scwAction(action: 'poweron' | 'poweroff'): Promise<void> {
  const zone = scwZone();
  const id = scwInstanceId();
  const res = await fetch(`${SCW_API}/${zone}/servers/${id}/action`, {
    method: 'POST',
    headers: scwHeaders(),
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Scaleway ${action} failed (${res.status}): ${body}`);
  }
}

async function scwGetServer(): Promise<{ state: string; public_ip: { address: string } | null }> {
  const zone = scwZone();
  const id = scwInstanceId();
  const res = await fetch(`${SCW_API}/${zone}/servers/${id}`, {
    headers: scwHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Scaleway GET server failed (${res.status}): ${body}`);
  }
  const data = await res.json() as { server: { state: string; public_ip: { address: string } | null } };
  return data.server;
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function handleRelayStart(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (relayState.active) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: true, ip: relayState.ip, hlsUrl: hlsUrl(relayState.ip) }));
      return;
    }

    await scwAction('poweron');
    log.log('Scaleway instance powering on...');

    // Poll until running (max ~2 min)
    let ip: string | null = null;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const server = await scwGetServer();
      if (server.state === 'running' && server.public_ip) {
        ip = server.public_ip.address;
        break;
      }
    }

    if (!ip) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Relay instance did not start in time' }));
      return;
    }

    relayState.active = true;
    relayState.ip = ip;
    relayState.instanceId = scwInstanceId();
    relayState.startedAt = Date.now();

    log.log(`Scaleway instance ready at ${ip}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active: true, ip, hlsUrl: hlsUrl(ip) }));
  } catch (e) {
    log.error('Start failed:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

export async function handleRelayStop(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!relayState.active) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Relay already stopped' }));
      return;
    }

    await scwAction('poweroff');
    log.log('Scaleway instance powering off...');

    relayState.active = false;
    relayState.ip = null;
    relayState.startedAt = null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    log.error('Stop failed:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

export async function handleRelayStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uptimeSec = relayState.startedAt ? Math.floor((Date.now() - relayState.startedAt) / 1000) : 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    active: relayState.active,
    ip: relayState.ip,
    hlsUrl: relayState.active ? hlsUrl(relayState.ip) : null,
    uptimeSec,
  }));
}

export async function handleStreamStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stream is active if relay is running
  const streamHlsUrl = process.env.STREAM_HLS_URL || (relayState.active ? hlsUrl(relayState.ip) : null);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    active: relayState.active || !!process.env.STREAM_HLS_URL,
    hlsUrl: streamHlsUrl,
    relayIp: relayState.ip,
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hlsUrl(ip: string | null): string | null {
  if (!ip) return null;
  const domain = process.env.STREAM_DOMAIN;
  if (domain) return `https://${domain}/hls/live.m3u8`;
  return `http://${ip}/hls/live.m3u8`;
}
