#!/bin/bash
#SBATCH --job-name=kokoro-vocoder
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96G
#SBATCH --time=06:00:00
#SBATCH --output=%x-%j.out
set -euo pipefail
SCR=/storage/scratch/$USER/kokoro-ptpt
RUN=$HOME/kokoro-vocoder
WORK=$SCR/vocoder
mkdir -p "$WORK"
export HF_HOME=$SCR/hf HF_HUB_DISABLE_XET=1 TMPDIR=$SCR/tmp
py() { apptainer exec --nv --bind $SCR:$SCR --bind $RUN:$RUN "$SCR/torch.sif" "$SCR/venv/bin/python" "$@"; }
TRAIN_UNTIL=$(( $(date +%s) + 5 * 3600 + 20 * 60 ))
nvidia-smi --query-gpu=name --format=csv,noheader
[ -s "$WORK/data.pt" ] || py "$RUN/train_vocoder.py" precompute --kokoro-src "$RUN/kokoro_src" --phonemes "$RUN/phonemes.tsv" --data "$WORK/data.pt"
py "$RUN/train_vocoder.py" train --data "$WORK/data.pt" --out "$RUN/out" --train-until "$TRAIN_UNTIL"
py "$RUN/train_vocoder.py" evaluate --out "$RUN/out"
