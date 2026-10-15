/**
 * Cloud-init builder for TensorDock VMs.
 *
 * IMPORTANT: TensorDock's v2 API `write_files` does NOT support `encoding`.
 * Content must be passed as plain text (not base64).
 *
 * Execution is triggered via /etc/rc.local (systemd rc-local-generator
 * auto-detects it) and cron @reboot as backup.
 */

import { randomBytes } from 'crypto';

// ── Constants ────────────────────────────────────────────────────────────────

/** SSH public key for TensorDock VM access — reads from TENSORDOCK_SSH_PUBKEY env var */
export function getDefaultSshPubKey(): string | undefined {
  return process.env.TENSORDOCK_SSH_PUBKEY || undefined;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface CloudInitSpec {
  hfRepoUrl?: string;
  hfToken?: string;
  dockerImage?: string;
  /** Raw SSH public key — injected directly into authorized_keys to bypass cloud-init SSH bug */
  sshPubKey?: string;
  /** Extra environment variables to inject into the container or app process */
  env?: Record<string, string>;
  /** Install deps directly on VM instead of Docker (faster boot, no Docker overhead) */
  bareMetal?: boolean;
}

/** Setup phases for Docker mode */
export type DockerSetupPhase =
  | 'initializing'
  | 'installing_toolkit'
  | 'pulling_image'
  | 'starting_container'
  | 'ready'
  | 'failed';

/** Setup phases for Git clone mode */
export type GitCloneSetupPhase =
  | 'initializing'
  | 'installing_deps'
  | 'cloning_repo'
  | 'downloading_models'
  | 'starting_app'
  | 'ready'
  | 'failed';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Base64-encode a string for cloud-init write_files (avoids escaping issues) */
export function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/** Build `-e KEY=VALUE` flags for docker run from an env record */
export function buildEnvFlags(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return '';
  return Object.entries(env)
    .map(([k, v]) => `-e ${k}="${v}"`)
    .join(' ');
}

/** Build `export KEY=VALUE` lines for shell scripts from an env record */
export function buildExportLines(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return '';
  return Object.entries(env)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('\n');
}

/**
 * Builds the Python health-monitor script that runs on :9090.
 * Phase-aware: reads setup state from /tmp/parle-setup-state.json and
 * probes the actual app on localhost:8000/health.
 *
 * /health returns: { phase, progress_pct, elapsed_secs, error, healthy, status }
 * / returns: debug logs + GPU info (for getInstanceLogs)
 */
export function buildMonitorScript(logFiles: Record<string, string>): string {
  const debugEntries = Object.entries(logFiles)
    .map(([label, path]) => `                    "${label}": tail("${path}"),`)
    .join('\n');

  return [
    '#!/usr/bin/env python3',
    'import http.server, subprocess, json, time, urllib.request, os',
    '',
    'START_TIME = time.time()',
    'STATE_FILE = "/tmp/parle-setup-state.json"',
    '',
    'def read_state():',
    '    try:',
    '        with open(STATE_FILE) as f:',
    '            return json.load(f)',
    '    except:',
    '        return {"phase": "initializing", "progress_pct": 0}',
    '',
    'def probe_app():',
    '    try:',
    '        req = urllib.request.urlopen("http://localhost:8000/health", timeout=3)',
    '        return req.status == 200',
    '    except:',
    '        return False',
    '',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def log_message(self, *a): pass',
    '    def do_GET(self):',
    '        try:',
    '            def tail(f, n=3000):',
    '                try:',
    '                    with open(f, errors="replace") as fp: return fp.read()[-n:]',
    '                except: return "(not found)"',
    '            def r(c):',
    '                try: return subprocess.run(c, capture_output=True, text=True, timeout=3).stdout.strip()',
    '                except: return ""',
    '            if self.path == "/health":',
    '                state = read_state()',
    '                phase = state.get("phase", "initializing")',
    '                error = state.get("error")',
    '                app_healthy = probe_app()',
    '                if app_healthy and phase != "failed":',
    '                    phase = "ready"',
    '                elapsed = round(time.time() - START_TIME, 1)',
    '                body = json.dumps({',
    '                    "phase": phase,',
    '                    "progress_pct": state.get("progress_pct", 0),',
    '                    "elapsed_secs": elapsed,',
    '                    "error": error,',
    '                    "healthy": app_healthy,',
    '                    "status": "ready" if app_healthy else phase,',
    '                }).encode()',
    '            else:',
    '                body = json.dumps({',
    debugEntries,
    '                    "gpu": r(["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"]),',
    '                    "state": read_state(),',
    '                }, ensure_ascii=True).encode()',
    '            self.send_response(200)',
    '            self.send_header("Content-Type", "application/json")',
    '            self.send_header("Access-Control-Allow-Origin", "*")',
    '            self.end_headers()',
    '            self.wfile.write(body)',
    '        except Exception as e:',
    '            try:',
    '                self.send_response(500)',
    '                self.end_headers()',
    '                self.wfile.write(str(e).encode())',
    '            except: pass',
    '',
    'print("Monitor on :9090", flush=True)',
    'http.server.HTTPServer(("", 9090), H).serve_forever()',
  ].join('\n');
}

// ── Cloud-init builder ──────────────────────────────────────────────────────

/**
 * Builds cloud-init config for a TensorDock VM.
 *
 * Scripts are placed in /opt/ via write_files and triggered via:
 * 1. systemd oneshot service (most reliable — survives stop/resume)
 * 2. runcmd (v2 API supports it — first boot only)
 * 3. /etc/rc.local (systemd auto-detects)
 * 4. cron @reboot (backup)
 */
export function buildCloudInit(spec: CloudInitSpec): Record<string, unknown> {
  const { hfRepoUrl = process.env.PARLE_SPEECH_TO_SPEECH_HF_REPO || 'marcosremar2/parle-speech-to-speech', hfToken, dockerImage, sshPubKey, env, bareMetal } = spec;

  // Use provided key or fall back to env var TENSORDOCK_SSH_PUBKEY
  const effectiveSshKey = sshPubKey || getDefaultSshPubKey();

  const config = dockerImage
    ? (bareMetal
        ? buildBareMetalCloudInit(dockerImage, hfToken, env)
        : buildDockerCloudInit(dockerImage, hfToken, env))
    : buildGitCloneCloudInit(hfRepoUrl, hfToken, env);

  // TensorDock base config sets `user: user` with `ssh_pwauth: True`.
  // Our cloud-init is APPENDED to it. DO NOT use `users` directive — it conflicts
  // and breaks the default user creation entirely.

  // Password fallback for SSH (TensorDock has ssh_pwauth: True by default)
  config.password = process.env.GPU_SSH_PASSWORD || `gpu-${randomBytes(8).toString('hex')}`;
  config.chpasswd = { expire: false };

  // runcmd triggers: enable systemd service + run launcher directly
  // runcmd only runs on FIRST boot; systemd service survives stop/resume
  config.runcmd = [
    'chmod +x /opt/start-all.sh /opt/setup.sh /opt/monitor.py /etc/rc.local 2>/dev/null || true',
    'systemctl daemon-reload',
    'systemctl enable parle-setup.service',
    'nohup /opt/start-all.sh > /var/log/parle-launcher-runcmd.log 2>&1 &',
  ];

  if (effectiveSshKey) {
    // SSH key injection — appended to TensorDock's base config for `user` account:
    // 1. ssh_authorized_keys: cloud-init injects for the default 'user' account
    // 2. write_files: backup injection for root
    // 3. cron @reboot fix-ssh.sh: safety net after all users/dirs exist
    config.ssh_authorized_keys = [effectiveSshKey];

    const files = config.write_files as Array<Record<string, string>>;
    // Write to ALL possible SSH key locations (Ubuntu 24.04 cloud-init bug #6175)
    files.push(
      { path: '/root/.ssh/authorized_keys', permissions: '0600', content: effectiveSshKey + '\n' },
      { path: '/home/user/.ssh/authorized_keys', permissions: '0600', content: effectiveSshKey + '\n' },
      { path: '/etc/ssh/authorized_keys/root', permissions: '0644', content: effectiveSshKey + '\n' },
      { path: '/etc/ssh/authorized_keys/user', permissions: '0644', content: effectiveSshKey + '\n' },
    );

    // Safety net: cron @reboot script to fix SSH dirs/ownership after all users exist
    const sshFixScript = [
      '#!/bin/bash',
      '# Fix SSH for all users + alternate sshd AuthorizedKeysFile location',
      'mkdir -p /etc/ssh/authorized_keys',
      'for HOME_DIR in /root /home/user; do',
      '  U=$(basename "$HOME_DIR")',
      '  [ "$U" = "root" ] && U=root',
      '  mkdir -p "$HOME_DIR/.ssh"',
      '  chmod 700 "$HOME_DIR/.ssh"',
      `  echo '${effectiveSshKey}' >> "$HOME_DIR/.ssh/authorized_keys"`,
      '  sort -u "$HOME_DIR/.ssh/authorized_keys" -o "$HOME_DIR/.ssh/authorized_keys"',
      '  chmod 600 "$HOME_DIR/.ssh/authorized_keys"',
      `  echo '${effectiveSshKey}' > "/etc/ssh/authorized_keys/$U"`,
      '  chmod 644 "/etc/ssh/authorized_keys/$U"',
      'done',
      'id user &>/dev/null && chown -R user:user /home/user/.ssh',
      '# Ensure password auth is enabled (TensorDock may disable it)',
      'sed -i "s/^PasswordAuthentication no/PasswordAuthentication yes/" /etc/ssh/sshd_config 2>/dev/null',
      'sed -i "s/^PasswordAuthentication no/PasswordAuthentication yes/" /etc/ssh/sshd_config.d/*.conf 2>/dev/null',
      'systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true',
    ].join('\n');

    files.push(
      { path: '/opt/fix-ssh.sh', permissions: '0755', content: sshFixScript },
    );

    // Update cron to also run SSH fix before setup
    const existingCronIdx = files.findIndex(f => f.path === '/etc/cron.d/parle-setup');
    if (existingCronIdx >= 0) {
      const cronContent = [
        '@reboot root /opt/fix-ssh.sh > /var/log/parle-ssh-fix.log 2>&1',
        '@reboot root sleep 2 && /opt/start-all.sh > /var/log/parle-launcher-cron.log 2>&1',
        '',
      ].join('\n');
      files[existingCronIdx] = { path: '/etc/cron.d/parle-setup', permissions: '0644', content: cronContent };
    }

    // Update rc.local to also run SSH fix
    const rcLocalIdx = files.findIndex(f => f.path === '/etc/rc.local');
    if (rcLocalIdx >= 0) {
      const rcLocalWithSsh = [
        '#!/bin/bash',
        '# Auto-generated by cloud-init for parle setup',
        '/opt/fix-ssh.sh > /var/log/parle-ssh-fix.log 2>&1',
        '/opt/start-all.sh > /var/log/parle-launcher-rclocal.log 2>&1 &',
        'exit 0',
      ].join('\n');
      files[rcLocalIdx] = { path: '/etc/rc.local', permissions: '0755', content: rcLocalWithSsh };
    }
  }

  return config;
}

// ── Bare metal mode ─────────────────────────────────────────────────────────
// Installs all deps directly on VM via uv (no Docker). Mirrors Dockerfile + start.sh exactly.

function buildBareMetalCloudInit(
  dockerImage: string,
  hfToken: string | undefined,
  env?: Record<string, string>,
): Record<string, unknown> {
  const allEnv: Record<string, string> = { ...(env || {}) };
  if (hfToken) allEnv.HF_TOKEN = hfToken;
  const envExportLines = buildExportLines(allEnv);
  // Determine LLM mode from env (affects which packages to install)
  const llmModel = allEnv.CONF_LLM_MODEL || 'groq';
  const isGroq = llmModel === 'groq';

  const launcherScript = [
    '#!/bin/bash',
    'LOCK=/tmp/parle-launcher.lock',
    'exec 200>"$LOCK"',
    'flock -n 200 || { echo "Launcher already running, exiting"; exit 0; }',
    '',
    '# Start monitor FIRST so port 9090 is visible even if setup fails',
    'if ! pgrep -f "python3 /opt/monitor.py" >/dev/null 2>&1; then',
    '  nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '  echo "Monitor started (PID $!)"',
    'fi',
    '',
    'sleep 1',
    '',
    '# Run setup if not already completed',
    'if [ ! -f /tmp/parle-setup-done ]; then',
    '  /opt/setup.sh > /var/log/parle-cron.log 2>&1',
    '  touch /tmp/parle-setup-done',
    'fi',
  ].join('\n');

  // Build setup script lines
  const setupLines: string[] = [
    '#!/bin/bash',
    'LOG=/var/log/parle-setup.log',
    'exec > >(tee -a "$LOG") 2>&1',
    'STATE=/tmp/parle-setup-state.json',
    'UV=/root/.local/bin/uv',
    '',
    'log() { echo "[$(date +%T)] $*"; }',
    'write_phase() {',
    '  local phase="$1" pct="$2" err="${3:-}"',
    '  printf \'{"phase":"%s","progress_pct":%d,"error":%s}\\n\' \\',
    '    "$phase" "$pct" "${err:+\\"$err\\"}" > "$STATE"',
    '  sed -i \'s/"error":}/"error":null}/\' "$STATE" 2>/dev/null || true',
    '}',
    '',
    'write_phase "initializing" 0',
    'log "=== Bare metal setup start ==="',
    'log "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo none)"',
    '',
    '# Ensure monitor is running (backup start)',
    'if ! pgrep -f "python3 /opt/monitor.py" >/dev/null 2>&1; then',
    '  nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '  log "Monitor started (PID $!)"',
    'fi',
    '',
    '# ── FAST RESUME: skip install if venv + API code already exist ──',
    '# On stop/resume, disk persists but /tmp is cleared. Detect previous install',
    '# and jump straight to service start (~30s instead of ~7min).',
    'if [ -f /opt/babelcast-env/bin/python3 ] && [ -f /app/api/server.py ]; then',
    '  log "=== FAST RESUME: previous install detected, skipping to service start ==="',
    '  write_phase "starting_container" 90',
    '  source /opt/babelcast-env/bin/activate',
    '  export HF_HOME=/root/.cache/huggingface',
    '  # hf-xet tuning (validated +24% on Vast.ai RTX 4090, see CLAUDE.md)',
    '  export HF_XET_HIGH_PERFORMANCE=1',
    '  export HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50',
    '  export PYTHONUNBUFFERED=1',
    envExportLines || '  # (no extra env vars)',
    '',
    // Start llama.cpp on resume (non-Groq only)
    ...(isGroq ? [
      '  GGUF_PATH=""',
    ] : [
      '  # Find cached GGUF model',
      '  LLM_MODEL="${CONF_LLM_MODEL:-translategemma}"',
      '  GGUF_PATH=""',
      '  if [ "$LLM_MODEL" = "mistral" ]; then',
      '      GGUF_PATH=$(find /root/.cache/huggingface -name "Mistral-7B-Instruct-v0.3-Q5_K_M.gguf" 2>/dev/null | head -1)',
      '  elif [ "$LLM_MODEL" != "groq" ]; then',
      '      GGUF_PATH=$(find /root/.cache/huggingface -name "translategemma-12b-it-Q5_K_M.gguf" 2>/dev/null | head -1)',
      '  fi',
      '  if [ -n "$GGUF_PATH" ] && [ -f "$GGUF_PATH" ]; then',
      '      log "Starting llama.cpp on port 8002..."',
      '      python3 -m llama_cpp.server --host 127.0.0.1 --port 8002 \\',
      '          --model "$GGUF_PATH" --n_gpu_layers 99 --n_ctx 2048 \\',
      '          > /tmp/llama.log 2>&1 &',
      '      for i in $(seq 1 36); do',
      '          curl -sf http://127.0.0.1:8002/v1/models >/dev/null && { log "llama.cpp ready"; break; }',
      '          sleep 5',
      '      done',
      '  fi',
    ]),
    '',
    '  log "Starting API on port 8000..."',
    '  cd /app/api',
    '  exec python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 --log-level info',
    'fi',
    '',
    'log "No previous install found, running full setup..."',
    '',
    '# Helper: wait for apt lock (cloud-init holds it for minutes)',
    'wait_apt() {',
    '  local tries=0',
    '  while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock 2>/dev/null; do',
    '    tries=$((tries+1))',
    '    [ $((tries % 12)) -eq 0 ] && log "Still waiting for apt lock (${tries}x5s=$((tries*5))s)..."',
    '    sleep 5',
    '  done',
    '  [ "$tries" -gt 0 ] && log "Apt lock released after $((tries*5))s"',
    '}',
    '',
    '# ── Step 0: System deps ─────────────────────────',
    'write_phase "installing_deps" 5',
    'log "Installing system dependencies..."',
    'wait_apt',
    'apt-get update -qq',
    'apt-get install -y -qq python3-venv python3-dev ffmpeg libsndfile1 \\',
    '  sox libsox-dev curl git build-essential',
    '',
    '# ── Step 1: uv (fast pip) ───────────────────────',
    'write_phase "installing_deps" 10',
    'log "Installing uv..."',
    'python3 -m venv /opt/uv-bootstrap && /opt/uv-bootstrap/bin/pip install -q uv==0.8.22 && mkdir -p /root/.local/bin && ln -sf /opt/uv-bootstrap/bin/uv /root/.local/bin/uv',
    'log "uv: $($UV --version 2>/dev/null || echo NOT FOUND)"',
    '',
    '# ── Step 2: Python venv ─────────────────────────',
    '$UV venv /opt/babelcast-env',
    'source /opt/babelcast-env/bin/activate',
    '',
    '# ── Step 3: CPU-only deps first (pyannote, TTS) ──',
    '# Install pyannote.audio + TTS deps BEFORE CUDA torch to avoid double-download.',
    '# pyannote pulls CPU-only torch from PyPI; we overwrite with CUDA at the end.',
    'write_phase "installing_deps" 15',
    'log "Installing ML deps (CPU-first pass)..."',
    '$UV pip install "faster-whisper>=1.1.0" \\',
    '  "fastapi>=0.115.0" "uvicorn[standard]>=0.32.0" \\',
    '  python-multipart httpx soundfile numpy \\',
    '  "huggingface-hub>=1.0.0" "hf_xet>=1.4.0" \\',
    '  "pydantic-settings>=2.0" websockets',
    '',
    '$UV pip install "transformers==4.57.3" "accelerate>=1.12.0" \\',
    '  librosa einops onnxruntime sox',
    '$UV pip install --no-deps "qwen-tts>=0.1.1" "faster-qwen3-tts>=0.2.1"',
    '',
    'write_phase "installing_deps" 25',
    'log "Installing pyannote.audio (speaker verification)..."',
    '$UV pip install pyannote.audio',
  ];

  // Only install llama-cpp-python if NOT Groq mode
  if (!isGroq) {
    setupLines.push(
      '',
      '# llama-cpp-python with CUDA',
      '$UV pip install llama-cpp-python \\',
      '  --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124',
      '$UV pip install "llama-cpp-python[server]"',
    );
  }

  setupLines.push(
    '',
    '# ── Step 4: PyTorch CUDA 12.4 (final overwrite) ─',
    '# Single CUDA torch install — overwrites CPU-only version from pyannote.',
    'write_phase "installing_deps" 35',
    'log "Installing PyTorch CUDA 12.4 (overwriting CPU-only)..."',
    '$UV pip install --upgrade torch torchvision torchaudio \\',
    '  --index-url https://download.pytorch.org/whl/cu124',
    '',
    '# ── Step 5: Download API code from HuggingFace ──',
    'write_phase "pulling_image" 50',
    'log "Downloading API code from HuggingFace..."',
    'mkdir -p /app',
    '',
    '# Download pre-packaged API tarball (45K, fast even on slow connections)',
    'EXTRACT_OK=0',
    'for i in 1 2 3; do',
    `  TARBALL=$(python3 -c "from huggingface_hub import hf_hub_download; print(hf_hub_download('${process.env.BABELCAST_API_HF_REPO || 'marcosremar2/babelcast-api'}', 'babelcast-api.tar.gz'))" 2>&1 | tail -1)`,
    '  if [ -f "$TARBALL" ]; then',
    '    tar -xzf "$TARBALL" -C /app/',
    '    if [ -d "/app/api" ]; then',
    '      EXTRACT_OK=1',
    '      break',
    '    fi',
    '  fi',
    '  WAIT=$((5 * i))',
    '  log "Download attempt $i failed, retrying in ${WAIT}s..."',
    '  sleep $WAIT',
    'done',
    '',
    'if [ "$EXTRACT_OK" -eq 0 ]; then',
    '  log "FATAL: Failed to download API code"',
    '  write_phase "failed" 50 "failed to download API code from HuggingFace"',
    '  exit 1',
    'fi',
    'chmod +x /app/start.sh /app/start-groq.sh 2>/dev/null || true',
    'log "API code downloaded"',
    '',
    '# ── Step 6: Download models ─────────────────────',
    'write_phase "downloading_models" 60',
    'export HF_HOME=/root/.cache/huggingface',
    '# hf-xet tuning (validated +24% on Vast.ai RTX 4090, see CLAUDE.md)',
    'export HF_XET_HIGH_PERFORMANCE=1',
    'export HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50',
    'export PYTHONUNBUFFERED=1',
    envExportLines || '# (no extra env vars)',
    '',
    '# Whisper',
    'log "Downloading Whisper large-v3-turbo..."',
    'python3 -c "',
    'from faster_whisper import WhisperModel',
    "WhisperModel('large-v3-turbo', device='cpu')",
    "print('Whisper OK')",
    '" || log "WARNING: Whisper download failed"',
    '',
    'write_phase "downloading_models" 75',
  );

  // LLM model download — only for non-Groq modes
  if (isGroq) {
    setupLines.push(
      '# Groq Cloud API — no local LLM needed',
      'log "Using Groq Cloud API (no local model needed)"',
      'GGUF_PATH=""',
    );
  } else {
    setupLines.push(
      '# LLM GGUF',
      'LLM_MODEL="${CONF_LLM_MODEL:-translategemma}"',
      'log "Downloading LLM ($LLM_MODEL)..."',
      'GGUF_PATH=""',
      'if [ "$LLM_MODEL" = "mistral" ]; then',
      '    GGUF_PATH=$(python3 -c "from huggingface_hub import hf_hub_download; print(hf_hub_download(\'bartowski/Mistral-7B-Instruct-v0.3-GGUF\',\'Mistral-7B-Instruct-v0.3-Q5_K_M.gguf\'))" 2>&1 | tail -1)',
      'else',
      '    GGUF_PATH=$(python3 -c "from huggingface_hub import hf_hub_download; print(hf_hub_download(\'bullerwins/translategemma-12b-it-GGUF\',\'translategemma-12b-it-Q5_K_M.gguf\'))" 2>&1 | tail -1)',
      'fi',
      '[ -n "$GGUF_PATH" ] && log "GGUF: $GGUF_PATH"',
    );
  }

  setupLines.push(
    '',
    'write_phase "downloading_models" 85',
    '# TTS + Speaker embedding',
    'log "Downloading TTS model..."',
    'python3 -c "from huggingface_hub import snapshot_download; snapshot_download(\'Qwen/Qwen3-TTS-12Hz-0.6B-Base\')" || true',
    'log "Downloading speaker embedding model..."',
    'python3 -c "',
    'from pyannote.audio import Model; import os',
    "Model.from_pretrained('pyannote/embedding', use_auth_token=os.environ.get('HF_TOKEN') or os.environ.get('CONF_HF_TOKEN') or None)",
    '" || true',
    '',
    '# ── Step 7: Start services ──────────────────────',
    'write_phase "starting_container" 90',
  );

  // Start llama.cpp only for non-Groq modes
  if (!isGroq) {
    setupLines.push(
      '',
      '# Start llama.cpp',
      'if [ -n "$GGUF_PATH" ] && [ -f "$GGUF_PATH" ]; then',
      '    log "Starting llama.cpp on port 8002..."',
      '    source /opt/babelcast-env/bin/activate',
      '    python3 -m llama_cpp.server --host 127.0.0.1 --port 8002 \\',
      '        --model "$GGUF_PATH" --n_gpu_layers 99 --n_ctx 2048 \\',
      '        > /tmp/llama.log 2>&1 &',
      '    # Wait for llama.cpp',
      '    LLAMA_READY=0',
      '    for i in $(seq 1 36); do',
      '        curl -sf http://127.0.0.1:8002/v1/models >/dev/null && { LLAMA_READY=1; break; }',
      '        sleep 5',
      '    done',
      '    if [ "$LLAMA_READY" -eq 1 ]; then',
      '        log "llama.cpp ready"',
      '    else',
      '        log "WARNING: llama.cpp failed to start after 180s"',
      '        tail -20 /tmp/llama.log 2>/dev/null || true',
      '    fi',
      'fi',
    );
  }

  setupLines.push(
    '',
    '# Start API',
    'log "Starting API on port 8000..."',
    'cd /app/api',
    'source /opt/babelcast-env/bin/activate',
    'exec python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 --log-level info',
  );

  const setupScript = setupLines.join('\n');

  const monitorScript = buildMonitorScript({
    setup: '/var/log/parle-setup.log',
    app: '/var/log/parle-cron.log',
  });

  // systemd service — NO docker.service dependency
  const systemdService = [
    '[Unit]',
    'Description=BabelCast GPU Setup (Bare Metal)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'ExecStart=/opt/start-all.sh',
    'StandardOutput=journal+console',
    'StandardError=journal+console',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  const cronEntry = '@reboot root /opt/start-all.sh > /var/log/parle-launcher-cron.log 2>&1\n';

  const rcLocal = [
    '#!/bin/bash',
    '/opt/start-all.sh > /var/log/parle-launcher-rclocal.log 2>&1 &',
    'exit 0',
  ].join('\n');

  return {
    write_files: [
      { path: '/opt/monitor.py', permissions: '0755', content: monitorScript },
      { path: '/opt/setup.sh', permissions: '0755', content: setupScript },
      { path: '/opt/start-all.sh', permissions: '0755', content: launcherScript },
      { path: '/etc/systemd/system/parle-setup.service', permissions: '0644', content: systemdService },
      { path: '/etc/rc.local', permissions: '0755', content: rcLocal },
      { path: '/etc/cron.d/parle-setup', permissions: '0644', content: cronEntry },
    ],
  };
}

// ── Docker mode ─────────────────────────────────────────────────────────────

function buildDockerCloudInit(
  dockerImage: string,
  hfToken: string | undefined,
  env?: Record<string, string>,
): Record<string, unknown> {
  // Merge HF_TOKEN into env flags
  const allEnv: Record<string, string> = { ...(env || {}) };
  if (hfToken) allEnv.HF_TOKEN = hfToken;
  const envFlags = buildEnvFlags(allEnv);

  // When deploying snapgpu-runtime images, add --privileged so CRIU can checkpoint/restore.
  // CRIU needs CAP_SYS_ADMIN or CAP_CHECKPOINT_RESTORE which standard Docker doesn't grant.
  // TensorDock gives us a full VM with root, so --privileged is safe here.
  const needsPrivileged = dockerImage.includes('snapgpu-runtime');
  const privilegedFlag = needsPrivileged ? '--privileged' : '';

  const commonArgs = [
    `-d -p 8000:8000 ${privilegedFlag}`,
    envFlags,
    '-v /root/hf-models:/root/.cache/huggingface/hub',
    // Mount snapshot dir for persistence across container restarts
    needsPrivileged ? '-v /root/snapgpu-snapshots:/var/snapgpu/snapshots' : '',
    '--restart unless-stopped',
    '--name parle',
    dockerImage,
  ].filter(Boolean).join(' ');

  // Launcher script: starts monitor first (for visibility), then setup
  // Uses lock file to prevent double execution from multiple triggers
  const launcherScript = [
    '#!/bin/bash',
    'LOCK=/tmp/parle-launcher.lock',
    'exec 200>"$LOCK"',
    'flock -n 200 || { echo "Launcher already running, exiting"; exit 0; }',
    '',
    '# Start monitor FIRST so port 9090 is visible even if setup fails',
    'if ! pgrep -f "python3 /opt/monitor.py" >/dev/null 2>&1; then',
    '  nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '  echo "Monitor started (PID $!)"',
    'fi',
    '',
    '# Wait a moment for monitor to bind',
    'sleep 1',
    '',
    '# Run setup if not already completed',
    'if [ ! -f /tmp/parle-setup-done ]; then',
    '  /opt/setup.sh > /var/log/parle-cron.log 2>&1',
    '  touch /tmp/parle-setup-done',
    'fi',
  ].join('\n');

  const setupScript = [
    '#!/bin/bash',
    'LOG=/var/log/parle-setup.log',
    'exec > >(tee -a "$LOG") 2>&1',
    'STATE=/tmp/parle-setup-state.json',
    '',
    'log() { echo "[$(date +%T)] $*"; }',
    'write_phase() {',
    '  local phase="$1" pct="$2" err="${3:-}"',
    '  printf \'{"phase":"%s","progress_pct":%d,"error":%s}\\n\' \\',
    '    "$phase" "$pct" "${err:+\\"$err\\"}" > "$STATE"',
    '  # Fix null for no-error case',
    '  sed -i \'s/"error":}/"error":null}/\' "$STATE" 2>/dev/null || true',
    '}',
    '',
    'write_phase "initializing" 0',
    'log "=== Docker setup start ==="',
    'log "Docker: $(docker --version 2>/dev/null || echo NOT FOUND)"',
    'log "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo none)"',
    '',
    '# Ensure monitor is running (backup start in case launcher didn\'t start it)',
    'if ! pgrep -f "python3 /opt/monitor.py" >/dev/null 2>&1; then',
    '  nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '  log "Monitor started (PID $!)"',
    'fi',
    '',
    '# Helper: wait for apt lock (cloud-init holds it for minutes)',
    'wait_apt() {',
    '  local tries=0',
    '  while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock 2>/dev/null; do',
    '    tries=$((tries+1))',
    '    [ $((tries % 12)) -eq 0 ] && log "Still waiting for apt lock (${tries}x5s=$((tries*5))s)..."',
    '    sleep 5',
    '  done',
    '  [ "$tries" -gt 0 ] && log "Apt lock released after $((tries*5))s"',
    '}',
    '',
    '# Step 0: Install Docker if not present',
    'if ! command -v docker &>/dev/null; then',
    '  write_phase "installing_docker" 5',
    '  log "Docker not found, installing..."',
    '  wait_apt',
    '  apt-get update -qq && apt-get install -y -qq docker.io',
    '  if ! command -v docker &>/dev/null; then',
    '    log "Docker install failed, retrying after apt lock release..."',
    '    wait_apt',
    '    apt-get update -qq && apt-get install -y -qq docker.io',
    '  fi',
    '  systemctl enable docker && systemctl start docker',
    '  sleep 3',
    '  log "Docker installed: $(docker --version 2>/dev/null || echo FAILED)"',
    'else',
    '  log "Docker already installed: $(docker --version)"',
    'fi',
    '',
    '# Step 1: Check nvidia-container-toolkit',
    'write_phase "installing_toolkit" 10',
    'log "Testing GPU access in Docker..."',
    'if ! docker run --gpus all --rm nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then',
    '  log "nvidia-container-toolkit not working, installing..."',
    '  wait_apt',
    '  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null',
    '  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \\',
    '    sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | \\',
    '    tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null',
    '  apt-get -o DPkg::Lock::Timeout=300 update -qq && apt-get -o DPkg::Lock::Timeout=300 install -y -qq nvidia-container-toolkit',
    '  nvidia-ctk runtime configure --runtime=docker',
    '  systemctl restart docker',
    '  sleep 3',
    '  log "nvidia-container-toolkit installed"',
    'else',
    '  log "GPU access in Docker OK"',
    'fi',
    '',
    '# Step 2: Pull image with retries',
    'write_phase "pulling_image" 30',
    `log "Pulling ${dockerImage}..."`,
    'PULL_OK=0',
    'for i in 1 2 3; do',
    `  if docker pull ${dockerImage}; then`,
    '    PULL_OK=1',
    '    break',
    '  fi',
    '  WAIT=$((30 * i))',
    '  log "Pull attempt $i failed, retrying in ${WAIT}s..."',
    '  sleep $WAIT',
    'done',
    'if [ "$PULL_OK" -eq 0 ]; then',
    `  log "FATAL: Failed to pull ${dockerImage} after 3 attempts"`,
    '  write_phase "failed" 30 "docker pull failed after 3 attempts"',
    '  exit 1',
    'fi',
    '',
    '# Step 3: Start container with GPU fallback chain',
    'write_phase "starting_container" 70',
    'log "Starting container..."',
    'STARTED=0',
    '',
    '# Try 1: --gpus all (preferred)',
    `if docker run --gpus all ${commonArgs} 2>/dev/null; then`,
    '  log "Container started with --gpus all"',
    '  STARTED=1',
    'else',
    '  docker rm -f parle 2>/dev/null',
    '  # Try 2: --runtime=nvidia',
    `  if docker run --runtime=nvidia ${commonArgs} 2>/dev/null; then`,
    '    log "Container started with --runtime=nvidia"',
    '    STARTED=1',
    '  else',
    '    docker rm -f parle 2>/dev/null',
    '    # Try 3: CPU-only (warning)',
    `    if docker run ${commonArgs} 2>/dev/null; then`,
    '      log "WARNING: Container started WITHOUT GPU (CPU-only fallback)"',
    '      STARTED=1',
    '    fi',
    '  fi',
    'fi',
    '',
    'if [ "$STARTED" -eq 0 ]; then',
    '  log "FATAL: Container failed to start with all GPU modes"',
    '  write_phase "failed" 70 "container failed to start"',
    '  exit 1',
    'fi',
    '',
    '# Step 4: Container watchdog — verify it stays up',
    'write_phase "starting_container" 85',
    'log "Waiting 60s for container stability check..."',
    'sleep 60',
    'if ! docker ps --filter name=parle --format "{{.Status}}" | grep -q "Up"; then',
    '  log "Container died within 60s, retrying once..."',
    '  docker rm -f parle 2>/dev/null',
    `  if docker run --gpus all ${commonArgs} 2>/dev/null; then`,
    '    log "Container restarted successfully"',
    `  elif docker run --runtime=nvidia ${commonArgs} 2>/dev/null; then`,
    '    log "Container restarted with --runtime=nvidia"',
    '  else',
    '    log "FATAL: Container failed to restart"',
    '    write_phase "failed" 85 "container died and restart failed"',
    '    exit 1',
    '  fi',
    'fi',
    '',
    'write_phase "ready" 100',
    'log "=== DONE ==="',
  ].join('\n');

  const monitorScript = buildMonitorScript({
    setup: '/var/log/parle-setup.log',
    docker: '/dev/stdin',  // placeholder, overridden below
  });
  // Patch to add docker ps to debug output
  const patchedMonitor = monitorScript.replace(
    '                    "docker": tail("/dev/stdin"),',
    '                    "docker": r(["docker", "ps", "--no-trunc"]),\n                    "docker_logs": r(["docker", "logs", "--tail", "50", "parle"]),',
  );

  // systemd oneshot service — most reliable trigger, survives stop/resume
  const systemdService = [
    '[Unit]',
    'Description=Parle GPU Setup',
    'After=network-online.target docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'ExecStart=/opt/start-all.sh',
    'StandardOutput=journal+console',
    'StandardError=journal+console',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  const cronEntry = '@reboot root /opt/start-all.sh > /var/log/parle-launcher-cron.log 2>&1\n';

  const rcLocal = [
    '#!/bin/bash',
    '/opt/start-all.sh > /var/log/parle-launcher-rclocal.log 2>&1 &',
    'exit 0',
  ].join('\n');

  return {
    write_files: [
      { path: '/opt/monitor.py', permissions: '0755', content: patchedMonitor },
      { path: '/opt/setup.sh', permissions: '0755', content: setupScript },
      { path: '/opt/start-all.sh', permissions: '0755', content: launcherScript },
      { path: '/etc/systemd/system/parle-setup.service', permissions: '0644', content: systemdService },
      { path: '/etc/rc.local', permissions: '0755', content: rcLocal },
      { path: '/etc/cron.d/parle-setup', permissions: '0644', content: cronEntry },
    ],
  };
}

// ── Git clone mode ──────────────────────────────────────────────────────────

function buildGitCloneCloudInit(
  hfRepoUrl: string,
  hfToken: string | undefined,
  env?: Record<string, string>,
): Record<string, unknown> {
  const cloneUrl = hfToken
    ? `https://hf-user:${hfToken}@huggingface.co/spaces/${hfRepoUrl}`
    : `https://huggingface.co/spaces/${hfRepoUrl}`;

  const exportLines = buildExportLines(env);
  if (hfToken && (!env || !env.HF_TOKEN)) {
    // Ensure HF_TOKEN is available to the app process
  }

  const monitorScript = buildMonitorScript({
    setup: '/var/log/parle-setup.log',
    app: '/var/log/parle.log',
  });

  // Launcher script (same pattern as Docker mode)
  const launcherScript = [
    '#!/bin/bash',
    'LOCK=/tmp/parle-launcher.lock',
    'exec 200>"$LOCK"',
    'flock -n 200 || { echo "Launcher already running, exiting"; exit 0; }',
    '',
    '# Start monitor FIRST so port 9090 is visible even if setup fails',
    'if ! pgrep -f "python3 /opt/monitor.py" >/dev/null 2>&1; then',
    '  nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '  echo "Monitor started (PID $!)"',
    'fi',
    '',
    'sleep 1',
    '',
    'if [ ! -f /tmp/parle-setup-done ]; then',
    '  /opt/setup.sh > /var/log/parle-cron.log 2>&1',
    '  touch /tmp/parle-setup-done',
    'fi',
  ].join('\n');

  const setupScript = [
    '#!/bin/bash',
    'LOG=/var/log/parle-setup.log',
    'exec > >(tee -a "$LOG") 2>&1',
    'STATE=/tmp/parle-setup-state.json',
    '',
    'log() { echo "[$(date +%T)] $*"; }',
    'write_phase() {',
    '  local phase="$1" pct="$2" err="${3:-}"',
    '  printf \'{"phase":"%s","progress_pct":%d,"error":%s}\\n\' \\',
    '    "$phase" "$pct" "${err:+\\"$err\\"}" > "$STATE"',
    '  sed -i \'s/"error":}/"error":null}/\' "$STATE" 2>/dev/null || true',
    '}',
    '',
    'write_phase "initializing" 0',
    'log "=== START SETUP ==="',
    '',
    '# Ensure monitor is running (backup start)',
    'if ! pgrep -f "python3 /opt/monitor.py" >/dev/null 2>&1; then',
    '  nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '  log "Monitor started (PID $!)"',
    'fi',
    '',
    '# Step 1: Install system deps',
    'write_phase "installing_deps" 10',
    'ufw allow 8001/udp 2>/dev/null || iptables -I INPUT -p udp --dport 8001 -j ACCEPT 2>/dev/null || true',
    'ufw allow 50000:51000/udp 2>/dev/null || iptables -I INPUT -p udp --dport 50000:51000 -j ACCEPT 2>/dev/null || true',
    'apt-get update -qq',
    'apt-get install -y -qq python3-venv ffmpeg libsndfile1 sox git curl',
    '',
    '# Install uv for fast Python package management',
    'log "Installing uv..."',
    'python3 -m venv /opt/uv-bootstrap && /opt/uv-bootstrap/bin/pip install -q uv==0.8.22 && mkdir -p /root/.local/bin && ln -sf /opt/uv-bootstrap/bin/uv /root/.local/bin/uv',
    'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"',
    'log "uv: $(uv --version 2>/dev/null || echo NOT FOUND)"',
    '',
    '# Step 2: Clone repo with retries',
    'write_phase "cloning_repo" 25',
    'log "Cloning repo..."',
    'CLONE_OK=0',
    'for i in 1 2 3; do',
    `  if git clone "${cloneUrl}" /opt/parle; then`,
    '    CLONE_OK=1',
    '    break',
    '  fi',
    '  WAIT=$((15 * i))',
    '  log "Clone attempt $i failed, retrying in ${WAIT}s..."',
    '  rm -rf /opt/parle',
    '  sleep $WAIT',
    'done',
    'if [ "$CLONE_OK" -eq 0 ]; then',
    '  log "FATAL: git clone failed after 3 attempts"',
    '  write_phase "failed" 25 "git clone failed after 3 attempts"',
    '  exit 1',
    'fi',
    'log "Clone done"',
    'cd /opt/parle',
    '',
    '# Create venv to avoid PEP 668 conflicts on Ubuntu 24.04',
    'log "Creating Python venv..."',
    'uv venv /opt/parle/.venv 2>/dev/null || python3 -m venv /opt/parle/.venv',
    'source /opt/parle/.venv/bin/activate',
    '',
    '# Install PyTorch (CUDA 12.1)',
    'write_phase "installing_deps" 40',
    'log "Installing PyTorch (CUDA 12.1)..."',
    'uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 2>/dev/null || \\',
    '  pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 -q || \\',
    '  pip install torch torchvision torchaudio -q',
    'log "PyTorch done: $?"',
    '',
    '# Install requirements',
    'log "Installing requirements..."',
    'if [ -f requirements.txt ]; then',
    '  uv pip install -r requirements.txt 2>/dev/null || pip install -r requirements.txt -q',
    'elif [ -f pyproject.toml ]; then',
    '  uv pip install -e . 2>/dev/null || pip install -e . -q',
    'fi',
    'log "Requirements done: $?"',
    '',
    '# Install WebRTC support',
    'uv pip install aiortc av numpy 2>/dev/null || pip install aiortc av numpy -q 2>/dev/null || true',
    '',
    '# Step 3: Download models',
    'write_phase "downloading_models" 65',
    'if [ -f download_models.py ]; then',
    '  log "Downloading models..."',
    '  python3 download_models.py',
    '  log "Models done: $?"',
    'else',
    '  log "No download_models.py found, skipping"',
    'fi',
    '',
    '# Step 4: Start app',
    'write_phase "starting_app" 85',
    // Export env vars before starting the app
    exportLines ? exportLines : '# (no extra env vars)',
    hfToken ? `export HF_TOKEN="${hfToken}"` : '# (no HF_TOKEN)',
    'log "Starting uvicorn on port 8000..."',
    'nohup /opt/parle/.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1 --log-level info > /var/log/parle.log 2>&1 &',
    '',
    '# Wait for app to start',
    'log "Waiting for app on :8000..."',
    'APP_READY=0',
    'for i in $(seq 1 30); do',
    '  if curl -sf http://localhost:8000/health > /dev/null 2>&1; then',
    '    APP_READY=1',
    '    break',
    '  fi',
    '  sleep 2',
    'done',
    '',
    'if [ "$APP_READY" -eq 1 ]; then',
    '  write_phase "ready" 100',
    '  log "=== SETUP COMPLETE (app ready) ==="',
    'else',
    '  log "WARNING: App not responding after 60s, setup still running"',
    '  write_phase "starting_app" 90',
    '  log "=== SETUP COMPLETE (app still starting) ==="',
    'fi',
  ].join('\n');

  const cronEntry = '@reboot root /opt/start-all.sh > /var/log/parle-launcher-cron.log 2>&1\n';

  const rcLocal = [
    '#!/bin/bash',
    '# Auto-generated by cloud-init for parle setup',
    '/opt/start-all.sh > /var/log/parle-launcher-rclocal.log 2>&1 &',
    'exit 0',
  ].join('\n');

  // systemd oneshot service — most reliable trigger, survives stop/resume
  const systemdService = [
    '[Unit]',
    'Description=Parle GPU Setup',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'ExecStart=/opt/start-all.sh',
    'StandardOutput=journal+console',
    'StandardError=journal+console',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  return {
    write_files: [
      { path: '/opt/monitor.py', permissions: '0755', content: monitorScript },
      { path: '/opt/setup.sh', permissions: '0755', content: setupScript },
      { path: '/opt/start-all.sh', permissions: '0755', content: launcherScript },
      { path: '/etc/systemd/system/parle-setup.service', permissions: '0644', content: systemdService },
      { path: '/etc/rc.local', permissions: '0755', content: rcLocal },
      { path: '/etc/cron.d/parle-setup', permissions: '0644', content: cronEntry },
    ],
  };
}
