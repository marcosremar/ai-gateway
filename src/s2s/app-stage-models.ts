/**
 * Stage models of the composed s2s fallback, taken from the calling app's own route aliases (`PUT /v1/apps/:app/routes`:
 * `parle-stt`, `parle-llm`, `parle-tts`) when the request sends no `config.models` and no `S2S_<STAGE>_MODEL` is set.
 * Before this, a cold primary with neither failed the turn with 503 ("no stt model for the composed fallback"), so the
 * s2s had no reserve exactly when the GPU was off (QA 2026-10-06, 100 % 503 until the replica was back).
 *
 * Which app: the one that owns the speech-stack deployment the turn names (`config.deployment` / `S2S_DEPLOYMENT`),
 * else the app of the calling key. Which alias, when an app routes several for a stage: the one whose chain reaches
 * that deployment (it is the GPU path the turn is replacing), else the first.
 */

import type { ModelRoutesSpec } from '../config/serve-providers';

export type StageModels = { stt?: string; chat?: string; tts?: string };

const STAGES = ['stt', 'chat', 'tts'] as const;

export function appStageModels(routes: ModelRoutesSpec | undefined, deployment?: string): StageModels {
  const out: StageModels = {};
  for (const stage of STAGES) {
    const byAlias = routes?.[stage];
    if (!byAlias) continue;
    const aliases = Object.keys(byAlias);
    const viaDeployment = deployment
      ? aliases.find(a => byAlias[a]?.some(e => (e as { deployment?: string }).deployment === deployment))
      : undefined;
    const alias = viaDeployment ?? aliases[0];
    if (alias) out[stage] = alias;
  }
  return out;
}

/**
 * The app whose aliases serve a call: a non-admin key always its own app (its key may call only its own aliases,
 * AppLimits; API audit 2026-10-07), an admin key the owner of the named deployment, else its own.
 */
export function appForCall(opts: {
  deploymentApp: string | null | undefined; callerApp: string | null | undefined; callerIsAdmin?: boolean;
}): string | null {
  if (opts.callerApp && opts.callerIsAdmin === false) return opts.callerApp;
  return opts.deploymentApp || opts.callerApp || null;
}
