# SnapGPU Smoke Test

Validates that CRIU + cuda-checkpoint work on a real Vast.ai GPU host before
we invest in building the full snapgpu-runtime Docker image.

## What it tests

1. SSH into a Vast.ai RTX 4090 instance
2. Install CRIU + cuda-checkpoint
3. Run a minimal Python CUDA program (loads a small model into VRAM)
4. Snapshot the process (CRIU dump + cuda-checkpoint toggle)
5. Kill the process
6. Restore from snapshot
7. Verify the model is still in VRAM and functional
8. Measure snapshot/restore latency

## Prerequisites

- `VAST_API_KEY` in `.env` (same as ai-gateway)
- SSH key configured for Vast.ai
- ~$0.50 budget (one RTX 4090 instance for ~15 minutes)

## Usage

```bash
# Dry run — shows what would happen without creating an instance
bun run scripts/snapgpu-smoke-test/run.ts --dry-run

# Full test
bun run scripts/snapgpu-smoke-test/run.ts

# With a specific GPU type
bun run scripts/snapgpu-smoke-test/run.ts --gpu "RTX 3090"
```

## Expected output

```
[smoke] Deploying Vast.ai instance (RTX 4090)...
[smoke] Instance created: inst-34345678 @ 108.179.132.68:41944
[smoke] Installing CRIU + cuda-checkpoint via SSH...
[smoke] Running CUDA test program...
[smoke] Creating snapshot...
[smoke] Snapshot created: 847MB (GPU=true) in 3.2s
[smoke] Killing process...
[smoke] Restoring from snapshot...
[smoke] Restored in 1.8s — model still functional: YES
[smoke] Cleaning up...
[smoke] RESULT: PASS — snapshot 3.2s, restore 1.8s, total cold-start reduction ~95%
```

If CRIU or cuda-checkpoint fail (driver too old, kernel mismatch), the script
reports the error clearly and terminates the instance.
