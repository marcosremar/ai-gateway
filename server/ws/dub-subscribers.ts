// ── Dub subscriber management (thin re-exports) ──────────────────────────────
// The actual subscriber registry and fanout live in server/ws-state.ts so
// existing consumers (relay-handlers, dub-fanout, etc.) keep working.
// This module is the canonical entry point for ws/* code.

export {
  subscribeDub,
  unsubscribeDub,
  getActiveTargets,
} from '../ws-state';
