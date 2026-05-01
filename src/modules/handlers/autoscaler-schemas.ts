/**
 * Zod schemas used by the autoscaler handlers for validating save-config payloads.
 * Mirrors the schemas in the host app's ai-provider-settings.ts.
 */
import { z } from 'zod';

export const AutoscalerTierSchema = z.object({
  provider: z.string(),
  instanceId: z.string().optional(),
  apiKey: z.string().optional(),
  authId: z.string().optional(),
  endpoint: z.string().optional(),
  gpuTypes: z.array(z.string()).optional(),
  hfToken: z.string().optional(),
  dockerImage: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  storageGb: z.number().optional(),
  region: z.string().optional(),
});

export const AutoscalerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  threshold: z.number().default(1),
  windowMinutes: z.number().default(5),
  maxLatencyMs: z.number().default(3000),
  gpuProvider: z.string().optional(),
  gpuTypes: z.array(z.string()).optional(),
  tiers: z.array(AutoscalerTierSchema).default([]),
  idleGraceMinutes: z.number().default(15),
});

export type AutoscalerSettings = z.infer<typeof AutoscalerSettingsSchema>;
