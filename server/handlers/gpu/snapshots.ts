/**
 * GPU Snapshot Handlers
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createLogger } from '../../../src/logger';
import { deployState } from '../../state';
import { readJsonBody } from '../../http-utils';

const log = createLogger('gpu-snapshots');

// In-memory snapshot storage (replace with persistent storage in production)
const snapshots = new Map<string, Snapshot>();

interface Snapshot {
  id: string;
  name: string;
  description?: string;
  deployId: string;
  podId: string;
  provider: string;
  createdAt: number;
  gpuType?: string;
  dockerImage?: string;
}

/**
 * Create a snapshot of current GPU state
 */
export async function handleSnapshotCreate(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Creating GPU snapshot');

  try {
    if (deployState.status !== 'ready' || !deployState.podId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'No active GPU to snapshot',
      }));
      return;
    }

    const body = await readJsonBody(req) as {
      name?: string;
      description?: string;
    };

    const snapshotId = `snap-${Date.now()}`;
    const snapshot: Snapshot = {
      id: snapshotId,
      name: body.name || `Snapshot ${new Date().toISOString()}`,
      description: body.description,
      deployId: deployState.deployId,
      podId: deployState.podId,
      provider: deployState.provider,
      createdAt: Date.now(),
      gpuType: deployState.gpuType,
      dockerImage: deployState.dockerImage,
    };

    snapshots.set(snapshotId, snapshot);
    log.log(`Snapshot created: ${snapshotId}`);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      snapshotId,
      snapshot: {
        id: snapshot.id,
        name: snapshot.name,
        description: snapshot.description,
        createdAt: snapshot.createdAt,
        gpuType: snapshot.gpuType,
        dockerImage: snapshot.dockerImage,
      },
    }));

  } catch (err) {
    log.error('Snapshot create error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * List all snapshots
 */
export async function handleSnapshotList(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Listing GPU snapshots');

  try {
    const snapshotList = Array.from(snapshots.values()).map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      createdAt: s.createdAt,
      gpuType: s.gpuType,
      dockerImage: s.dockerImage,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      snapshots: snapshotList,
      count: snapshotList.length,
    }));

  } catch (err) {
    log.error('Snapshot list error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * Restore from a snapshot
 */
export async function handleSnapshotRestore(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Restoring GPU snapshot');

  try {
    const body = await readJsonBody(req) as { snapshotId?: string };
    
    if (!body.snapshotId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'snapshotId is required',
      }));
      return;
    }

    const snapshot = snapshots.get(body.snapshotId);
    if (!snapshot) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: `Snapshot ${body.snapshotId} not found`,
      }));
      return;
    }

    log.log(`Restoring from snapshot: ${body.snapshotId}`);

    // In a real implementation, this would trigger a deploy with the snapshot's config
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Snapshot restore initiated',
      snapshot: {
        id: snapshot.id,
        name: snapshot.name,
        gpuType: snapshot.gpuType,
        dockerImage: snapshot.dockerImage,
      },
    }));

  } catch (err) {
    log.error('Snapshot restore error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * Delete a snapshot
 */
export async function handleSnapshotDelete(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Deleting GPU snapshot');

  try {
    const body = await readJsonBody(req) as { snapshotId?: string };
    
    if (!body.snapshotId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'snapshotId is required',
      }));
      return;
    }

    const deleted = snapshots.delete(body.snapshotId);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: `Snapshot ${body.snapshotId} not found`,
      }));
      return;
    }

    log.log(`Snapshot deleted: ${body.snapshotId}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Snapshot deleted',
    }));

  } catch (err) {
    log.error('Snapshot delete error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}
