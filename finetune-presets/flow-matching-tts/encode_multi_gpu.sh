#!/usr/bin/env bash
# Multi-GPU encoder: shard dataset across N GPUs in parallel.
# Speedup: ~N× linear (each GPU encodes its slice independently).
#
# Requires N = $(nvidia-smi --list-gpus | wc -l) GPUs visible.
#
# Usage:
#   bash encode_multi_gpu.sh <input.jsonl> <output.pt> [num_workers_per_gpu]
#
# Example (4× 4090 instance):
#   bash encode_multi_gpu.sh /root/erinome_with_paths.jsonl /root/erinome_mimi.pt 8

set -euo pipefail
INPUT="${1:?Usage: $0 <input.jsonl> <output.pt> [workers_per_gpu]}"
OUTPUT="${2:?Usage: $0 <input.jsonl> <output.pt> [workers_per_gpu]}"
WORKERS="${3:-8}"

NGPU=$(nvidia-smi --list-gpus 2>/dev/null | wc -l)
if [ "$NGPU" -lt 1 ]; then
    echo "[err] no GPUs detected"; exit 1
fi
echo "[multi-gpu] sharding $INPUT across $NGPU GPUs ($WORKERS workers each)"

PIDS=()
for i in $(seq 0 $((NGPU-1))); do
    SHARD_OUT="${OUTPUT}.shard${i}"
    CUDA_VISIBLE_DEVICES=$i python distill/finetune_pocket_tts.py encode \
        --input "$INPUT" \
        --output "$SHARD_OUT" \
        --num-workers "$WORKERS" \
        --shard-index "$i" \
        --num-shards "$NGPU" \
        > "/tmp/encode_shard_${i}.log" 2>&1 &
    PIDS+=("$!")
    echo "  GPU $i → PID ${PIDS[-1]} → $SHARD_OUT"
done

# Wait for all shards
FAILED=0
for pid in "${PIDS[@]}"; do
    if ! wait "$pid"; then FAILED=1; fi
done
if [ $FAILED -eq 1 ]; then
    echo "[err] one or more shards failed. Logs:"
    for i in $(seq 0 $((NGPU-1))); do
        echo "--- /tmp/encode_shard_${i}.log (last 10 lines) ---"
        tail -10 "/tmp/encode_shard_${i}.log"
    done
    exit 1
fi

# Merge shards into final .pt
echo "[multi-gpu] merging $NGPU shards → $OUTPUT"
python -c "
import sys, torch, os
shards = [torch.load(sys.argv[1] + '.shard' + str(i), weights_only=False) for i in range(int(sys.argv[2]))]
all_rows = []
for s in shards:
    all_rows.extend(s)
torch.save(all_rows, sys.argv[1])
print(f'merged {len(all_rows)} samples → {sys.argv[1]}')
for i in range(int(sys.argv[2])):
    os.remove(sys.argv[1] + '.shard' + str(i))
" "$OUTPUT" "$NGPU"

echo "[multi-gpu] done."
