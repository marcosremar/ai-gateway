// ── Modal provider strategy ──────────────────────────────────────────────────
// Modal is launched from a Python deploy script (not a Docker image), so the
// `image` argument coming into the loop is repurposed as the path to that
// script.
//
// Image-name → Modal script mapping lets the gateway race a Modal slot
// alongside RunPod/Hyperstack/Vast for any image with a registered Modal app
// definition. Without this map every Modal deploy collapses onto
// `babelcast.py` regardless of what the caller actually wants — the May
// 2026 trellis2 incident: race-deploy picked Modal, ran babelcast.py, and
// the slot died with a Python ImportError because babelcast.py imports
// translation-specific deps trellis2 has no business loading.
//
// To add a new image: drop a Modal app file under `dockers/modal/<name>.py`
// and add the entry below. The resolver matches by registry image name
// (with or without tag).

import { resolve as resolvePath } from 'path';
import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { DeployExtra } from '../deploy-extra';
import {
  defaultCleanup,
  type CreateOptionsBase,
  type ProviderStrategy,
} from './base-strategy';

const MODAL_DEPLOY_SCRIPT_REL = 'dockers/modal/babelcast.py';

/** Maps a registry image (the name part, without a `:tag` suffix) to the
 *  Modal Python deploy script that knows how to run that image on Modal.
 *  Order matters only for documentation; lookup is exact-match. */
const IMAGE_TO_MODAL_SCRIPT: Record<string, string> = {
  'marcosremar/babelcast-translategemma': 'dockers/modal/babelcast.py',
  // The container's own `trellis2` Python package shadows the deploy
  // module if both share the same name; the script lives at
  // `sceneforge_trellis2.py` so Modal imports the right one.
  'marcosremar/trellis2': 'dockers/modal/sceneforge_trellis2.py',
  // Add new mappings here. A missing entry falls back to babelcast.py and
  // emits a warning so misconfigured images fail loudly.
};

function looksLikeModalScript(image: string): boolean {
  return /\.(py)$/i.test(image);
}

/** Strip a `:tag` / `@sha256:...` suffix so lookups match the bare image
 *  name. `marcosremar/trellis2:latest` → `marcosremar/trellis2`. */
function imageName(image: string): string {
  const at = image.indexOf('@');
  const stripped = at >= 0 ? image.slice(0, at) : image;
  const colon = stripped.lastIndexOf(':');
  // Don't strip the colon when it's actually part of a registry port
  // (e.g. `localhost:5000/foo`). Heuristic: the colon must come after the
  // last slash to be a tag.
  const slash = stripped.lastIndexOf('/');
  if (colon > slash) return stripped.slice(0, colon);
  return stripped;
}

export const modalStrategy: ProviderStrategy = {
  name: 'modal',
  defaultRaceCount: 1,
  defaultSshTimeoutSec: 600,
  allowTierCascade: true,

  /** Resolution order:
   *  1. Caller already passed a `.py` path → keep as-is.
   *  2. Registry image is in IMAGE_TO_MODAL_SCRIPT → use the mapped script.
   *  3. Fallback → babelcast.py (legacy behaviour, with a console warning).
   *
   *  The fallback is preserved so a broken mapping never blocks an existing
   *  babelcast deploy, but it's the wrong answer for any other image and
   *  the warning is the operator's signal to add a mapping. */
  resolveImage(image: string): string {
    if (image && looksLikeModalScript(image)) return image;
    const cwd = process.cwd();
    const name = imageName(image);
    const mapped = IMAGE_TO_MODAL_SCRIPT[name];
    if (mapped) return resolvePath(cwd, mapped);
    if (image) {
      console.warn(
        `[modal-strategy] no Modal app mapped for image "${image}" (lookup key: "${name}") — falling back to ${MODAL_DEPLOY_SCRIPT_REL}. Add an entry to IMAGE_TO_MODAL_SCRIPT in modal-strategy.ts to fix.`,
      );
    }
    return resolvePath(cwd, MODAL_DEPLOY_SCRIPT_REL);
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
