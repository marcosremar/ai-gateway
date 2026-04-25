/**
 * Shared VM bootstrap script for snapshot / custom-image workflows.
 *
 * Installs the minimum toolchain required for CRIU + cuda-checkpoint +
 * the transformers bench on a fresh Ubuntu 22.04 Hyperstack VM (the stock
 * "Ubuntu Server 22.04 LTS R570 CUDA 12.8 with Docker" image).
 *
 * Used by:
 *   - scripts/snapshot-bench/run-cross-vm-bench.ts (per-VM, every run)
 *   - bin/ai-gateway.ts `gpu hyperstack build-bench-image` (once, baked into
 *     a custom image so future deploys skip the 140s install).
 *
 * Keep this string idempotent: every step must be safe to re-run. If your
 * new image needs extra prerequisites, add them here so both call sites stay
 * in sync. Ad-hoc divergence between bench runs and baked images is the
 * exact bug this shared module prevents.
 */

export const BOOTSTRAP_SCRIPT = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# CRIU restore on Ubuntu 22.04 needs YAMA ptrace_scope relaxed.
sudo sysctl -w kernel.yama.ptrace_scope=0 >/dev/null

# Build toolchain + CRIU deps.
if ! command -v criu >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y build-essential git zstd jq awscli \\
    libprotobuf-dev libprotobuf-c-dev protobuf-c-compiler protobuf-compiler \\
    python3-protobuf python3-pip python3-venv pkg-config libnl-3-dev libcap-dev \\
    libnet-dev libaio-dev libgnutls28-dev libbsd-dev uuid-dev iproute2
  git clone --depth=1 https://github.com/checkpoint-restore/criu.git /tmp/criu
  make -C /tmp/criu -j"$(nproc)"
  sudo make -C /tmp/criu install-criu
fi

# NVIDIA cuda-checkpoint prebuilt — pulled from the GitHub repo's bin/
# directory (no releases are published; the README points at this raw path).
if [ ! -x /usr/local/bin/cuda-checkpoint ]; then
  curl -fL -o /tmp/cuda-checkpoint \\
    "https://raw.githubusercontent.com/NVIDIA/cuda-checkpoint/main/bin/x86_64_Linux/cuda-checkpoint"
  chmod +x /tmp/cuda-checkpoint
  sudo mv /tmp/cuda-checkpoint /usr/local/bin/cuda-checkpoint
fi

# Python venv with torch (cu126) + transformers.
if [ ! -d /home/ubuntu/bench-venv ]; then
  python3 -m venv /home/ubuntu/bench-venv
  /home/ubuntu/bench-venv/bin/pip install --upgrade pip wheel
  /home/ubuntu/bench-venv/bin/pip install --index-url https://download.pytorch.org/whl/cu126 torch
  /home/ubuntu/bench-venv/bin/pip install transformers accelerate safetensors "huggingface-hub>=1.0.0" hf_xet
fi

# ServerlessLLM sllm-store — optimized tensor layout + fast CPU→GPU
# shovel loader. PyPI package name is \`serverless-llm-store\`; confirmed by the
# ServerlessLLM repo docs at https://github.com/ServerlessLLM/ServerlessLLM.
# Wrapped in \`|| true\` so a transient PyPI failure doesn't brick the whole
# bootstrap — the transformers path still works without it. BENCH_LOADER=sllm
# callers will blow up at load time with a clear ImportError if the install
# actually failed, which is the correct signal.
/home/ubuntu/bench-venv/bin/pip install "serverless-llm-store" || true

# Persistent store for sllm-converted weights. Kept on /home/ubuntu so it
# survives a custom-image bake — /tmp is tmpfs and wipes on boot.
mkdir -p /home/ubuntu/sllm-store
export SLLM_STORE_DIR=/home/ubuntu/sllm-store
grep -q '^export SLLM_STORE_DIR=' /home/ubuntu/.bashrc 2>/dev/null || \\
  echo 'export SLLM_STORE_DIR=/home/ubuntu/sllm-store' >> /home/ubuntu/.bashrc

