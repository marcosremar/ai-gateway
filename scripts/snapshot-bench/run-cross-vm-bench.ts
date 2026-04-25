#!/usr/bin/env bun
/**
 * run-cross-vm-bench.ts — end-to-end cross-VM CRIU/cuda-checkpoint benchmark.
 *
 * Simulates the standby-pool scenario for a multi-GB model:
 *
 *   VM_A: deploy → load model → capture → terminate
 *   VM_B: deploy → download + restore → inference → terminate
 *
 * Times every phase, then computes the cold-vs-restore speedup and writes
 * both a JSON file and a one-line history record. The in-flight work that
 * wires `useCudaCheckpoint` into `server/gpu-snapshot.ts` is assumed to
 * land; this script drives it from the outside via the gateway HTTP API and
 * SSH — it does not touch that file.
 *
 * Usage
 * ──────────────────────────────────────────────────────────────────────────
 *   bun scripts/snapshot-bench/run-cross-vm-bench.ts \
 *     [--model microsoft/Phi-3.5-mini-instruct] \
 *     [--url http://localhost:4100] \
 *     [--keep]           skip VM_B terminate (useful for debugging)
 *     [--no-capture]     skip the capture phase and restore a pre-existing key
 *     [--snapshot-key <bucket-key>]   required with --no-capture
 *
 * See ./README.md for prereqs (env vars, keypair, gateway running) and cost.
 */

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  type BenchResult,
  type BenchTimings,
  type BenchErrorEntry,
  preflightEnv,
  finalizeResult,
  formatMarkdownTable,
  buildHistoryLine,
  buildSnapshotKey,
  compareOutputs,
  assertSafeShellToken,
} from './core';
import { BOOTSTRAP_SCRIPT, BOOTSTRAP_SANITY_CHECK, buildSllmStoreLoadCmd } from './bootstrap';

// When HYPERSTACK_BENCH_IMAGE_ID is set the VM was deployed from a pre-baked
// image that already has criu + cuda-checkpoint + /home/ubuntu/bench-venv installed,
// so we can skip the ~140s install and just sanity-check the tools are present.
const HAS_BENCH_IMAGE = Boolean(
  process.env.HYPERSTACK_BENCH_IMAGE_ID || process.env.HYPERSTACK_BENCH_IMAGE_NAME,
);
const INSTALL_SCRIPT = HAS_BENCH_IMAGE ? BOOTSTRAP_SANITY_CHECK : BOOTSTRAP_SCRIPT;

// ── Config ──────────────────────────────────────────────────────────────────

const ARGS = parseArgs(process.argv.slice(2));
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const GATEWAY_URL: string = str(ARGS.url) ?? process.env.GATEWAY_URL ?? 'http://localhost:4100';
const MODEL: string = str(ARGS.model) ?? 'microsoft/Phi-3.5-mini-instruct';
const SKIP_CLEANUP: boolean = ARGS.keep === true;
const SKIP_CAPTURE: boolean = ARGS['no-capture'] === true;
const EXISTING_SNAPSHOT_KEY: string | undefined = str(ARGS['snapshot-key']);

const REGION = 'CANADA-1';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA L40S';
const PROVIDER = 'hyperstack' as const;
const DOCKER_IMAGE = process.env.BENCH_IMAGE ?? 'marcosremar/babelcast-subtitle:latest';

const SSH_TIMEOUT_SHORT_MS = 60_000;        // tool checks, small commands
const SSH_TIMEOUT_MEDIUM_MS = 5 * 60_000;   // tool install, dump
const SSH_TIMEOUT_LONG_MS = 45 * 60_000;    // model load, compress/upload

const BENCH_RESULTS_DIR = join(process.cwd(), 'bench-results');
const HISTORY_PATH = join(BENCH_RESULTS_DIR, 'snapshot-cross-vm-history.jsonl');

