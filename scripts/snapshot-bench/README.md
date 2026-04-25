# Cross-VM snapshot benchmark

End-to-end measurement of CRIU + `cuda-checkpoint` snapshot capture on one
Hyperstack L40 (CANADA-1) VM, followed by restore on a *different* fresh L40
VM. This is the numbers-that-matter test for the standby-pool scenario:
capture the model-in-RAM on VM_A, kill VM_A, spin VM_B, restore.

The bench is purely a driver — it talks to the local gateway over HTTP and to
the VMs over SSH. It does not import `server/gpu-snapshot.ts` and does not
reach for provider APIs directly.

## Prereqs

1. **Gateway running locally** (default `http://localhost:4100`). The
   in-flight work that wires `useCudaCheckpoint` into `captureSnapshot` /
   `restoreSnapshot` must have landed before this bench produces meaningful
   numbers — otherwise CRIU will dump CPU state only and the "restore" path
   will not actually have VRAM warm.

2. **Env vars** (all required):

   ```
   HYPERSTACK_API_KEY
   HYPERSTACK_SNAPSHOTS_BUCKET
   HYPERSTACK_SNAPSHOTS_ENDPOINT
   HYPERSTACK_SNAPSHOTS_ACCESS_KEY
   HYPERSTACK_SNAPSHOTS_SECRET_KEY
   # optional:
   HYPERSTACK_SNAPSHOTS_REGION   # default CANADA-1
   GATEWAY_URL                    # default http://localhost:4100
   BENCH_IMAGE                    # Docker image for the pod
   ```

3. **SSH keypair on the gateway host** — `ai-gateway` already uploads the
   public key to Hyperstack on deploy; the bench uses the same `ubuntu@`
   account.

4. **AWS CLI reachable from the pod** — the bootstrap script installs it
   inside the VM (`apt-get install awscli`) and uses `--endpoint-url` to talk
   to Hyperstack Object Storage. No AWS account needed.

## Running

```
bun scripts/snapshot-bench/run-cross-vm-bench.ts
bun scripts/snapshot-bench/run-cross-vm-bench.ts --model google/gemma-2-2b
bun scripts/snapshot-bench/run-cross-vm-bench.ts --model openai/whisper-large-v3

# Restore-only against an existing key (skips VM_A and capture):
bun scripts/snapshot-bench/run-cross-vm-bench.ts --no-capture \
  --snapshot-key bench/microsoft-phi-3-5-mini-instruct/2026-04-18T20-00-00-000Z.tar.zst

# Keep VM_B alive for post-mortem:
bun scripts/snapshot-bench/run-cross-vm-bench.ts --keep
```

## Runtime + cost

Expect **~15-20 min per full run** (cold deploy + bootstrap dominates the
wall clock — model load is only a couple of minutes once the VM is up).
Two L40s at Hyperstack CANADA-1 pricing (~$1.10/hr each) → **~$0.60 per
full run**. The bench terminates both VMs on its way out unless `--keep` is
passed.

## Output

- `bench-results/snapshot-cross-vm-<model>-<iso>.json` — full timings +
  errors, schema_version `1`.
- `bench-results/snapshot-cross-vm-history.jsonl` — one compact line per
  run, convenient for `jq` / plotting.
- Markdown summary printed to stdout at the end of the run.

Each JSON includes a `summary` block with `cold_total_ms`,
`warm_total_ms`, `speedup`, and `capture_overhead_ms` (the pay-once
capture-and-publish cost).

## Why SSH + a shell pipeline instead of a nicer RPC?

Because the interesting path here — `criu dump` → `tar | zstd` → `aws s3
cp` — is a native-toolchain pipeline that runs on the VM, and wrapping it
in an agent would obscure what is being measured. Every phase in the
bench is backed by a single `ssh` invocation with a literal script, so the
JSON timings map 1:1 onto things an operator would actually type.
