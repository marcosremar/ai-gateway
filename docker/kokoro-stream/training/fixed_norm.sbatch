#!/bin/bash
#SBATCH --job-name=kokoro-fixednorm
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96G
#SBATCH --time=06:00:00
#SBATCH --output=%x-%j.out
set -euo pipefail
SCR=/storage/scratch/$USER/kokoro-ptpt
RUN=$HOME/kokoro-vocoder
export HF_HOME=$SCR/hf HF_HUB_DISABLE_XET=1 TMPDIR=$SCR/tmp
py() { apptainer exec --nv --bind $SCR:$SCR --bind $RUN:$RUN "$SCR/torch.sif" "$SCR/venv/bin/python" "$@"; }
nvidia-smi --query-gpu=name --format=csv,noheader | head -1
cd "$RUN"
py train_fixed_norm.py --kokoro-src "$RUN/kokoro_src" --data "$SCR/vocoder/data.pt" --out "$RUN/out_fixed" --train-until $(( $(date +%s) + 5 * 3600 + 30 * 60 ))
