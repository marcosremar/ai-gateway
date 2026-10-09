/**
 * Built-in deployment profiles. Callers can add their own (`PUT /v1/profiles/:name`); a stored profile with the
 * same name as a built-in one overrides it.
 */

import type { Profile, ScalingSpec } from './types';

/** vLLM-Omni serves Qwen3-TTS with an OpenAI-shaped `POST /v1/audio/speech` (same image the parle L4 runs). */
const VLLM_OMNI_IMAGE = 'vllm/vllm-omni:v0.28.0';

const VAST_GPU = { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.85 } as const;
const VAST_HOST = { minCuda: 13, maxRttExcessMs: 20 };
const SPEECH_STACK_TAG = '20261009-0213';
const SPEECH_STACK_IMAGE_ENV = { TTS_MODEL: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', LLM_FILE: 'Qwen3.5-9B-Q4_K_M.gguf' };
const CLASS_VOICE: ScalingSpec = { mode: 'fast' };

function qwenTts(model: string) {
  return {
    image: VLLM_OMNI_IMAGE,
    entrypoint: 'vllm',
    args: ['serve', model, '--omni', '--host', '0.0.0.0', '--port', '8091', '--trust-remote-code'],
    port: 8091,
    healthPath: '/health',
    machineType: 'L4-1-24G',
    zone: 'fr-par-2',
    placements: [{ zone: 'fr-par-1' }, { ...VAST_GPU, maxReplicas: 2 }],
    ...VAST_HOST,
    scaling: CLASS_VOICE,
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

/** coturn image, pinned (Docker Hub `coturn/coturn`, the project's official image). */
export const COTURN_IMAGE = 'coturn/coturn:4.6.3';
/** UDP relay range of the coturn deployment (opened in its firewall; ~1 port per relayed leg). */
export const COTURN_RELAY_PORTS: [number, number] = [49152, 49351];

/**
 * coturn on the host network: `use-auth-secret` (TURN REST credentials: username "<exp>:<sid>", password
 * base64(HMAC-SHA1(secret, username)), what the gateway mints per session), no TLS listener (443 is redirected to 3478,
 * plain TCP), relay ports in COTURN_RELAY_PORTS, the reserved IP as external IP, peers on private ranges denied (a TURN
 * server must not become a door into the cloud network), and the Prometheus exporter on 127.0.0.1:9641 as the health
 * the gateway probes. REALTIME_TURN_SECRET comes from the deployment env (/srv/aigw/app.env).
 */
const COTURN_BOOT_SCRIPT = `set -eu
set -a; . /srv/aigw/app.env; set +a
: "\${REALTIME_TURN_SECRET:?set REALTIME_TURN_SECRET in the deployment env}"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
PUB=$(curl -sf --max-time 5 'http://169.254.42.42/conf?format=json' | python3 -c 'import json,sys; print((json.load(sys.stdin).get("public_ip") or {}).get("address",""))' || true)
[ -n "$PUB" ] || PUB=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}')
iptables -t nat -C PREROUTING -p tcp --dport 443 -j REDIRECT --to-ports 3478 2>/dev/null \
  || iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-ports 3478
docker rm -f coturn 2>/dev/null || true
docker run -d --name coturn --restart unless-stopped --network host ${COTURN_IMAGE} \
  -n --log-file=stdout --listening-port=3478 --no-tls --no-dtls --fingerprint --realm=aigw \
  --use-auth-secret --static-auth-secret="$REALTIME_TURN_SECRET" --external-ip="$PUB" \
  --min-port=${COTURN_RELAY_PORTS[0]} --max-port=${COTURN_RELAY_PORTS[1]} --no-multicast-peers --no-cli \
  --denied-peer-ip=10.0.0.0-10.255.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=100.64.0.0-100.127.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --prometheus --prometheus-port=9641
`;

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
      image: `rg.fr-par.scw.cloud/aigw/speech-stack:${SPEECH_STACK_TAG}`,
      port: 8000,
      healthPath: '/health',
      // The L40S the parle class runs on (live QA 2026-10-07), and when it is out of stock (17 min in fr-par-2 that day, the
      // 2nd replica never came): the same type in fr-par-1 (skipped at no cost when not sold there), then one RTX 5090 on
      // Vast. No L4: the account's L4 quota (2) belongs to the TTS deployment. `envByMachineType` tunes each GPU.
      machineType: 'L40S-1-48G',
      zone: 'fr-par-2',
      placements: [{ zone: 'fr-par-1' }, { ...VAST_GPU, maxReplicas: 1, image: `ghcr.io/marcosremar/speech-stack:${SPEECH_STACK_TAG}` }],
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
      // Park instead of delete: a powered-off replica keeps its disk and IP and comes back in ~2 min, not 9.
      idleAction: 'stop',
      maxEurPerHour: 2,
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
        'L4-1-24G': { STT_BATCH: '4', LLM_PARALLEL: '8', TTS_STAGE0_MB: '7400', RT_MAX_SESSIONS: '2' },
        'L40S-1-48G': { STT_BATCH: '8', LLM_PARALLEL: '16', TTS_STAGE0_MB: '12000', RT_MAX_SESSIONS: '4', LLM_SLOT_CTX: '4096' },
        'RTX 5090': { STT_BATCH: '8', LLM_PARALLEL: '16', TTS_STAGE0_MB: '9600', RT_MAX_SESSIONS: '4', ...SPEECH_STACK_IMAGE_ENV },
      },
      description: 'Whisper + Qwen LLM + Qwen3-TTS in one container (STT, S2S, /ws/audio-stream). POST /v1/s2s.',
    },
  },
  {
    name: 'coturn',
    builtin: true,
    spec: {
      // TURN relay for the realtime edge's WebRTC (docs/realtime-edge.md § TURN): browsers on networks that block UDP
      // relay through it. Boot-script mode on a small CPU machine with a reserved IP (exposure): the gateway hands each
      // session `turn:<ip>:3478?transport=udp`, `turn:<ip>:3478?transport=tcp` and `turn:<ip>:443?transport=tcp`
      // (REALTIME_TURN_URLS) with a per-session credential from REALTIME_TURN_SECRET — the same value goes in this
      // deployment's env. 443 is plain TURN over TCP (an iptables redirect to 3478): `turns:` with a self-signed
      // certificate is not trusted by browsers; a real `turns:` needs a domain + certificate (see the doc).
      image: '',
      port: 9641,
      healthPath: '/metrics',
      machineType: 'DEV1-S',
      zone: 'fr-par-2',
      gpu: false,
      minReplicas: 1,
      maxReplicas: 1,
      idleMinutes: 24 * 60,
      bootTimeoutMinutes: 15,
      maxEurPerHour: 0.05,
      exposure: {
        ports: [
          { protocol: 'udp', port: 3478 },
          { protocol: 'tcp', port: 3478 },
          { protocol: 'tcp', port: 443 },
          // Relay allocations: one port per relayed browser leg.
          { protocol: 'udp', port: COTURN_RELAY_PORTS[0], to: COTURN_RELAY_PORTS[1] },
        ],
      },
      bootScript: COTURN_BOOT_SCRIPT,
      description: 'TURN relay (coturn, use-auth-secret REALTIME_TURN_SECRET) for realtime WebRTC: 3478 udp/tcp + 443 tcp.',
    },
  },
  {
    name: 'whisper-stt',
    builtin: true,
    spec: {
      // docker/whisper-stt: Whisper large-v3 (STT) + Qwen3.5-9B Q4 (llama.cpp) in one image. No TTS.
      // CPU-first (int8) — cheap CPU instance. The schema requires every placement to
      // match `gpu`; a GPU ladder would need `gpu: true` + a GPU-first machineType.
      image: 'rg.fr-par.scw.cloud/aigw/whisper-stt:20261007-0916',
      port: 8000,
      healthPath: '/health',
      machineType: 'POP2-HC-4C-8G',
      zone: 'fr-par-2',
      placements: [
        { zone: 'pl-waw-2' }, { zone: 'fr-par-1' },
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
      scaling: { mode: 'balanced' },
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
