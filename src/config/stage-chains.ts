/**
 * Effective chain per stage, with the state of every link — so a primary that never serves (a deployment that was
 * never created answers `X-Gateway-Fallback: not_configured` on every request) shows up in `/health` instead of
 * passing unnoticed.
 *
 * Link states:
 *   ready        will be tried and can answer now (cloud provider with its key, or a deployment with a ready replica)
 *   cold         deployment scaled to zero / starting: requests fall back at once and wake it
 *   paused       deployment paused by an operator
 *   pending      declared deployment not registered yet (reason: the missing credential / image)
 *   missing      deployment not found on this gateway (nothing declares or registered it)
 *   disabled     deployments are off on this gateway (no SCW_SECRET_KEY)
 *   no_key       provider key missing or rejected
 *   blocked      refused by the provider account's data policy (ZDR), skipped for a while
 *   circuit_open repeated failures, skipped for < 30 s (the target's breaker, or the stage out of rotation on every
 *                ready replica of a deployment)
 */

import type { CircuitBreakerRegistry } from '../gateway/providers/cloud/circuit-breaker';
import { isTargetCircuitOpen } from '../gateway/proxy/provider-routing';
import { emitGatewayEvent } from '../telemetry/emit';

export interface ChainLinkSpec {
  /** `deployment:<name>` or `<provider>:<upstream model>`. */
  target: string;
  /** Provider label (`deployment:<name>` or the provider id); with `model` and the stage it names the breaker. */
  providerId: string;
  /** Upstream model of a cloud link (breakers are per stage + provider + model, `breakerKey`). */
  model?: string;
  deployment?: string;
  /** Why the link could not be mounted at all. */
  notMounted?: string;
  unavailableNow?: () => string | null;
}

export type LinkState = 'ready' | 'cold' | 'paused' | 'pending' | 'missing' | 'disabled' | 'no_key' | 'blocked' | 'circuit_open';

export interface LinkReport { target: string; state: LinkState; reason?: string }

export interface ChainReport {
  /** First link that can answer now (`null` = the request gets 503, or waits for a cold deployment's fallback). */
  serving: string | null;
  /** True when the first link is not the one serving (the stage runs on a fallback). */
  onFallback: boolean;
  links: LinkReport[];
}

export interface ChainHealthDeps {
  /** Deployment status (`DeploymentView.status`), or null when it does not exist. Absent = deployments are off. */
  deploymentStatus?: (name: string) => string | null;
  stageOut?: (name: string, stage: string) => { ready: number; out: number };
  /** Reason a declared deployment is still pending, or null. */
  declaredPending?: (name: string) => string | null;
  breakers?: CircuitBreakerRegistry;
}

function linkReport(link: ChainLinkSpec, deps: ChainHealthDeps, stage: string): LinkReport {
  const { target } = link;
  if (link.deployment !== undefined) {
    if (!deps.deploymentStatus) {
      return { target, state: 'disabled', reason: link.notMounted ?? 'deployments are disabled on this gateway (SCW_SECRET_KEY is not set)' };
    }
    const status = deps.deploymentStatus(link.deployment);
    if (status === null) {
      const pending = deps.declaredPending?.(link.deployment);
      return pending
        ? { target, state: 'pending', reason: pending }
        : { target, state: 'missing', reason: `deployment '${link.deployment}' does not exist on this gateway (every request falls back: not_configured)` };
    }
    if (status === 'paused') return { target, state: 'paused', reason: `deployment '${link.deployment}' is paused` };
    if (status === 'scaled-to-zero' || status === 'warming') {
      return { target, state: 'cold', reason: status === 'warming' ? 'replica starting' : 'scaled to zero (starts on the next request)' };
    }
  } else if (link.notMounted) {
    return { target, state: 'no_key', reason: link.notMounted };
  }
  const blocked = link.unavailableNow?.();
  if (blocked) return { target, state: 'blocked', reason: blocked };
  if (deps.breakers && isTargetCircuitOpen(deps.breakers, stage, link)) {
    return { target, state: 'circuit_open', reason: 'repeated failures (retrying in < 30 s)' };
  }
  const replicas = link.deployment !== undefined ? deps.stageOut?.(link.deployment, stage) : undefined;
  if (replicas?.out) {
    const reason = `${stage} out of rotation on ${replicas.out} of ${replicas.ready} ready replicas after repeated failures`;
    return { target, state: replicas.out >= replicas.ready ? 'circuit_open' : 'ready', reason };
  }
  return { target, state: 'ready' };
}

export function chainReport(links: ChainLinkSpec[], deps: ChainHealthDeps, stage: string): ChainReport {
  const reports = links.map(l => linkReport(l, deps, stage));
  const serving = reports.find(r => r.state === 'ready')?.target ?? null;
  return { serving, onFallback: serving !== null && serving !== reports[0]?.target, links: reports };
}

export interface FallbackStatus {
  active: boolean;
  since: string | null;
  chains: Array<{ stage: string; model: string; primary: string; primaryState: LinkState; serving: string; since: string }>;
}

export function createFallbackWatch(
  log: (msg: string, data: Record<string, unknown>) => void, now: () => number = Date.now,
): (stages: Record<string, Record<string, ChainReport>>) => FallbackStatus {
  const since = new Map<string, number>();
  return (stages) => {
    const chains: FallbackStatus['chains'] = [];
    for (const [stage, byModel] of Object.entries(stages)) {
      for (const [model, report] of Object.entries(byModel)) {
        const key = `${stage} ${model}`;
        const primary = report.links[0];
        if (report.onFallback && report.serving && primary) {
          const data = { stage, model, primary: primary.target, primaryState: primary.state, serving: report.serving };
          if (!since.has(key)) {
            since.set(key, now());
            log('gateway: stage on fallback', { ...data, reason: primary.reason ?? null });
            emitGatewayEvent('stage.on_fallback', { level: 'warn', attrs: data });
          }
          chains.push({ ...data, since: new Date(since.get(key)!).toISOString() });
        } else if (report.serving && since.has(key)) {
          const forMs = now() - since.get(key)!;
          since.delete(key);
          log('gateway: stage back on primary', { stage, model, primary: report.serving, forMs });
          emitGatewayEvent('stage.on_primary', { durMs: forMs, attrs: { stage, model, primary: report.serving } });
        }
      }
    }
    const first = chains.length ? chains.reduce((a, b) => (a.since <= b.since ? a : b)).since : null;
    return { active: chains.length > 0, since: first, chains };
  };
}

/** Per stage → per model chain report, plus one warning per chain whose first link cannot serve. */
export function stageChainsReport(
  chains: Record<string, Record<string, ChainLinkSpec[]>>, deps: ChainHealthDeps,
): { stages: Record<string, Record<string, ChainReport>>; warnings: string[] } {
  const stages: Record<string, Record<string, ChainReport>> = {};
  const warnings: string[] = [];
  for (const [stage, byModel] of Object.entries(chains)) {
    for (const [model, links] of Object.entries(byModel)) {
      const report = chainReport(links, deps, stage);
      (stages[stage] ??= {})[model] = report;
      const first = report.links[0];
      // `cold` is the normal scale-to-zero state; anything else on the primary means it is not going to serve.
      if (first && first.state !== 'ready' && first.state !== 'cold') {
        warnings.push(`${stage} ${model}: primary ${first.target} is ${first.state}${first.reason ? ` (${first.reason})` : ''}`
          + ` — ${report.serving ? `serving from ${report.serving}` : 'no link can serve'}`);
      }
    }
  }
  return { stages, warnings };
}
