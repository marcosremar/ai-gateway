// ── Modal provider strategy ──────────────────────────────────────────────────
// Modal is launched from a Python deploy script (not a Docker image), so the
// `image` argument coming into the loop is repurposed as the path to that
// script. resolveImage maps any non-script input to the canonical
// `docker/modal/babelcast.py` resolved relative to the gateway working
// directory (process.cwd()), preserving the legacy MODAL_DEPLOY_SCRIPT
// behaviour previously hardcoded in `server/gpu-deploy-with-tiers.ts`.

import { resolve as resolvePath } from 'path';
import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type ProviderStrategy,
} from './base-strategy';

const MODAL_DEPLOY_SCRIPT_REL = 'docker/modal/babelcast.py';

function looksLikeModalScript(image: string): boolean {
  return /\.(py)$/i.test(image);
}

export const modalStrategy: ProviderStrategy = {
  name: 'modal',
  defaultRaceCount: 1,
  defaultSshTimeoutSec: 600,
  allowTierCascade: true,

  /** If the caller already passed a `.py` path (e.g. resolved by the tier
   *  orchestrator), keep it; otherwise fall back to the canonical
   *  `docker/modal/babelcast.py` rooted at the working directory. */
  resolveImage(image: string): string {
    if (image && looksLikeModalScript(image)) return image;
    return resolvePath(process.cwd(), MODAL_DEPLOY_SCRIPT_REL);
  },

  buildCreateOptions(base: CreateOptionsBase, extra: DeployExtra): Record<string, unknown> {
    return {
      gpuTypes: base.gpuTypes,
      dockerImage: base.dockerImage,
      storageGb: base.storageGb,
      region: base.region,
      hfToken: base.hfToken,
      env: base.env,
      interruptible: extra.interruptible,
      onPollProgress: base.onPollProgress,
      ...(extra.label ? { label: extra.label } : {}),
    };
  },

  cleanup(client: GpuProviderClient, instanceId: string, creds: ProviderCredentials) {
    return defaultCleanup(client, instanceId, creds);
  },
};
