#!/bin/bash
#SBATCH -J stt-bench-1010
#SBATCH -p gpu
#SBATCH --gres=gpu:p40:2
#SBATCH -c 8
#SBATCH --mem=48G
#SBATCH -t 03:00:00
#SBATCH -o /home/maramosp/stt-bench-1010/slurm_%j.out
D0=/home/maramosp/qwen35-audio-bridge-stage0
D2=/home/maramosp/qwen35-audio-bridge-stage2
C=/home/maramosp/qwen35-audio-bridge-stage4
D=/home/maramosp/stt-bench-1010
SCR=/storage/scratch/$USER-stt-bench-$SLURM_JOB_ID
mkdir -p $SCR/hf $SCR/tmp $SCR/pip $SCR/cache $D/results || exit 1
trap "kill \$(jobs -p) 2>/dev/null; rm -rf $SCR" EXIT TERM INT
EL=$D/clips/manifest.jsonl
PROBE=$D2/data/probe/manifest.jsonl
R=$D/results
SITE=lib/python3.11/site-packages
NV=$D0/.venv/$SITE/nvidia
BIND="--bind $D0:$D0 --bind $D2:$D2 --bind $C:$C --bind $D:$D --bind $SCR:$SCR"
export APPTAINERENV_HF_HOME=$SCR/hf APPTAINERENV_HF_HUB_DISABLE_IMPLICIT_TOKEN=1 APPTAINERENV_TMPDIR=$SCR/tmp
export APPTAINERENV_PIP_CACHE_DIR=$SCR/pip APPTAINERENV_XDG_CACHE_HOME=$SCR/cache APPTAINERENV_NUMBA_CACHE_DIR=$SCR/cache
box() { apptainer exec --nv $BIND --pwd $C --env CUDA_VISIBLE_DEVICES=$1 --env LD_LIBRARY_PATH=$NV/cudnn/lib:$NV/cublas/lib:/usr/local/cuda/lib64:/.singularity.d/libs $D0/pytorch-devel.sif "${@:2}"; }
hostname; date; nvidia-smi --query-gpu=name,memory.total --format=csv
box "" $D0/.venv/bin/python -m venv $SCR/vq && echo $D0/.venv/$SITE > $SCR/vq/$SITE/base.pth && box "" $SCR/vq/bin/pip install -q qwen-asr > $R/pip-vq.log 2>&1
echo "PIP_EXIT $?"
lane0() {
  box 0 $SCR/vq/bin/python -m bridge.eval_alt --system qwen3asr --model Qwen/Qwen3-ASR-1.7B --manifest $EL $PROBE --out $R/qwen3asr-el $R/qwen3asr-probe > $R/qwen3asr.log 2>&1
  echo "EVAL_EXIT qwen3asr $? $(date +%H:%M)"
}
lane1() {
  for SET in el:$EL probe:$PROBE; do
    box 1 $D0/.venv/bin/python -m bridge.eval_whisper --speech-stack $D0/s0b/speech-stack --model large-v3 --compute float32 --manifest ${SET#*:} --out $R/whisper-${SET%%:*} > $R/whisper-${SET%%:*}.log 2>&1
    echo "EVAL_EXIT whisper-${SET%%:*} $? $(date +%H:%M)"
  done
}
lane0 & A=$!
lane1 & wait $A $!
box "" $D0/.venv/bin/python -m bridge.fidelity score $R/*-probe/hypotheses.jsonl > $R/fidelity.jsonl
date
