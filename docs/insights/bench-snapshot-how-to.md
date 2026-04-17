# How to run the snapshot benchmark

Companion to `scripts/bench-snapshot.ts` (Phase B, ADR-012). This document
exists because the script cannot be executed from a laptop — results are
systematically misleading on Wi-Fi + consumer SSD vs real GPU + NVMe. See
`memory/feedback_coldstart_bench_on_real_gpu.md`.

## Prereqs

- A Vast.ai account with `vm:true` available on at least one RTX 4090 host
  (or Hyperstack H100 PCIe VM — both are snapshot-capable per ADR-014).
- R2 bucket created for snapshots with access key and secret. Env vars
  `R2_SNAPSHOTS_BUCKET`, `R2_SNAPSHOTS_ACCESS_KEY`, `R2_SNAPSHOTS_SECRET_KEY`,
  optionally `R2_SNAPSHOTS_ENDPOINT`.
- Gateway env: `VAST_API_KEY` (for the cold deploy) or `HYPERSTACK_API_KEY`.
- Driver 570+ inside the VM. Vast.ai ships 535-570 depending on host; you
  may need to `apt install nvidia-driver-570` on the VM before the first
  capture runs.

## What to measure

Three timings per run:

1. **Cold deploy** — baseline end-to-end: pull → boot → model-load → ready.
   Expected ballpark today: 2-15 min depending on image and GPU.
2. **Capture** — `criu dump` + tar + R2 upload. Target: <20s.
3. **Warm deploy (restore)** — same image/model, but takes the snapshot
   path. Target: 3-8s per Modal's envelope.

Each timing goes into `insights/bench-snapshot.csv` (one row per measurement).

## Running from the gateway host

Assuming the gateway host has both API keys and R2 credentials:

```bash
# Full cycle: cold → capture → warm. Takes ~10-20 min end-to-end.
bun run scripts/bench-snapshot.ts full

# Or just the cold baseline (quickest):
bun run scripts/bench-snapshot.ts cold

# Capture only (needs an already-running pod with `POD_SSH` + `POD_PORT` env
# pointing at it):
POD_SSH=root@ssh.vast.ai POD_PORT=12345 bun run scripts/bench-snapshot.ts capture

# Restore only (uses whichever snapshot matches in the catalog):
bun run scripts/bench-snapshot.ts restore
```

## Running on a fresh Vast.ai VM

1. Launch a VM with `vm:true` (use `autoSelectCheapestGpu({ minDriverVersion: 570 })`
   or select manually from the Vast console).
2. SSH in: `ssh root@ssh5.vast.ai -p <port>`.
3. Verify driver + capabilities:
   ```bash
   nvidia-smi --query-gpu=driver_version --format=csv,noheader
   # expect >= 570.x.x
   capsh --has-p=CAP_CHECKPOINT_RESTORE || capsh --has-p=CAP_SYS_ADMIN
   # should print nothing and exit 0
   ```
4. If driver < 570, install it (Ubuntu 22.04):
   ```bash
   sudo apt update && sudo apt install -y nvidia-driver-570
   sudo reboot
   ```
5. Install CRIU 4.0+:
   ```bash
   sudo apt install -y criu zstd
   criu --version    # expect 4.0 or later
   ```
6. Clone the gateway, `bun install`, set env vars, then run the bench as
   above.

## What NOT to do

- **Do not run on macOS.** The numbers will look competitive but do not
  correlate with production behavior. This has burned us before — see the
  memory note.
- **Do not run against shared dev R2 buckets** while benchmarking. Cold
  egress throughput is what we're measuring; another process writing to
  the same bucket skews both capture and restore timings.
- **Do not skip the driver check.** A driver < 570 will silently fail
  `cuda-checkpoint` and fall back to CPU checkpoint, which is useless for
  our comparison.

## Interpreting results

Open `insights/bench-snapshot.csv` after the run. A healthy pattern:

```
ts_iso,mode,provider,gpu,cold_ms,capture_ms,snapshot_mb,warm_ms
2026-04-17T18:00:00Z,full,vast-vm,RTX 4090,180000,14200,1450,5800
```

That's 180s cold → 14s capture → 5.8s warm — a 31× cold-start win. If
`warm_ms > cold_ms / 3`, investigate before proposing the pool config
(ADR-013). Likely culprits: snapshot stale (image drifted), R2 egress
throttled, or host CPU contention during restore.

Commit the CSV. It's the input the team uses to validate ADR-012 is still
paying off over time.