mkdir -p /tmp/ckpt
echo "bootstrap ok"
`;

/**
 * Fast-path sanity check used when HYPERSTACK_BENCH_IMAGE_ID is set — the VM
 * was deployed from a pre-baked image so the full bootstrap is unnecessary.
 * Just confirm the tools are present; if any are missing, the image is stale
 * and the caller should fall back to BOOTSTRAP_SCRIPT.
 */
export const BOOTSTRAP_SANITY_CHECK = `
set -euo pipefail
command -v criu >/dev/null
command -v cuda-checkpoint >/dev/null
test -d /home/ubuntu/bench-venv
# Soft check — missing sllm-store is a warning, not a failure. The
# transformers loader (BENCH_LOADER=transformers, default) does not need it,
# and a stale custom image without sllm-store should still work for the
# cross-VM bench. Callers who set BENCH_LOADER=sllm will see a clear
# ImportError at load time which is the right signal.
test -x /home/ubuntu/bench-venv/bin/sllm-store || true
# CRIU restore on Ubuntu 22.04 needs YAMA ptrace_scope relaxed — this sysctl
# reverts on every boot so we re-apply here even on the sanity path.
sudo sysctl -w kernel.yama.ptrace_scope=0 >/dev/null
# /tmp is tmpfs → wiped on boot. Re-create the dirs the bench uses.
mkdir -p /tmp/ckpt
mkdir -p /home/ubuntu/sllm-store
echo "bootstrap ok (from custom image)"
`;

/**
 * Build the Python source for a ServerlessLLM-backed load. Mirrors the
 * transformers loader's readiness semantics (/tmp/bench.ready + offload loop)
 * so the outer bench script can switch loaders via BENCH_LOADER without
 * needing separate wait-for-ready code paths.
 *
 * Uses the \`sllm_store.transformers\` shortcut (\`load_model\` / \`save_model\`)
 * which loads the model in ServerlessLLM's optimized format directly onto the
 * GPU via shovel+mmap, bypassing HF's pickle → CPU → GPU copy chain. Expects
 * the converted weights to already exist under SLLM_STORE_DIR/<slug> (the
 * preload step in the custom-image build does the one-time conversion).
 *
 * Returned string is the *Python source only* — callers wrap it in a heredoc
 * the same way buildLoadModelCmd does.
 */
export function buildSllmStoreLoadCmd(model: string): string {
  // Interpolating the model into a Python fallback is safe here: callers
  // assert the token is shell-safe via assertSafeShellToken before building
  // the surrounding heredoc. The default pulls from BENCH_MODEL so the same
  // source still works when the caller sets the env var directly.
  const safeModel = model.replace(/"/g, '\\"');
  return `import os, sys, signal, time, gc
MODEL = os.environ.get("BENCH_MODEL", "${safeModel}")
SLLM_DIR = os.environ.get("SLLM_STORE_DIR", "/home/ubuntu/sllm-store")
SLUG = MODEL.replace("/", "__")

import torch
from sllm_store.transformers import load_model
# load_model pulls the pre-converted tensors off disk into GPU memory using
# ServerlessLLM's sequential-read + mmap layout; it's ~2-4x faster than HF
# safetensors on warm-cache reads and 10x+ faster on cold NVMe reads.
model = load_model(SLUG, device_map="auto", torch_dtype=torch.float16,
                   storage_path=SLLM_DIR, fully_parallel=True)
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(MODEL)
inp = tok("warmup", return_tensors="pt").to(next(model.parameters()).device)
with torch.no_grad(): _ = model(**inp)
gc.collect()
open("/tmp/bench.ready","w").write("1")

_devnull = os.open("/dev/null", os.O_WRONLY)
os.dup2(_devnull, 1); os.dup2(_devnull, 2); os.close(_devnull)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

# Same offload/onload loop as the transformers path — identical file
# protocol (/tmp/bench.offload + /tmp/bench.onload) so the outer driver
# doesn't branch on BENCH_LOADER when probing state.
def _log_transition(op: str, dur_ms: float) -> None:
    try:
        with open("/tmp/bench.transitions.log", "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\\t{op}\\t{dur_ms:.1f}\\n")
    except Exception:
        pass

_on_cpu = False
while True:
    try:
        if os.path.exists("/tmp/bench.offload"):
            t0 = time.monotonic()
            if not _on_cpu:
                try:
                    model.to("cpu"); torch.cuda.empty_cache(); _on_cpu = True
                except Exception: pass
            try: os.remove("/tmp/bench.offload")
            except OSError: pass
            try: open("/tmp/bench.offloaded", "w").write("1")
            except OSError: pass
            try:
                if os.path.exists("/tmp/bench.ready"): os.remove("/tmp/bench.ready")
            except OSError: pass
            _log_transition("offload", (time.monotonic() - t0) * 1000.0)
        elif os.path.exists("/tmp/bench.onload"):
            t0 = time.monotonic()
            if _on_cpu:
                try:
                    model.to("cuda"); _on_cpu = False
                except Exception: pass
            try: os.remove("/tmp/bench.onload")
            except OSError: pass
            try:
                if os.path.exists("/tmp/bench.offloaded"): os.remove("/tmp/bench.offloaded")
            except OSError: pass
            try: open("/tmp/bench.ready", "w").write("1")
            except OSError: pass
            _log_transition("onload", (time.monotonic() - t0) * 1000.0)
    except Exception:
        pass
    time.sleep(0.25)
`;
}
