/**
 * Cloud-init builder for TensorDock VMs.
 *
 * IMPORTANT: TensorDock's cloud-init has a critical bug where ANY command
 * execution — `runcmd`, `bootcmd`, AND `scripts-per-instance` — causes the
 * VM to crash (~150-180s after boot, GPU disassociated/stopped).
 *
 * Workaround: use ONLY `write_files` to place scripts on disk. Execution is
 * triggered by cron @reboot, which runs independently of cloud-init.
 *
 * All write_files use base64 encoding to avoid character corruption during
 * the JSON→YAML cloud-init conversion (special chars: $, {{}}, quotes, etc).
 */

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
 * Uses ONLY `write_files` (no runcmd/bootcmd/packages/scripts-per-instance).
 * Scripts are placed in /opt/ and triggered via cron @reboot.
 */
export function buildCloudInit(spec: CloudInitSpec): Record<string, unknown> {
  const { hfRepoUrl = 'marcosremar2/parle-speech-to-speech', hfToken, dockerImage, sshPubKey, env } = spec;

  // Use provided key or fall back to env var TENSORDOCK_SSH_PUBKEY
  const effectiveSshKey = sshPubKey || getDefaultSshPubKey();

  const config = dockerImage
    ? buildDockerCloudInit(dockerImage, hfToken, env)
    : buildGitCloneCloudInit(hfRepoUrl, hfToken, env);

  // TensorDock base config sets `user: user` with `ssh_pwauth: True`.
  // Our cloud-init is APPENDED to it. DO NOT use `users` directive — it conflicts
  // and breaks the default user creation entirely.

  // Password fallback for SSH (TensorDock has ssh_pwauth: True by default)
  config.password = 'parle2024gpu';
  config.chpasswd = { expire: false };

  if (effectiveSshKey) {
    // SSH key injection — appended to TensorDock's base config for `user` account:
    // 1. ssh_authorized_keys: cloud-init injects for the default 'user' account
    // 2. write_files: backup injection for root
    // 3. cron @reboot fix-ssh.sh: safety net after all users/dirs exist
    config.ssh_authorized_keys = [effectiveSshKey];

    const files = config.write_files as Array<Record<string, string>>;
    // Write to ALL possible SSH key locations (Ubuntu 24.04 cloud-init bug #6175)
    files.push(
      { path: '/root/.ssh/authorized_keys', permissions: '0600', content: b64(effectiveSshKey + '\n'), encoding: 'b64' },
      { path: '/home/user/.ssh/authorized_keys', permissions: '0600', content: b64(effectiveSshKey + '\n'), encoding: 'b64' },
      { path: '/etc/ssh/authorized_keys/root', permissions: '0644', content: b64(effectiveSshKey + '\n'), encoding: 'b64' },
      { path: '/etc/ssh/authorized_keys/user', permissions: '0644', content: b64(effectiveSshKey + '\n'), encoding: 'b64' },
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
      { path: '/opt/fix-ssh.sh', permissions: '0755', content: b64(sshFixScript), encoding: 'b64' },
    );

    // Update cron to also run SSH fix before setup
    const existingCronIdx = files.findIndex(f => f.path === '/etc/cron.d/parle-setup');
    if (existingCronIdx >= 0) {
      const cronContent = [
        '@reboot root /opt/fix-ssh.sh > /var/log/parle-ssh-fix.log 2>&1',
        '@reboot root sleep 2 && /opt/setup.sh > /var/log/parle-cron.log 2>&1',
        '',
      ].join('\n');
      files[existingCronIdx] = { path: '/etc/cron.d/parle-setup', permissions: '0644', content: b64(cronContent), encoding: 'b64' };
    }
  }

  return config;
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

  const commonArgs = [
    '-d -p 8000:8000',
    envFlags,
    '-v /root/hf-models:/root/.cache/huggingface/hub',
    '--restart unless-stopped',
    '--name parle',
    dockerImage,
  ].filter(Boolean).join(' ');

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
    '# Start monitor',
    'nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '',
    '# Step 1: Check nvidia-container-toolkit',
    'write_phase "installing_toolkit" 10',
    'log "Testing GPU access in Docker..."',
    'if ! docker run --gpus all --rm nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then',
    '  log "nvidia-container-toolkit not working, installing..."',
    '  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null',
    '  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \\',
    '    sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | \\',
    '    tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null',
    '  apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit',
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

  const cronEntry = '@reboot root /opt/setup.sh > /var/log/parle-cron.log 2>&1\n';

  return {
    write_files: [
      { path: '/opt/monitor.py', permissions: '0755', content: b64(patchedMonitor), encoding: 'b64' },
      { path: '/opt/setup.sh', permissions: '0755', content: b64(setupScript), encoding: 'b64' },
      { path: '/etc/cron.d/parle-setup', permissions: '0644', content: b64(cronEntry), encoding: 'b64' },
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
    'nohup python3 /opt/monitor.py > /var/log/monitor.log 2>&1 &',
    '',
    '# Step 1: Install system deps',
    'write_phase "installing_deps" 10',
    'ufw allow 50000:51000/udp 2>/dev/null || iptables -I INPUT -p udp --dport 50000:51000 -j ACCEPT 2>/dev/null || true',
    'apt-get update -qq',
    'apt-get install -y -qq python3-venv ffmpeg libsndfile1 sox git curl',
    '',
    '# Install uv for fast Python package management',
    'log "Installing uv..."',
    'curl -LsSf https://astral.sh/uv/install.sh | sh',
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

  const cronEntry = '@reboot root /opt/setup.sh > /var/log/parle-cron.log 2>&1\n';

  return {
    write_files: [
      { path: '/opt/monitor.py', permissions: '0755', content: b64(monitorScript), encoding: 'b64' },
      { path: '/opt/setup.sh', permissions: '0755', content: b64(setupScript), encoding: 'b64' },
      { path: '/etc/cron.d/parle-setup', permissions: '0644', content: b64(cronEntry), encoding: 'b64' },
    ],
  };
}
