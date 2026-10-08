import { emitGatewayEvent } from './emit';

export type StreamCut = 'truncated' | 'stalled';
export interface StreamCutCount { deployment: string; replica: string | null; stage: string; truncated: number; stalled: number }

const counts = new Map<string, StreamCutCount>();

export function noteStreamCut(at: { deployment: string; replica?: string | null; stage: string }, kind: StreamCut, detail = ''): void {
  const key = `${at.deployment}|${at.replica ?? ''}|${at.stage}`;
  const row = counts.get(key) ?? { deployment: at.deployment, replica: at.replica ?? null, stage: at.stage, truncated: 0, stalled: 0 };
  if (kind === 'stalled') row.stalled++; else row.truncated++;
  counts.set(key, row);
  emitGatewayEvent('stream.cut', {
    level: 'warn', deployment: at.deployment, ...(at.replica ? { replicaId: at.replica } : {}),
    attrs: { kind, stage: at.stage, detail: detail.slice(0, 200) },
  });
}

export function streamCuts(): StreamCutCount[] {
  return [...counts.values()].map(row => ({ ...row }));
}

export function resetStreamCuts(): void {
  counts.clear();
}
