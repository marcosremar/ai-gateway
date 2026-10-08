/**
 * Zod schema of one telemetry event (contract.ts). The single runtime validator: the ingest route uses it, the SDK
 * emitters share its TypeScript type (`TelemetryEvent`) through contract.ts so they stay dependency-free.
 */

import { z } from 'zod';
import {
  TELEMETRY_EVENT_NAME, TELEMETRY_ID, TELEMETRY_LEVELS, TELEMETRY_LIMITS, TELEMETRY_SOURCES, TELEMETRY_TRACE_ID,
  type TelemetryEvent,
} from './contract';

const id = z.string().regex(TELEMETRY_ID);

export const TelemetryAttrValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const TelemetryEventSchema = z.object({
  ts: z.number().finite().int().positive(),
  source: z.enum(TELEMETRY_SOURCES),
  level: z.enum(TELEMETRY_LEVELS),
  event: z.string().max(TELEMETRY_LIMITS.maxEventName).regex(TELEMETRY_EVENT_NAME),
  traceId: z.string().regex(TELEMETRY_TRACE_ID),
  sessionId: id.optional(),
  turnId: id.optional(),
  replicaId: id.optional(),
  deployment: id.optional(),
  durMs: z.number().finite().min(0).max(TELEMETRY_LIMITS.maxDurMs).optional(),
  attrs: z.record(z.string(), TelemetryAttrValueSchema).optional(),
});

export type TelemetryEventParsed = z.infer<typeof TelemetryEventSchema>;

// Compile-time guard: the Zod schema and the dependency-free contract type describe the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesContract: Same<TelemetryEventParsed, TelemetryEvent> = true;
void schemaMatchesContract;
