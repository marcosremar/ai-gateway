/**
 * Deploy-intent tracking — guard for autonomous redeploys (finding #26).
 *
 * The gateway has three paths that start a deploy with NOBODY asking:
 * auto-recovery (gpu-auto-recovery.ts, via readiness condemn + monitor crash
 * loop) and the resume-manager fresh-deploy fallback. All of them reuse the
 * image from restored/persisted state — after a gateway restart that state
 * can belong to a long-dead session, which is how a stale `gpu-dev` dev-box
 * config got resurrected into a 1-hour tier cascade on 2026-06-10.
 *
 * Rule: an autonomous redeploy is only allowed when a caller expressed intent
 * for that image IN THIS PROCESS and recently — via POST /v1/gpu/deploy,
 * POST /v1/gpu/resume, or a bootOnStartup profile.
 */

const DEFAULT_MAX_AGE_MIN = 30;

export interface DeployIntent {
  image: string;
  at: number;
}

let lastIntent: DeployIntent | null = null;

/** Record caller intent for an image (deploy request, resume request, boot profile). */
export function recordDeployIntent(image: string): void {
  if (!image) return;
  lastIntent = { image, at: Date.now() };
}

export function getLastDeployIntent(): DeployIntent | null {
  return lastIntent;
}

/** Test-only reset. */
export function clearDeployIntent(): void {
  lastIntent = null;
}

export function autonomousRedeployMaxAgeMs(): number {
  const min = parseInt(process.env.AIGW_AUTONOMOUS_REDEPLOY_MAX_AGE_MIN || '', 10);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_MAX_AGE_MIN) * 60_000;
}

export function isAutonomousRedeployAllowed(input: {
  image?: string;
  intent: DeployIntent | null;
  now: number;
  maxAgeMs: number;
}): { ok: boolean; reason: string } {
  if (!input.image) return { ok: false, reason: 'no image to redeploy' };
  if (!input.intent) {
    return { ok: false, reason: 'no deploy/resume intent recorded this session — refusing to resurrect state from a previous session (finding #26)' };
  }
  if (input.intent.image !== input.image) {
    return { ok: false, reason: `intent was for ${input.intent.image}, not ${input.image} — refusing cross-image redeploy` };
  }
  const age = input.now - input.intent.at;
  if (age > input.maxAgeMs) {
    return { ok: false, reason: `last intent for ${input.image} is ${Math.round(age / 60_000)}min old (max ${Math.round(input.maxAgeMs / 60_000)}min)` };
  }
  return { ok: true, reason: 'recent same-image intent in this session' };
}

/** Convenience wrapper used by the autonomous redeploy paths. */
export function checkAutonomousRedeploy(image?: string): { ok: boolean; reason: string } {
  return isAutonomousRedeployAllowed({
    image,
    intent: lastIntent,
    now: Date.now(),
    maxAgeMs: autonomousRedeployMaxAgeMs(),
  });
}
