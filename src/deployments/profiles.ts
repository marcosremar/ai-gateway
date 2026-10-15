/**
 * Built-in deployment profiles. Callers can add their own (`PUT /v1/profiles/:name`); a stored profile with the
 * same name as a built-in one overrides it.
 */

import type { PlacementCandidate, Profile, ScalingSpec } from './types';

/** vLLM-Omni serves Qwen3-TTS with an OpenAI-shaped `POST /v1/audio/speech` (the image the parle class used on its own TTS GPU). */
const VLLM_OMNI_IMAGE = 'vllm/vllm-omni:v0.28.0';

const VAST_HOST = { minCuda: 13, maxRttExcessMs: 30 };
const vastLadder = (): PlacementCandidate[] => [
  { provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 0.3 },
  { provider: 'vast', machineType: 'RTX 4090', maxEurPerHour: 0.85 },
  { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.85 },
];
const SPEECH_STACK_TAG = '20261011-0200';
const SPEECH_STACK_IMAGE_ENV = { TTS_MODEL: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', LLM_FILE: 'Qwen3.5-9B-Q4_K_M.gguf' };
const ENV_24GB = { STT_BATCH: '4', LLM_PARALLEL: '8', LLM_SLOT_CTX: '2048', TTS_STAGE0_MB: '7400', RT_MAX_SESSIONS: '2' };
const CLASS_VOICE: ScalingSpec = { mode: 'fast' };

function qwenTts(model: string) {
  return {
    image: VLLM_OMNI_IMAGE,
    entrypoint: 'vllm',
    args: ['serve', model, '--omni', '--host', '0.0.0.0', '--port', '8091', '--trust-remote-code'],
    port: 8091,
    healthPath: '/health',
    provider: 'vast' as const,
    machineType: 'RTX 3090',
    candidates: vastLadder(),
    idleAction: 'delete' as const,
    ...VAST_HOST,
    scaling: CLASS_VOICE,
    gpu: true,
    volumeGb: 80,
    minReplicas: 0,
    maxReplicas: 2,
    targetInflightPerReplica: 8,
    idleMinutes: 15,
    bootTimeoutMinutes: 45,
    maxEurPerHour: 0.3,
  };
}

export const BUILTIN_PROFILES: Profile[] = [
  {
    name: 'qwen3-tts',
    builtin: true,
    spec: {
      ...qwenTts('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'),
      description: 'Qwen3-TTS 1.7B with built-in speakers on Vast (vLLM-Omni). POST /v1/audio/speech.',
    },
  },
  {
    name: 'qwen3-tts-clone',
    builtin: true,
    spec: {
      ...qwenTts('Qwen/Qwen3-TTS-12Hz-0.6B-Base'),
      description: 'Qwen3-TTS 0.6B Base (voice cloning from ref_audio + ref_text) on Vast (vLLM-Omni).',
    },
  },
  {
    name: 'speech-stack',
    builtin: true,
    spec: {
      // docker/speech-stack: Whisper large-v3 + Qwen3.5-9B (llama.cpp) + Qwen3-TTS (vLLM-Omni) in one image, the public
      // ghcr copy (a private registry is refused on Vast). Vast only (owner, 14/10/2026): an RTX 3090, the cheapest; a
      // declaration adds the 4090 and 5090 `candidates`. `envByMachineType` tunes each card.
      image: `ghcr.io/marcosremar/speech-stack:${SPEECH_STACK_TAG}`,
      port: 8000,
      healthPath: '/health',
      provider: 'vast',
      machineType: 'RTX 3090',
      maxEurPerHour: 0.3,
      ...VAST_HOST,
      entrypoint: 'bash',
      args: ['/opt/s2s/start.sh'],
      scaling: CLASS_VOICE,
      gpu: true,
      // ~57 GB image: the boot disk must hold it plus the Docker layers.
      volumeGb: 80,
      minReplicas: 0,
      maxReplicas: 2,
      // Measured 2026-10-06 (QA, L40S, 10 simultaneous s2s turns): the first-audio p95 stays under 3 s up to ~5–8 turns per
      // replica and the LLM's 8 slots queue beyond that, so a replica is added at 6 in flight (was 8).
      targetInflightPerReplica: 6,
      idleMinutes: 15,
      // Cold start is a measured 8–9 min (pull + model load + warm-up): the 240 s default would fail every cold call.
      coldStartWaitSeconds: 600,
      bootTimeoutMinutes: 20,
      // Vast cannot park a replica: it is deleted when idle.
      idleAction: 'delete',
      // Measured 2026-10-04 (docker/speech-stack/README.md): L4 24 GB fits STT_BATCH 4 / LLM 8 slots beside the TTS
      // (more OOMs); the L40S 48 GB takes STT_BATCH 8 / LLM 16 / a 12 GB TTS stage. RT_MAX_SESSIONS is the realtime
      // edge's per-replica cap when `realtime` is set (docs/realtime-edge.md): what one replica serves with the
      // MAXIMUM first audio under the 2.5 s ceiling. Measured live 2026-10-08 on one L40S
      // (docs/reports/2026-10-07-realtime-handoff.md § New image and class capacity): max 1.49–2.12 s at 4 learners
      // (2.44 s in a burst of 4), 2.16–2.39 s at 6, 2.64–2.83 s at 8, 3.87–4.44 s at 16 — so 4 (was 8, chosen on the
      // p95). The L4's 2 is an estimate from its /v1/s2s first audio (1.5 s with 1 turn, 4.2 s with 4), not a
      // realtime measurement. The RTX 5090 (Vast, 32 GB) takes the values of the live /v1/s2s run of 2026-10-08, where it
      // matched the L40S at 1 and 4 at once; its RT_MAX_SESSIONS 4 is the L40S's measured-safe value, to be re-measured
      // as realtime on the 5090 itself.
      envByMachineType: {
        'RTX 3090': { ...ENV_24GB, ...SPEECH_STACK_IMAGE_ENV },
        'RTX 4090': { ...ENV_24GB, ...SPEECH_STACK_IMAGE_ENV },
        'RTX 5090': { STT_BATCH: '8', LLM_PARALLEL: '16', TTS_STAGE0_MB: '9600', RT_MAX_SESSIONS: '4', ...SPEECH_STACK_IMAGE_ENV },
      },
      description: 'Whisper + Qwen LLM + Qwen3-TTS in one container (STT, S2S, /ws/audio-stream). POST /v1/s2s.',
    },
  },
  {
    name: 'cpu-echo',
    builtin: true,
    spec: {
      image: 'traefik/whoami:v1.10',
      port: 80,
      healthPath: '/health',
      machineType: 'DEV1-S',
      zone: 'fr-par-2',
      gpu: false,
      minReplicas: 0,
      maxReplicas: 2,
      idleMinutes: 5,
      bootTimeoutMinutes: 15,
      maxEurPerHour: 0.05,
      description: 'Tiny CPU echo server — smoke test for the deployment pipeline (≈ €0.01/h).',
    },
  },
];