// The fixed prompt whose first-100-token output we fingerprint. Keeping this
// in one place makes it easy to tweak later without touching the pipeline.
const CANONICAL_PROMPT =
  'Summarise the following sentence in exactly five words: The quick brown fox jumps over the lazy dog.';

// ── Entry point ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const runId = randomBytes(4).toString('hex');
  const startedAtIso = new Date().toISOString();
  const timestampMs = Date.now();

  const result: BenchResult = {
    schema_version: 1,
    run_id: runId,
    started_at_iso: startedAtIso,
    gateway_url: GATEWAY_URL,
    region: REGION,
    gpu: GPU,
    provider: PROVIDER,
    model: { hf_id: MODEL },
    timings: {},
    output_check: { output_match: 'skipped' },
    errors: [],
  };

  // ── 1. preflight ─────────────────────────────────────────────────────────
  const pf = preflightEnv(process.env, !SKIP_CAPTURE);
  if (!pf.ok) {
    console.error(`preflight failed — missing env: ${pf.missing.join(', ')}`);
    return 2;
  }
  if (SKIP_CAPTURE && !EXISTING_SNAPSHOT_KEY) {
    console.error('--no-capture requires --snapshot-key <bucket-key>');
    return 2;
  }

  let snapshotKey = EXISTING_SNAPSHOT_KEY ?? buildSnapshotKey(MODEL, timestampMs);
  result.snapshot_key = snapshotKey;
  result.bucket = process.env.HYPERSTACK_SNAPSHOTS_BUCKET;

  let canonicalOutput: string | undefined;
  let vmAHost: SshTarget | undefined;

  // ── 2. capture phase ─────────────────────────────────────────────────────
  if (!SKIP_CAPTURE) {
    try {
      log(`[capture] deploy VM_A (${GPU} ${REGION})`);
      const vmA = await deployVm('VM_A');
      result.timings.vm_a_boot_ms = vmA.deployDurationMs;
      vmAHost = vmA.ssh;

      await timed(
        'vm_a_tools_install_ms',
        result.timings,
        result.errors,
        async () => runSsh(vmA.ssh, INSTALL_SCRIPT, SSH_TIMEOUT_LONG_MS),
      );

      await timed('cold_load_ms', result.timings, result.errors, async () => {
        await runSsh(vmA.ssh, buildLoadModelCmd(MODEL), SSH_TIMEOUT_LONG_MS);
      });

      // Canonical output + VRAM read — capture even if cold_load_ms errored,
      // since partial state is still useful in the JSON.
      try {
        canonicalOutput = (await runSsh(
          vmA.ssh,
          buildInferCmd(MODEL, CANONICAL_PROMPT),
          SSH_TIMEOUT_MEDIUM_MS,
        )).trim();
        result.output_check.canonical_output = canonicalOutput;
      } catch (e) {
        result.errors.push({ phase: 'capture.infer', message: errMsg(e) });
      }
      try {
        const vram = (await runSsh(vmA.ssh, READ_VRAM_CMD, SSH_TIMEOUT_SHORT_MS)).trim();
        const mib = Number(vram);
        if (Number.isFinite(mib)) result.model.vram_mib = mib;
      } catch (e) {
        result.errors.push({ phase: 'capture.vram', message: errMsg(e) });
      }

      const drainOk = await timed('toggle_drain_ms', result.timings, result.errors, async () => {
        await runSsh(vmA.ssh, TOGGLE_DRAIN_CMD, SSH_TIMEOUT_SHORT_MS);
      });
      if (!drainOk) throw new Error('toggle-drain failed — aborting capture (downstream steps require drained VRAM)');

      const dumpOk = await timed('dump_ms', result.timings, result.errors, async () => {
        await runSsh(vmA.ssh, CRIU_DUMP_CMD, SSH_TIMEOUT_MEDIUM_MS);
      });
      if (!dumpOk) throw new Error('criu dump failed — aborting capture (no valid snapshot to compress/upload)');

      const compressOk = await timed('compress_ms', result.timings, result.errors, async () => {
        await runSsh(vmA.ssh, COMPRESS_CMD, SSH_TIMEOUT_MEDIUM_MS);
      });
      if (!compressOk) throw new Error('compress failed — aborting capture');

      try {
        const sz = (await runSsh(vmA.ssh, 'stat -c %s /tmp/snap.tar.zst', SSH_TIMEOUT_SHORT_MS)).trim();
        result.timings.compressed_size_bytes = Number(sz);
      } catch (e) {
        result.errors.push({ phase: 'capture.stat', message: errMsg(e) });
      }

      await timed('upload_ms', result.timings, result.errors, async () => {
        await runSsh(vmA.ssh, buildUploadCmd(snapshotKey), SSH_TIMEOUT_LONG_MS);
      });
    } catch (e) {
      result.errors.push({ phase: 'capture', message: errMsg(e), fatal: true });
    } finally {
      if (vmAHost) {
        try {
          const t = performance.now();
          await terminateVm('VM_A');
          result.timings.vm_a_terminate_ms = performance.now() - t;
        } catch (e) {
          result.errors.push({ phase: 'capture.terminate', message: errMsg(e) });
        }
      }
    }
  }

  // ── 3. restore phase ─────────────────────────────────────────────────────
  // Skip when capture produced no valid snapshot — spinning up VM_B just to
  // fail the download + restore wastes money and obscures the real error.
  const captureFatalErr = result.errors.find(
    (e) => e.fatal && (e.phase === 'capture' || e.phase?.startsWith('capture.')),
  );
  const skipRestore = !SKIP_CAPTURE && !!captureFatalErr;
  if (skipRestore) {
    log(`[restore] skipped — capture failed: ${captureFatalErr!.message.split('\n')[0]}`);
    result.errors.push({ phase: 'restore.skipped', message: 'capture produced no valid snapshot' });
  }

  let vmBHost: SshTarget | undefined;
  if (!skipRestore) try {
    log(`[restore] deploy VM_B (${GPU} ${REGION})`);
    const vmB = await deployVm('VM_B');
    result.timings.vm_b_boot_ms = vmB.deployDurationMs;
    vmBHost = vmB.ssh;

    await timed(
      'vm_b_tools_install_ms',
      result.timings,
      result.errors,
      async () => runSsh(vmB.ssh, INSTALL_SCRIPT, SSH_TIMEOUT_LONG_MS),
    );

    await timed('download_ms', result.timings, result.errors, async () => {
      await runSsh(vmB.ssh, buildDownloadCmd(snapshotKey), SSH_TIMEOUT_LONG_MS);
    });
    try {
      const sz = (await runSsh(vmB.ssh, 'stat -c %s /tmp/snap.tar.zst', SSH_TIMEOUT_SHORT_MS)).trim();
      result.timings.downloaded_size_bytes = Number(sz);
    } catch (e) {
      result.errors.push({ phase: 'restore.stat', message: errMsg(e) });
    }

    await timed('decompress_ms', result.timings, result.errors, async () => {
      await runSsh(vmB.ssh, DECOMPRESS_CMD, SSH_TIMEOUT_MEDIUM_MS);
    });

    await timed('restore_ms', result.timings, result.errors, async () => {
      await runSsh(vmB.ssh, CRIU_RESTORE_CMD, SSH_TIMEOUT_MEDIUM_MS);
    });

    await timed('toggle_restore_ms', result.timings, result.errors, async () => {
      await runSsh(vmB.ssh, TOGGLE_RESTORE_CMD, SSH_TIMEOUT_SHORT_MS);
    });

    // Same prompt → compare.
    try {
      const restored = (await runSsh(
        vmB.ssh,
        buildInferCmd(MODEL, CANONICAL_PROMPT),
        SSH_TIMEOUT_MEDIUM_MS,
      )).trim();
      if (canonicalOutput !== undefined) {
        result.output_check = compareOutputs(canonicalOutput, restored);
      } else {
        result.output_check = { output_match: 'skipped', restored_output: restored };
      }
    } catch (e) {
      result.errors.push({ phase: 'restore.infer', message: errMsg(e) });
      result.output_check = { output_match: 'skipped' };
    }
  } catch (e) {
    result.errors.push({ phase: 'restore', message: errMsg(e), fatal: true });
  } finally {
    // ── 4. cleanup ──────────────────────────────────────────────────────────
    if (vmBHost && !SKIP_CLEANUP) {
      try {
        const t = performance.now();
        await terminateVm('VM_B');
        result.timings.vm_b_terminate_ms = performance.now() - t;
        await confirmNoActivePods();
      } catch (e) {
        result.errors.push({ phase: 'cleanup', message: errMsg(e) });
      }
    }
  }

  // ── 5. output ────────────────────────────────────────────────────────────
  finalizeResult(result);
  await mkdir(BENCH_RESULTS_DIR, { recursive: true });
  const stem = `snapshot-cross-vm-${slugify(MODEL)}-${startedAtIso.replace(/[:.]/g, '-')}`;
  const jsonPath = join(BENCH_RESULTS_DIR, `${stem}.json`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await appendFile(HISTORY_PATH, buildHistoryLine(result) + '\n');

  console.log('');
  console.log(formatMarkdownTable(result));
  console.log('');
  console.log(`wrote ${jsonPath}`);
  console.log(`appended ${HISTORY_PATH}`);

  // Non-zero exit if anything fatal failed, so CI / operators notice.
  return result.errors.some(e => e.fatal) ? 1 : 0;
}

