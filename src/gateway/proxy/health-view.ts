/**
 * What `GET /health` shows, and to whom (API audit 2026-10-07: the public /health listed the provider chains, the
 * deployment names, missing env var names such as GHCR_READ_TOKEN and the account policy to anyone).
 *
 *   GET /health              no auth   {status, version, commit, builtAt, uptimeSeconds} — the platform probe, the
 *                                      reaper, the SDK breaker. `commit`/`builtAt` come from `src/build-info.json`,
 *                                      stamped by `bun run stamp:build` before the upload (`railway up` carries no git);
 *                                      an unstamped build says `null`.
 *                                      An admin's `?details=1` adds `images`: the edge sidecar, the built-in profiles
 *                                      and the declared deployments this build points at.
 *   GET /health?details=1    app key   the stage chains of the app's own aliases; admin key: everything (stages of every
 *                                      alias, warnings, connections, STT filter and no-wake counters, realtime sessions
 *                                      per deployment)
 *   GET /health?deep=1       admin key upstream probes (deepHealthReport); a non-admin key → 403
 */

import buildInfo from '../../build-info.json';
import { DEFAULT_EDGE_IMAGE } from '../../deployments/cloud-init';
import { DECLARED_DEPLOYMENTS, declaredImage } from '../../deployments/declared';
import { BUILTIN_PROFILES } from '../../deployments/profiles';
import type { DeploymentView } from '../../deployments/types';

export interface HealthViewer {
  /** The key's user (= app id for an app key); `localhost` in open mode. */
  userId: string;
  admin: boolean;
}

const flag = (url: string, name: string) => new RegExp(`[?&]${name}=(1|true)(&|$)`).test(url);

export const wantsDeepHealth = (url: string) => flag(url, 'deep');
export const wantsHealthDetails = (url: string) => flag(url, 'details');

const startedAt = Date.now();

/** The unauthenticated answer: up or not, which build, since when. Nothing about providers, deployments or keys. */
export function minimalHealth(
  env: Record<string, string | undefined> = process.env, build: { commit: string | null; builtAt: string | null } = buildInfo,
): Record<string, unknown> {
  const commit = build.commit || env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;
  const version = env.GATEWAY_VERSION?.trim() || commit?.slice(0, 12) || null;
  return { status: 'ok', version, commit, builtAt: build.builtAt || null, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
}

export const buildImages = (env: Record<string, string | undefined> = process.env) => ({
  edge: DEFAULT_EDGE_IMAGE,
  profiles: Object.fromEntries(BUILTIN_PROFILES.filter(p => p.spec.image).map(p => [p.name, p.spec.image])),
  declared: Object.fromEntries(DECLARED_DEPLOYMENTS.map(d => [d.name, declaredImage(d, env)])),
});

export function realtimeHealth(views: DeploymentView[]): Array<Record<string, unknown>> {
  return views.filter(v => v.realtime).map(v => ({
    deployment: v.name, ...v.realtime, sessions: v.sessions, replicas: v.replicas.filter(r => r.phase === 'ready').length,
    desiredReplicas: v.desiredReplicas, reason: v.autoscale.reason, blockedBy: v.autoscale.blockedBy,
  }));
}

type StageReport = { stages?: Record<string, Record<string, unknown>>; warnings?: string[] };

/**
 * An app's own view of the stage report (`stageChainsReport`): only the aliases it routes, and only the warnings about
 * them. `aliasesOf` null for a stage = the app has nothing there.
 */
export function appStagesView(
  report: StageReport, aliasesOf: (stage: string) => ReadonlySet<string> | null,
): { stages: Record<string, Record<string, unknown>>; warnings: string[] } {
  const stages: Record<string, Record<string, unknown>> = {};
  const mine: string[] = [];
  for (const [stage, byAlias] of Object.entries(report.stages ?? {})) {
    const own = aliasesOf(stage);
    if (!own) continue;
    for (const [alias, chain] of Object.entries(byAlias)) {
      if (!own.has(alias)) continue;
      (stages[stage] ??= {})[alias] = chain;
      mine.push(`${stage} ${alias}:`);
    }
  }
  const warnings = (report.warnings ?? []).filter(w => mine.some(prefix => w.startsWith(prefix)));
  return { stages, warnings };
}
