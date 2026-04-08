# HaMeR Docker — RTX 4090 Hand Mesh Reconstruction

Self-contained Docker setup for [HaMeR](https://github.com/geopavlakos/hamer) (Reconstructing Hands in 3D with Transformers, ICCV 2023). The "previous SOTA" — still highly competitive in 2025, with mature/well-maintained code and the most stable result quality.

## Why HaMeR (and not WiLoR)?

| | HaMeR | WiLoR |
|---|---|---|
| Year | ICCV 2023 | CVPR 2025 |
| Backbone | ViT-H (~600M params) | CNN detector + smaller ViT |
| FreiHAND PA-MPJPE | ~6.0 mm | ~5.5 mm |
| Speed (RTX 4090) | ~5-10 FPS | ~25-35 FPS (with `--fast`) |
| Mesh quality | **Higher detail** | Slightly lighter |
| Code maturity | **Battle-tested**, 1k+ stars | Newer, fewer downstream users |
| Web UI | ❌ CLI-only | ✅ gradio_demo.py |

**Use HaMeR when:** you want maximum mesh quality, you're processing offline (annotation, dataset prep, research), or you trust a 2-year-old well-validated codebase.

**Use WiLoR when:** you want real-time / lower latency, or a web UI for interactive testing.

The two setups are complementary — `tools/wilor/` and `tools/hamer/` can coexist.

## Prerequisites

- **NVIDIA GPU** (tested on RTX 4090; ≥10 GB VRAM recommended for `--batch_size=48`)
- **NVIDIA Container Toolkit** on the host:
  ```bash
  distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
  curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  ```
- **MANO_RIGHT.pkl** — required by the model, license-restricted, not included in the image:
  1. Register at https://mano.is.tue.mpg.de/ (free, instant approval)
  2. Download `mano_v1_2.zip`
  3. Extract `MANO_RIGHT.pkl` from `mano_v1_2/models/MANO_RIGHT.pkl`
  4. Copy it to `tools/hamer/mano_data/MANO_RIGHT.pkl`
- **~12 GB free disk** for the built image (6 GB demo data + 5 GB CUDA + deps)
- **~30 min for the first build** (the demo data is 6 GB and downloads at the speed of cs.utexas.edu)

## Quick start

```bash
cd tools/hamer

# 1. Place MANO_RIGHT.pkl
mkdir -p mano_data input output
cp /path/to/MANO_RIGHT.pkl mano_data/

# 2. Add your input images
cp /path/to/your/photos/*.jpg input/

# 3. Build the image (one-time, ~15 min, ~10 GB image size)
docker compose build

# 4. Run the demo (default CMD)
docker compose run --rm hamer

# 5. Find results in ./output/
ls output/  # *.obj meshes, *.png renders, *_overlay.png overlays
```

## Output files

For each input image, HaMeR produces (in `./output/`):

| File | Description |
|------|-------------|
| `<name>_overlay.png` | Original image with mesh overlaid + 2D keypoints |
| `<name>_side.png` | Side view of the reconstructed mesh (with `--side_view`) |
| `<name>_<hand_idx>.obj` | 3D mesh per detected hand (with `--save_mesh`), Blender-friendly |

## Run a custom command

```bash
# Process a folder, batch size 16, save meshes only
docker compose run --rm hamer \
  python demo.py \
  --img_folder example_data \
  --out_folder demo_out \
  --batch_size=16 \
  --save_mesh

# Single image, full frame view
docker compose run --rm hamer \
  python demo.py \
  --img_folder example_data \
  --out_folder demo_out \
  --batch_size=1 \
  --full_frame --side_view --save_mesh
```

## Interactive shell

```bash
docker compose run --rm --entrypoint /bin/bash hamer
# now you're inside /app/hamer with everything pre-installed
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

## Performance on RTX 4090

| Mode | Throughput | VRAM peak |
|------|-----------|-----------|
| `--batch_size=48 --side_view --save_mesh --full_frame` (default) | ~6-9 FPS | ~14 GB |
| `--batch_size=16 --save_mesh` | ~10-14 FPS | ~6 GB |
| `--batch_size=1` (single image) | ~3-5 FPS | ~3 GB |

(Numbers vary with image resolution, number of hands per image, and disk I/O.)

If your GPU has less than 16 GB, reduce `--batch_size`. The default 48 is comfortable on the RTX 4090's 24 GB.

## Files

```
tools/hamer/
├── Dockerfile          # CUDA 12.4 + Python 3.10 + HaMeR + 6GB pre-baked data
├── docker-compose.yml  # NVIDIA runtime + volume mounts
├── README.md           # this file
├── .gitignore          # excludes user data dirs
├── mano_data/          # ← put MANO_RIGHT.pkl here (gitignored)
├── input/              # ← drop images here (gitignored)
└── output/             # ← HaMeR writes results here (gitignored)
```

## Troubleshooting

**Build fails at the wget step** — the demo data tarball is 6 GB and the upstream is `cs.utexas.edu`. If your network is slow, the build can take a long time. To resume from cache, just re-run `docker compose build`.

**`MANO_RIGHT.pkl not found`** — verify the host file exists at `./mano_data/MANO_RIGHT.pkl`, then check inside the container: `docker compose run --rm --entrypoint ls hamer /app/hamer/_DATA/data/mano/`.

**`could not select device driver "nvidia"`** — install nvidia-container-toolkit (see prerequisites).

**`CUDA out of memory`** — drop `--batch_size`. Default is 48; try 16 or 8.

**`pyrender / EGL initialization failed`** — ensure your host driver is ≥ 525 and the compose file's `NVIDIA_DRIVER_CAPABILITIES` includes `graphics`. Already set by default.

**`No module named 'detectron2'`** — re-build the image. Detectron2 is installed via `pip install -e .[all]` and sometimes fails silently if pip cache is corrupted. Force a clean rebuild: `docker compose build --no-cache`.

## How this differs from the official HaMeR Docker

The official `docker/hamer-dev.Dockerfile` in the upstream repo is a development image — it leaves you to run `bash fetch_demo_data.sh` and the MANO setup yourself, after entering the container. This setup:

1. **Pre-bakes the 6 GB demo data tarball at build time** so the first run is instant
2. **Pre-installs ViTPose** (the upstream sometimes leaves you to do this manually)
3. **Uses CUDA 12.4 + cu124 PyTorch wheels** for native RTX 4090 support (upstream uses cu118)
4. **Includes a sane default CMD** that runs the canonical demo
5. **Mounts input/output as separate volumes** so you can drop files in `./input/` and read results from `./output/` without entering the container

## Sources

- HaMeR repo: https://github.com/geopavlakos/hamer
- Paper: https://arxiv.org/abs/2312.05251
- Project page: https://geopavlakos.github.io/hamer/
- Demo data tarball: https://www.cs.utexas.edu/~pavlakos/hamer/data/hamer_demo_data.tar.gz (6 GB)
- MANO model: https://mano.is.tue.mpg.de/
