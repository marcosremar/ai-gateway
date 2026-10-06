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
