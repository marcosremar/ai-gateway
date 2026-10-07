/**
 * Built-in deployment profiles. Callers can add their own (`PUT /v1/profiles/:name`); a stored profile with the
 * same name as a built-in one overrides it.
 */

import type { Profile } from './types';

/** vLLM-Omni serves Qwen3-TTS with an OpenAI-shaped `POST /v1/audio/speech` (same image the parle L4 runs). */
const VLLM_OMNI_IMAGE = 'vllm/vllm-omni:v0.28.0';

function qwenTts(model: string) {
  return {
    image: VLLM_OMNI_IMAGE,
    entrypoint: 'vllm',
    args: ['serve', model, '--omni', '--host', '0.0.0.0', '--port', '8091', '--trust-remote-code'],
    port: 8091,
    healthPath: '/health',
    machineType: 'L4-1-24G',
    zone: 'fr-par-2',
    gpu: true,
    volumeGb: 80,
    minReplicas: 0,
    maxReplicas: 2,
    targetInflightPerReplica: 8,
    idleMinutes: 15,
    bootTimeoutMinutes: 45,
    maxEurPerHour: 1,
  };
}

export const BUILTIN_PROFILES: Profile[] = [
  {
    name: 'qwen3-tts',
    builtin: true,
    spec: {
      ...qwenTts('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'),
      description: 'Qwen3-TTS 1.7B with built-in speakers on a Scaleway L4 (vLLM-Omni). POST /v1/audio/speech.',
    },
  },
  {
    name: 'qwen3-tts-clone',
    builtin: true,
    spec: {
      ...qwenTts('Qwen/Qwen3-TTS-12Hz-0.6B-Base'),
      description: 'Qwen3-TTS 0.6B Base (voice cloning from ref_audio + ref_text) on a Scaleway L4 (vLLM-Omni).',
    },
  },
  {
    name: 'speech-stack',
    builtin: true,
    spec: {
      // docker/speech-stack: Whisper large-v3 + Qwen3.5-9B (llama.cpp) + Qwen3-TTS (vLLM-Omni) in one image.
      image: 'rg.fr-par.scw.cloud/aigw/speech-stack:20261004-2240',
      port: 8000,
      healthPath: '/health',
      // The L40S the parle class runs on (live QA 2026-10-07), and when it is out of stock (17 min in fr-par-2 that day, the
      // 2nd replica never came): the same type in fr-par-1 (skipped at no cost when not sold there), then an L4 in
      // fr-par-2, Warsaw (the zones with GPU stock on 2026-10-06) and fr-par-1 — `envByMachineType` tunes each GPU.
      machineType: 'L40S-1-48G',
      zone: 'fr-par-2',
      placements: [
        { zone: 'fr-par-1' }, { machineType: 'L4-1-24G' }, { zone: 'pl-waw-2', machineType: 'L4-1-24G' },
        { zone: 'fr-par-1', machineType: 'L4-1-24G' },
      ],
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
      // Park instead of delete: a powered-off replica keeps its disk and IP and comes back in ~2 min, not 9.
      idleAction: 'stop',
      maxEurPerHour: 2,
      // Measured 2026-10-04 (docker/speech-stack/README.md): L4 24 GB fits STT_BATCH 4 / LLM 8 slots beside the TTS
      // (more OOMs); the L40S 48 GB takes STT_BATCH 8 / LLM 16 / a 12 GB TTS stage.
      envByMachineType: {
        'L4-1-24G': { STT_BATCH: '4', LLM_PARALLEL: '8', TTS_STAGE0_MB: '7400' },
        'L40S-1-48G': { STT_BATCH: '8', LLM_PARALLEL: '16', TTS_STAGE0_MB: '12000' },
      },
      description: 'Whisper + Qwen LLM + Qwen3-TTS in one container (STT, S2S, /ws/audio-stream). POST /v1/s2s.',
    },
  },
  {
    name: 'whisper-stt',
    builtin: true,
    spec: {
      // docker/whisper-stt: Whisper large-v3 (STT) + Qwen3.5-9B Q4 (llama.cpp) in one image. No TTS.
      // CPU-friendly (int8) — runs on a cheap CPU instance; the L4 placement adds llama.cpp CUDA speed.
      image: 'rg.fr-par.scw.cloud/aigw/whisper-stt:20261007-0916',
      port: 8000,
      healthPath: '/health',
      machineType: 'POP2-HC-4C-8G',
      zone: 'fr-par-2',
      placements: [
        { machineType: 'L4-1-24G' }, { zone: 'pl-waw-2' }, { zone: 'fr-par-1' },
      ],
      gpu: false,
      volumeGb: 40,
      minReplicas: 0,
      maxReplicas: 2,
      targetInflightPerReplica: 4,
      idleMinutes: 10,
      // Image is ~18.7 GB (whisper 3 GB + Qwen GGUF 5.3 GB baked): pull + warm-up takes minutes.
      coldStartWaitSeconds: 600,
      bootTimeoutMinutes: 20,
      idleAction: 'stop',
      maxEurPerHour: 0.5,
      envByMachineType: {
        'L4-1-24G': { STT_COMPUTE: 'float16', LLM_THREADS: '8' },
      },
      description: 'Whisper large-v3 STT + Qwen3.5-9B Q4 LLM (translation) in one container. POST /v1/audio/transcriptions, /v1/chat/completions, /ws/audio-stream.',
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
