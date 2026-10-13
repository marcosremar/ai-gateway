#!/bin/bash
#SBATCH -J stt-lang-1010
#SBATCH -p gpu
#SBATCH --gres=gpu:p40:1
#SBATCH -c 4
#SBATCH --mem=24G
#SBATCH -t 01:00:00
#SBATCH -o /home/maramosp/stt-bench-1010/lang_%j.out
D0=/home/maramosp/qwen35-audio-bridge-stage0
D=/home/maramosp/stt-bench-1010
SCR=/storage/scratch/$USER-stt-lang-$SLURM_JOB_ID
mkdir -p $SCR/hf $SCR/tmp $SCR/cache || exit 1
trap "rm -rf $SCR" EXIT TERM INT
NV=$D0/.venv/lib/python3.11/site-packages/nvidia
export APPTAINERENV_HF_HOME=$SCR/hf APPTAINERENV_HF_HUB_DISABLE_IMPLICIT_TOKEN=1 APPTAINERENV_TMPDIR=$SCR/tmp APPTAINERENV_XDG_CACHE_HOME=$SCR/cache
apptainer exec --nv --bind $D0:$D0 --bind $D:$D --bind $SCR:$SCR --pwd $D --env LD_LIBRARY_PATH=$NV/cudnn/lib:$NV/cublas/lib:/usr/local/cuda/lib64:/.singularity.d/libs $D0/pytorch-devel.sif $D0/.venv/bin/python $D/langid.py $D/clips $D/langid.jsonl
wc -l $D/langid.jsonl; date
