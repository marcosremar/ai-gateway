/**
 * Who may use which speech-stack deployment through `POST /v1/s2s`, and under which limits (API audit 2026-10-07,
 * verified in production: `config.deployment` came from the request body with no ownership check, so any app key
 * could wake — and run turns on — another app's GPU, and the primary path never went through the AppLimits that guard
 * `/v1/chat/completions` and the other inference routes).
 *
 * Same rule as `invoke` in deployments/http.ts: an admin key may use any deployment; a non-admin key only one of its
 * own app — the deployment's `app` is the key's user, or the app's routes (`PUT /v1/apps/:app/routes`, whose targets
 * an app key can never widen, apps.ts) already send traffic to it (the operator's declared `parle-speech`, owned by no
 * app, reached through parle's own aliases).
 *
 *   - `config.deployment` named by the request and not allowed → 403 `permission_error`, nothing acquired or woken;
 *   - the gateway default (`S2S_DEPLOYMENT`) not allowed for this key → the turn goes to the composed pipeline, the
 *     default is never woken for it;
 *   - AppLimits (`checkS2S`): `config.models` must be the app's own aliases, `max_tokens` clamped, daily budget charged.
 */

import type { IncomingMessage } from 'http';
import type { ModelRoutesSpec } from '../config/serve-providers';
import type { AppLimitDenial } from '../gateway/proxy/app-limits';
import type { S2SConfig } from './composite';

export type S2SAdmission =
  | { ok: true; deployment: string }
  | ({ ok: false } & AppLimitDenial);

export interface S2SAccessOptions {
  /** The calling key's user (= app id); null when the gateway runs without keys (localhost-only open mode). */
  userOf: (req: IncomingMessage) => string | null;
  isAdmin: (userId: string) => boolean;
  /** The app a registered deployment belongs to (null: no app); undefined when no such deployment is registered. */
  deploymentApp: (name: string) => string | null | undefined;
  /** The app's own routes (`PUT /v1/apps/:app/routes`). */
  appRoutes: (app: string) => ModelRoutesSpec | undefined;
  limits?: { checkS2S: (userId: string, config: S2SConfig) => AppLimitDenial | null };
}

/** True when one of the app's route entries targets the deployment. */
export function routesReachDeployment(routes: ModelRoutesSpec | undefined, deployment: string): boolean {
  for (const byAlias of Object.values(routes ?? {})) {
    for (const entries of Object.values(byAlias ?? {})) {
      if (entries?.some(e => (e as { deployment?: string }).deployment === deployment)) return true;
    }
  }
  return false;
}

export function createS2SAccess(opts: S2SAccessOptions) {
  const mayUse = (userId: string, deployment: string): boolean => {
    if (opts.isAdmin(userId)) return true;
    const owner = opts.deploymentApp(deployment);
    if (owner) return owner === userId;
    return routesReachDeployment(opts.appRoutes(userId), deployment);
  };

  /** Admission of one turn: the deployment it may use ('' = composed pipeline only), or the denial to answer. */
  return function admit(req: IncomingMessage, config: S2SConfig, requested: { deployment: string; explicit: boolean }): S2SAdmission {
    const userId = opts.userOf(req);
    if (userId === null) return { ok: true, deployment: requested.deployment };
    let deployment = requested.deployment;
    if (deployment && !mayUse(userId, deployment)) {
      if (requested.explicit) {
        return { ok: false, status: 403, type: 'permission_error', message: `this API key cannot use deployment '${deployment}'` };
      }
      deployment = '';
    }
    const denial = opts.limits?.checkS2S(userId, config) ?? null;
    if (denial) return { ok: false, ...denial };
    return { ok: true, deployment };
  };
}