// ── Gateway helpers ─────────────────────────────────────────────────────────

interface SshTarget { host: string; port: number }
interface DeployOutcome { deployDurationMs: number; ssh: SshTarget }

async function deployVm(label: string): Promise<DeployOutcome> {
  const started = performance.now();
  const res = await fetch(`${GATEWAY_URL}/v1/gpu/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: PROVIDER,
      dockerImage: DOCKER_IMAGE,
      gpuTypes: [GPU],
      region: REGION,
      readinessProbe: 'ssh',
      // When deploying from the pre-baked custom image, racing multiple
      // slots is pure cost with no benefit — each loser clones 6 GiB of
      // snapshot before we terminate it. One slot keeps the wallet sane.
      raceCount: HAS_BENCH_IMAGE ? 1 : 3,
    }),
  });
  if (!res.ok) throw new Error(`deploy ${label}: HTTP ${res.status} ${await res.text()}`);

  // Poll /v1/gpu/status until ready / error / timeout. Custom-image clone of
  // ~6 GiB + VM boot can push 10-12 min on some CANADA-1 hosts.
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const s = await fetch(`${GATEWAY_URL}/v1/gpu/status`).then(r => r.json()) as Record<string, unknown>;
    const status = String(s.status ?? '');
    if (status === 'ready' || status === 'running') {
      const host = String(s.sshHost ?? '');
      const port = Number(s.sshPort ?? 22);
      if (!host) throw new Error(`deploy ${label}: ready but no sshHost in status`);
      assertSafeShellToken(host, 'sshHost');
      return { deployDurationMs: performance.now() - started, ssh: { host, port } };
    }
    if (status === 'error') throw new Error(`deploy ${label}: error — ${JSON.stringify(s.message ?? '')}`);
  }
  throw new Error(`deploy ${label}: timed out after 25 min`);
}

async function terminateVm(label: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/v1/gpu/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`terminate ${label}: HTTP ${res.status} ${await res.text()}`);
}

async function confirmNoActivePods(): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/v1/gpu/list`);
  if (!res.ok) return; // informational only
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  const count = Number(body.count ?? (Array.isArray(body.instances) ? body.instances.length : 0));
  if (count !== 0) log(`[cleanup] WARNING: count=${count} (expected 0)`);
}

