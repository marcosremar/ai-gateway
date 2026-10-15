import { readFileSync } from 'fs';
import { join } from 'path';

const allowed = JSON.parse(readFileSync(join(__dirname, '../../docker/aigw-edge/tests/sdk-client-updates.json'), 'utf8')) as {
  keys: string[]; roles: string[]; frames: Array<Record<string, unknown>>;
};

export const EDGE_ACCEPTED_FRAMES = allowed.frames;

export function edgeRefusal(msg: unknown): string | null {
  const m = msg as Record<string, unknown>;
  if (m?.type !== 'config_update') return null;
  const extra = Object.keys(m).filter(k => k !== 'type' && !allowed.keys.includes(k));
  if (extra.length) return `config_update carries ${extra.join(', ')}`;
  if (typeof m.signed === 'string') return null;
  const messages = (m.messages ?? []) as Array<{ role?: unknown; content?: unknown }>;
  const bad = !Array.isArray(messages) || messages.some(x => !allowed.roles.includes(String(x?.role)) || typeof x?.content !== 'string');
  return bad ? 'config_update carries a message the edge refuses' : null;
}
