#!/bin/bash
#SBATCH -J stt-align-1010
#SBATCH -p gpu
#SBATCH --gres=gpu:p40:2
#SBATCH -c 8
#SBATCH --mem=32G
#SBATCH -t 03:00:00
#SBATCH -o /home/maramosp/stt-bench-1010/align_%j.out
D0=/home/maramosp/qwen35-audio-bridge-stage0
D=/home/maramosp/stt-bench-1010
SCR=/storage/scratch/$USER-stt-align-$SLURM_JOB_ID
mkdir -p $SCR/hf $SCR/tmp $SCR/cache || exit 1
trap "kill \$(jobs -p) 2>/dev/null; rm -rf $SCR" EXIT TERM INT
SITE=lib/python3.11/site-packages
NV=$D0/.venv/$SITE/nvidia
export APPTAINERENV_HF_HOME=$SCR/hf APPTAINERENV_HF_HUB_DISABLE_IMPLICIT_TOKEN=1 APPTAINERENV_TMPDIR=$SCR/tmp APPTAINERENV_XDG_CACHE_HOME=$SCR/cache
box() { apptainer exec --nv --bind $D0:$D0 --bind $D:$D --bind $SCR:$SCR --pwd $D --env CUDA_VISIBLE_DEVICES=$1 --env LD_LIBRARY_PATH=$NV/cudnn/lib:$NV/cublas/lib:/usr/local/cuda/lib64:/.singularity.d/libs $D0/pytorch-devel.sif "${@:2}"; }
hostname; date
box "" $D0/.venv/bin/hf download deepdml/faster-whisper-large-v3-turbo-ct2 > /dev/null
box 0 $D0/.venv/bin/python $D/align_words.py $D/mp3 $D/words 0 2 > $D/align0.log 2>&1 &
box 1 $D0/.venv/bin/python $D/align_words.py $D/mp3 $D/words 1 2 > $D/align1.log 2>&1 &
wait
ls $D/words | wc -l; date