// ── SSH helpers ────────────────────────────────────────────────────────────

/**
 * Run a shell command on the target VM. The command string is treated as a
 * single literal argv element; we never interpolate untrusted data into a
 * shell. Returns stdout (trimmed caller-side).
 */
function runSsh(target: SshTarget, script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    assertSafeShellToken(target.host, 'sshHost');
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', `ConnectTimeout=30`,
      '-p', String(target.port),
      `ubuntu@${target.host}`,
      'bash', '-s',
    ];
    try {
      const out = execFileSync('ssh', args, {
        input: script,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      resolve(out);
    } catch (e: unknown) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ── Scripts for the remote VM ──────────────────────────────────────────────
// BOOTSTRAP_SCRIPT + BOOTSTRAP_SANITY_CHECK live in ./bootstrap.ts so the
// `gpu hyperstack build-bench-image` CLI command bakes the exact same tools
// into the reusable custom image. Do not inline them here — diverging shell
// fragments is the class of bug the shared module prevents.

const TOGGLE_DRAIN_CMD = `
set -euo pipefail
PID="$(cat /tmp/bench.pid)"
cuda-checkpoint --toggle --pid "$PID"
`;

const CRIU_DUMP_CMD = `
set -euo pipefail
PID="$(cat /tmp/bench.pid)"
# --ghost-limit 256M allows dumping deleted-but-mapped shared libs (e.g.
# libcrypto.so.3 after apt upgrade inside the VM); default ~1M is too tight.
# --tcp-close marks any live TCP connections as closed in the image, so
# cross-VM restore does not try to rebind VM_A's IP inside VM_B.
sudo criu dump -t "$PID" -D /tmp/ckpt --shell-job --tcp-close --leave-running --ghost-limit 256M
`;

const COMPRESS_CMD = `
set -euo pipefail
tar -I 'zstd -T0 -3' -cf /tmp/snap.tar.zst -C /tmp ckpt
`;

const DECOMPRESS_CMD = `
set -euo pipefail
rm -rf /tmp/ckpt
mkdir -p /tmp/ckpt
tar -I 'zstd -T0 -d' -xf /tmp/snap.tar.zst -C /tmp
`;

const CRIU_RESTORE_CMD = `
set -euo pipefail
sudo criu restore -D /tmp/ckpt --shell-job --tcp-close --restore-detached --ghost-limit 256M
sleep 1
pgrep -f bench_load.py | head -n1 > /tmp/bench.pid
`;

const TOGGLE_RESTORE_CMD = `
set -euo pipefail
PID="$(cat /tmp/bench.pid)"
cuda-checkpoint --toggle --pid "$PID"
`;

const READ_VRAM_CMD = `
set -euo pipefail
nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -n1
`;

function buildLoadModelCmd(model: string): string {
  assertSafeShellToken(model, 'model');
  const loader = process.env.BENCH_LOADER ?? 'transformers';
  if (loader !== 'transformers' && loader !== 'sllm') {
    throw new Error(`BENCH_LOADER must be 'transformers' or 'sllm', got ${loader}`);
  }
  if (loader === 'sllm') {
    // The sllm loader's Python body (with its own offload/onload loop)
    // comes from bootstrap.ts so both call sites stay in sync. We just
    // embed it under the same heredoc contract as the transformers path.
    const pySrc = buildSllmStoreLoadCmd(model);
    return `
set -euo pipefail
cat > /tmp/bench_load.py <<'PY'
${pySrc}
PY
BENCH_MODEL="${model}" nohup /home/ubuntu/bench-venv/bin/python /tmp/bench_load.py \
  </dev/null >/tmp/bench.out 2>&1 &
echo $! > /tmp/bench.pid
disown || true
for i in $(seq 1 2400); do [ -f /tmp/bench.ready ] && exit 0; sleep 1; done
echo "model did not become ready within 40 min" >&2
tail -n 40 /tmp/bench.out >&2 || true
exit 1
`;
  }
  return `
set -euo pipefail
cat > /tmp/bench_load.py <<'PY'
import os, sys, signal, time, gc
MODEL = os.environ["BENCH_MODEL"]
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inp = tok("warmup", return_tensors="pt").to(model.device)
with torch.no_grad(): _ = model(**inp)

# Close lingering HTTP sessions before signalling readiness. CRIU's cross-VM
# restore fails on established TCP sockets (they hold VM_A's IP and won't
# rebind on VM_B), so quiesce everything the HF/transformers stack left open.
try:
    import huggingface_hub.utils._http as hf_http
    s = getattr(hf_http, "_session", None)
    if s is not None: s.close()
except Exception:
    pass
try:
    import requests.sessions as rs
    for s in list(getattr(rs, "_sessions", []) or []):
        try: s.close()
        except Exception: pass
except Exception:
    pass
gc.collect()

open("/tmp/bench.ready","w").write("1")

# Redirect stdout/stderr to /dev/null — their original paths (/tmp/bench.out)
# don't exist on VM_B. Do NOT close fds 3+: CUDA contexts keep internal fds
# open (to /dev/nvidia*, shared memory), and closing them kills cuda-checkpoint
# with "initialization error". Instead we scrub non-CUDA log files only.
_devnull = os.open("/dev/null", os.O_WRONLY)
os.dup2(_devnull, 1); os.dup2(_devnull, 2); os.close(_devnull)

# HF Hub xet opens a timestamped log file per-process under
# ~/.cache/huggingface/xet/logs/xet_<ts>_<pid>.log. That path is unique to
# VM_A and doesn't exist on VM_B, so CRIU's restore will fail trying to
# re-open the fd. Walk /proc/self/fd and close anything that points under
# .cache/huggingface (CUDA fds point at /dev/nvidia* or anon_inode, safe).
try:
    for _fd in os.listdir("/proc/self/fd"):
        try: target = os.readlink(f"/proc/self/fd/{_fd}")
        except OSError: continue
        if "/.cache/huggingface/" in target or "xet_" in target:
            try: os.close(int(_fd))
            except OSError: pass
except FileNotFoundError:
    pass

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

# ── Offload / onload control loop ──────────────────────────────────────────
# Watches /tmp/bench.offload and /tmp/bench.onload every 250ms.
#   - /tmp/bench.offload present → move model CUDA→CPU, write /tmp/bench.offloaded,
#     delete the trigger file. Subsequent offloads are idempotent (noop if
#     already on CPU).
#   - /tmp/bench.onload present  → move model back to CUDA, write /tmp/bench.ready,
#     delete the trigger file.
# Each transition's wall-time (ms) is appended to /tmp/bench.transitions.log
# as one line: "<iso>\\t<op>\\t<duration_ms>". Legacy readiness semantics
# (initial /tmp/bench.ready after load) are preserved above.
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
                    model.to("cpu")
                    torch.cuda.empty_cache()
                    _on_cpu = True
                except Exception:
                    pass
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
                    model.to("cuda")
                    _on_cpu = False
                except Exception:
                    pass
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
PY
# Detach stdio so the outer SSH command returns as soon as readiness is
# observed — otherwise ssh blocks on python's stdout/stderr FDs and the
# whole phase stalls to SSH_TIMEOUT_LONG_MS even after the model is ready.
BENCH_MODEL="${model}" nohup /home/ubuntu/bench-venv/bin/python /tmp/bench_load.py \
  </dev/null >/tmp/bench.out 2>&1 &
echo $! > /tmp/bench.pid
disown || true
# Allow up to 40 min for HF download + model-to-GPU + warmup forward pass.
for i in $(seq 1 2400); do [ -f /tmp/bench.ready ] && exit 0; sleep 1; done
echo "model did not become ready within 40 min" >&2
tail -n 40 /tmp/bench.out >&2 || true
exit 1
`;
}

function buildInferCmd(model: string, prompt: string): string {
  assertSafeShellToken(model, 'model');
  // prompt is base64-encoded so it can safely contain any characters without
  // needing shell-quoting inside the heredoc.
  const b64 = Buffer.from(prompt, 'utf8').toString('base64');
  return `
set -euo pipefail
cat > /tmp/bench_infer.py <<'PY'
import os, base64
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch
MODEL = os.environ["BENCH_MODEL"]
PROMPT = base64.b64decode(os.environ["BENCH_PROMPT_B64"]).decode("utf-8")
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16, device_map="auto")
inputs = tok(PROMPT, return_tensors="pt").to(model.device)
with torch.no_grad():
    out = model.generate(**inputs, max_new_tokens=100, do_sample=False, temperature=0.0)
text = tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
print(text, end="")
PY
BENCH_MODEL="${model}" BENCH_PROMPT_B64="${b64}" /home/ubuntu/bench-venv/bin/python /tmp/bench_infer.py
`;
}

/**
 * Bash-safe single-quote wrap: close, escape, re-open around any embedded
 * `'`. AWS secret keys may contain `+`, `/`, `=` (base64) and in rare cases
 * punctuation, so naive single-quoting could break or, worse, terminate the
 * literal early. Never rely on the shape of credentials.
 */
function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function buildUploadCmd(key: string): string {
  assertSafeShellToken(key, 'snapshotKey');
  const bucket = requireEnv('HYPERSTACK_SNAPSHOTS_BUCKET');
  const endpoint = requireEnv('HYPERSTACK_SNAPSHOTS_ENDPOINT');
  const ak = requireEnv('HYPERSTACK_SNAPSHOTS_ACCESS_KEY');
  const sk = requireEnv('HYPERSTACK_SNAPSHOTS_SECRET_KEY');
  const region = process.env.HYPERSTACK_SNAPSHOTS_REGION ?? 'CANADA-1';
  assertSafeShellToken(bucket, 'bucket');
  assertSafeShellToken(endpoint, 'endpoint');
  assertSafeShellToken(region, 'region');
  return `
set -euo pipefail
export AWS_ACCESS_KEY_ID=${shq(ak)}
export AWS_SECRET_ACCESS_KEY=${shq(sk)}
export AWS_DEFAULT_REGION=${shq(region)}
aws --endpoint-url ${shq(endpoint)} s3 cp /tmp/snap.tar.zst ${shq(`s3://${bucket}/${key}`)}
`;
}

function buildDownloadCmd(key: string): string {
  assertSafeShellToken(key, 'snapshotKey');
  const bucket = requireEnv('HYPERSTACK_SNAPSHOTS_BUCKET');
  const endpoint = requireEnv('HYPERSTACK_SNAPSHOTS_ENDPOINT');
  const ak = requireEnv('HYPERSTACK_SNAPSHOTS_ACCESS_KEY');
  const sk = requireEnv('HYPERSTACK_SNAPSHOTS_SECRET_KEY');
  const region = process.env.HYPERSTACK_SNAPSHOTS_REGION ?? 'CANADA-1';
  assertSafeShellToken(bucket, 'bucket');
  assertSafeShellToken(endpoint, 'endpoint');
  assertSafeShellToken(region, 'region');
  return `
set -euo pipefail
export AWS_ACCESS_KEY_ID=${shq(ak)}
export AWS_SECRET_ACCESS_KEY=${shq(sk)}
export AWS_DEFAULT_REGION=${shq(region)}
aws --endpoint-url ${shq(endpoint)} s3 cp ${shq(`s3://${bucket}/${key}`)} /tmp/snap.tar.zst
`;
}

// ── Misc helpers ───────────────────────────────────────────────────────────

async function timed(
  field: keyof BenchTimings,
  bag: BenchTimings,
  errors: BenchErrorEntry[],
  fn: () => Promise<unknown>,
): Promise<boolean> {
  const start = performance.now();
  try {
    await fn();
    (bag as Record<string, number>)[field] = performance.now() - start;
    return true;
  } catch (e) {
    (bag as Record<string, number>)[field] = performance.now() - start;
    errors.push({ phase: String(field), message: errMsg(e) });
    return false;
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ── Run ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}
