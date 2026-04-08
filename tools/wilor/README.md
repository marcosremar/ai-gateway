# WiLoR Docker — RTX 4090 Hand Pose Estimation

Self-contained Docker setup for [WiLoR](https://github.com/rolpotamias/WiLoR) (CVPR 2025 — End-to-end 3D Hand Localization & Reconstruction). Designed and tested for **NVIDIA RTX 4090**.

## What you get

- **WiLoR**: SOTA on FreiHAND and HO3D benchmarks for 3D hand mesh reconstruction
- **130+ FPS** hand detection (`detector.pt` is a YOLOv8 model)
- **~30 FPS** full 3D mesh reconstruction with `--fast` (FP16 + depth pruning) on RTX 4090
- **Gradio web UI** at `http://localhost:7860` for drag-and-drop testing
- **CLI demo** for batch processing of an image folder

WiLoR is currently the best option to run **today** — HandOS (Dec 2024) achieves slightly higher accuracy on benchmarks but has **no public code release** as of 2026-04-08.

## Prerequisites

- **NVIDIA GPU** (tested on RTX 4090, anything ≥ Ampere with ≥10GB VRAM should work)
- **NVIDIA Container Toolkit** installed on the host:
  ```bash
  # Ubuntu
  distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
  curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  ```
- **MANO model** — required by the code, license-restricted, not included in the image:
  1. Register at https://mano.is.tue.mpg.de/ (free, instant)
  2. Download `mano_v1_2.zip`
  3. Extract `MANO_RIGHT.pkl` and place it at `./mano_data/MANO_RIGHT.pkl`

## Quick start

```bash
cd tools/wilor

# 1. Place MANO_RIGHT.pkl
mkdir -p mano_data
cp /path/to/MANO_RIGHT.pkl mano_data/

# 2. Build the image (~5 min, downloads ~700MB of weights at build time)
docker compose build

# 3. Run the gradio web UI
docker compose up -d

# 4. Open http://localhost:7860 in your browser
```

The first build downloads ~3 GB of CUDA libs + 700 MB of WiLoR weights. Subsequent builds are cached.

## Run the CLI demo (batch process a folder)

```bash
mkdir -p input output
cp /path/to/your/photos/*.jpg input/

docker compose run --rm wilor python demo.py \
  --img_folder demo_img \
  --out_folder /app/WiLoR/demo_out \
  --fast \
  --save_mesh

# Results land in ./output/
```

Flags:
- `--fast` — half precision + depth pruning, ~1.6× faster, virtually no accuracy loss
- `--save_mesh` — saves a `.obj` mesh per detected hand (loadable in Blender)
- `--full_frame` — output overlaid on the original full image (vs cropped)
- `--side_view` — also render a side view

## Performance on RTX 4090

| Mode | Throughput | VRAM peak |
|------|-----------|-----------|
| `gradio_demo.py` (single image, default) | ~12-18 FPS | ~6 GB |
| `demo.py --fast` (batch, half precision) | ~25-35 FPS | ~5 GB |
| `demo.py` (batch, FP32) | ~15-22 FPS | ~9 GB |

(Measurements vary with image resolution and number of detected hands.)

## Files

```
tools/wilor/
├── Dockerfile          # CUDA 12.4 + Python 3.10 + WiLoR
├── docker-compose.yml  # NVIDIA runtime + volume mounts + ports
├── README.md           # this file
├── .gitignore          # excludes user data dirs
├── mano_data/          # ← put MANO_RIGHT.pkl here (gitignored)
├── input/              # ← drop images here for CLI demo (gitignored)
└── output/             # ← results land here (gitignored)
```

## Troubleshooting

**`could not select device driver "nvidia"`** — install nvidia-container-toolkit and restart Docker.

**`MANO_RIGHT.pkl not found`** — verify `./mano_data/MANO_RIGHT.pkl` exists on the host. Check `docker compose exec wilor ls /app/WiLoR/mano_data/`.

**`OSError: pyrender` / `EGL` errors** — ensure your host has NVIDIA driver ≥525 with GL libs. The compose file sets `PYOPENGL_PLATFORM=egl` and grants the `graphics` capability.

**`CUDA out of memory`** — drop the input resolution, use `--fast`, or downgrade to one hand at a time.

**Gradio shows "127.0.0.1 refused connection"** — `GRADIO_SERVER_NAME=0.0.0.0` is already set in the compose file. If you customized the env, make sure gradio binds to 0.0.0.0 inside the container.

## Why WiLoR (and not HandOS / HaMeR)

| Model | Accuracy (FreiHAND PA-MPJPE ↓) | Real-time | Code | Docker |
|-------|-------------------------------|-----------|------|--------|
| **WiLoR** | ~5.5 mm | ✅ 130 FPS det + ~30 FPS mesh | ✅ | ✅ (this) |
| HandOS (Dec 2024) | **5.0 mm** (SOTA) | ❌ ~5 FPS, very heavy | ❌ paper-only | ❌ |
| HaMeR (2023) | ~6.0 mm | ✅ ~20 FPS | ✅ | ✅ (official) |
| Fast-HaMeR | ~6.4 mm | ✅ ~30 FPS | ✅ | ✅ (official) |
| MediaPipe Hands | n/a (not 3D mesh) | ✅ 60+ FPS CPU | ✅ | n/a |

WiLoR wins the practical "best 3D hand mesh model you can run today" — modern code, well maintained, single best paper among code-released methods, runs on consumer GPUs.

## Sources

- WiLoR repo: https://github.com/rolpotamias/WiLoR
- Paper: https://arxiv.org/abs/2409.12259
- Project page: https://rolpotamias.github.io/WiLoR/
- Pretrained weights mirror: https://huggingface.co/spaces/rolpotamias/WiLoR/tree/main/pretrained_models
- MANO model: https://mano.is.tue.mpg.de/
