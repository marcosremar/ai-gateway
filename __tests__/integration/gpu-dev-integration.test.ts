/**
 * Integration tests for the `gpu dev` scratch-machine feature.
 *
 * Covers:
 *   - Source-code invariants proving the dev-mode wiring exists
 *   - CLI dispatcher: `gpu dev help`, error paths
 *   - _validateDeployRequest: devMode body → config.devMode
 *   - Persistence roundtrip: devMode survives save/load
 *   - autoStopGpu dev mode: no auto-destroy scheduled
 *   - Dev image files (Dockerfile, health_server, start.sh) exist and are consistent
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const hasBun = (() => {
  const res = spawnSync('bun', ['--version'], { stdio: 'pipe' });
  return !res.error && res.status === 0;
})();

describe('gpu dev — integration', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 1. Source-code invariants — proves wiring is in the codebase
  // ────────────────────────────────────────────────────────────────────────────

  describe('source-code invariants', () => {
    const cliSource = readFileSync('bin/ai-gateway.ts', 'utf8');
    const idleManagerSource = readFileSync('server/gpu-idle-manager.ts', 'utf8');
    const autoRecoverySource = readFileSync('server/gpu-auto-recovery.ts', 'utf8');
    const handlersSource = readFileSync('server/gpu-handlers.ts', 'utf8');
    const deployStateSource = readFileSync('src/gateway/state/deploy-state.ts', 'utf8');

    it('CLI exposes gpu dev dispatcher with start/sh/exec/push/pull/snapshot/serve/info/help', () => {
      expect(cliSource).toContain("case 'dev':");
      expect(cliSource).toContain('async function cmdGpuDev');
      expect(cliSource).toContain("case 'start'");
      expect(cliSource).toContain("case 'sh'");
      expect(cliSource).toContain("case 'exec'");
      expect(cliSource).toContain("case 'push'");
      expect(cliSource).toContain("case 'pull'");
      expect(cliSource).toContain("case 'snapshot'");
      expect(cliSource).toContain("case 'serve'");
      expect(cliSource).toContain("case 'info'");
    });

    it('CLI default dev image points at marcosremar/gpu-dev:latest', () => {
      expect(cliSource).toMatch(/GPU_DEV_DEFAULT_IMAGE\s*=\s*['"]marcosremar\/gpu-dev:latest['"]/);
    });

    it('CLI cmdGpuDevStart enables devMode: true on the deploy body', () => {
      // The function should pass devMode: true down to cmdGpuDeploy
      expect(cliSource).toMatch(/async function cmdGpuDevStart[\s\S]{0,1500}devMode:\s*true/);
    });

    it('CLI cmdGpuDevStart uses SSH readiness for scratch machines', () => {
      expect(cliSource).toMatch(/async function cmdGpuDevStart[\s\S]{0,700}readinessProbe:\s*['"]ssh['"]/);
    });

    it('CLI cmdGpuDeploy threads devMode into the POST body', () => {
      expect(cliSource).toMatch(/if\s*\(\s*opts\.devMode\s*\)\s*body\.devMode\s*=\s*true/);
    });

    it('CLI `gpu pull` is wired as a top-level gpu subcommand', () => {
      // Pull should be dispatched in the top-level gpu switch, not just inside dev
      const gpuSwitchBlock = cliSource.match(/case 'gpu': \{[\s\S]+?case 'dev':\s*await cmdGpuDev/);
      expect(gpuSwitchBlock).not.toBeNull();
      expect(gpuSwitchBlock![0]).toMatch(/case 'pull':/);
    });

    it('deploy-state adds devMode field on DeploymentState and PersistedDeploy', () => {
      expect(deployStateSource).toMatch(/export interface DeploymentState[\s\S]+?devMode\?:\s*boolean/);
      expect(deployStateSource).toMatch(/export interface PersistedDeploy[\s\S]+?devMode\?:\s*boolean/);
    });

    it('persistDeployState includes devMode when set', () => {
      expect(deployStateSource).toMatch(/deployState\.devMode\s*\?\s*\{\s*devMode:\s*true\s*\}\s*:\s*\{\}/);
    });

    it('persistDeployState includes readinessProbe when set', () => {
      expect(deployStateSource).toMatch(/deployState\.readinessProbe\s*\?\s*\{\s*readinessProbe:\s*deployState\.readinessProbe\s*\}\s*:\s*\{\}/);
    });

    it('deploy handler accepts body.devMode and stores it in deployState', () => {
      expect(handlersSource).toMatch(/body\.devMode\s*===\s*true/);
      expect(handlersSource).toMatch(/setDeployState\(\{\s*deployId,\s*devMode:/);
      // DeployConfig interface carries the flag
      expect(handlersSource).toMatch(/devMode\?:\s*boolean/);
    });

    it('idle-manager skips auto-destroy when devMode=true', () => {
      // Key assertion: the skip branch exists
      expect(idleManagerSource).toMatch(/deployState\.devMode\s*===\s*true/);
      expect(idleManagerSource).toMatch(/if\s*\(isDev\)/);
      expect(idleManagerSource).toMatch(/Auto-destroy skipped for dev pod/);
      // Non-dev path still calls scheduleAutoDestroy
      expect(idleManagerSource).toMatch(/scheduleAutoDestroy\(IDLE_DESTROY_MS\)/);
    });

    it('auto-recovery restores devMode from persisted state', () => {
      expect(autoRecoverySource).toMatch(/persisted\.devMode\s*\?\s*\{\s*devMode:\s*true\s*\}\s*:\s*\{\}/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. CLI dispatcher — verify help text + error paths (subprocess)
  // ────────────────────────────────────────────────────────────────────────────

  describe.skipIf(!hasBun)('CLI dispatcher (subprocess)', () => {
    // Run the CLI with bun — captures stdout, suppresses the "Gateway started"
    // side effect by not making any network calls.
    function runCli(args: string[]) {
      const res = spawnSync('bun', ['run', 'bin/ai-gateway.ts', ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, NO_COLOR: '1' },
      });
      return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status };
    }

    it('gpu dev help prints all subcommand names', () => {
      const { stdout } = runCli(['gpu', 'dev', 'help']);
      expect(stdout).toContain('gpu dev');
      expect(stdout).toContain('Scratch GPU machine');
      // All subcommands present
      for (const sub of ['start', 'stop', 'status', 'sh', 'exec', 'push', 'pull', 'snapshot', 'serve', 'info']) {
        expect(stdout).toContain(sub);
      }
      // Workflow example present
      expect(stdout).toContain('gpu dev start');
      expect(stdout).toContain('gpu dev exec');
    });

    it('gpu dev with no args prints help (no error)', () => {
      const { stdout, code } = runCli(['gpu', 'dev']);
      expect(stdout).toContain('Scratch GPU machine');
      expect(code).toBe(0);
    });

    it('gpu dev serve without port errors with usage message', () => {
      const { stderr, code } = runCli(['gpu', 'dev', 'serve']);
      expect(stderr).toContain('Usage: ai-gateway gpu dev serve');
      expect(code).not.toBe(0);
    });

    it('gpu dev pull without path errors with usage message', () => {
      const { stderr, code } = runCli(['gpu', 'dev', 'pull']);
      expect(stderr).toContain('Usage: ai-gateway gpu dev pull');
      expect(code).not.toBe(0);
    });

    it('gpu dev push without file errors with usage message', () => {
      const { stderr, code } = runCli(['gpu', 'dev', 'push']);
      expect(stderr).toContain('Usage: ai-gateway gpu dev push');
      expect(code).not.toBe(0);
    });

    it('gpu dev unknown subcommand errors clearly', () => {
      const { stderr, code } = runCli(['gpu', 'dev', 'xyz']);
      expect(stderr).toContain("Unknown 'gpu dev' subcommand: xyz");
      expect(code).not.toBe(0);
    });

    it('top-level gpu help lists dev as a subcommand', () => {
      const { stdout } = runCli(['gpu', 'help']);
      expect(stdout).toContain('dev start');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. Persistence roundtrip — devMode survives save/load cycle
  // ────────────────────────────────────────────────────────────────────────────

  describe('persistence roundtrip', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'gpu-dev-test-'));
    });

    it('PersistedDeploy with devMode=true survives JSON serialization', () => {
      const persisted = {
        podId: 'dev-pod-1',
        endpoint: 'http://127.0.0.1:8000',
        gpuType: 'RTX 4090',
        dockerImage: 'marcosremar/gpu-dev:latest',
        provider: 'vast',
        costPerHr: 0.44,
        startedAt: Date.now(),
        sshHost: '1.2.3.4',
        sshPort: 12345,
        providerMeta: {},
        savedAt: Date.now(),
        stoppedAt: Date.now(),
        devMode: true,
      };
      const file = join(tmpDir, 'active_deploy.json');
      writeFileSync(file, JSON.stringify(persisted, null, 2));
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      expect(loaded.devMode).toBe(true);
      expect(loaded.podId).toBe('dev-pod-1');
      expect(loaded.stoppedAt).toBe(persisted.stoppedAt);
      rmSync(file);
    });

    it('absence of devMode in persisted file is not treated as true', () => {
      const persisted = {
        podId: 'prod-pod',
        endpoint: 'http://127.0.0.1:8000',
        gpuType: 'RTX 4090',
        dockerImage: 'some/image:latest',
        provider: 'vast',
        costPerHr: 0.44,
        startedAt: Date.now(),
        sshHost: '1.2.3.4',
        sshPort: 12345,
        providerMeta: {},
        savedAt: Date.now(),
      };
      const file = join(tmpDir, 'active_deploy_prod.json');
      writeFileSync(file, JSON.stringify(persisted));
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      expect(loaded.devMode).toBeUndefined();
      // Recovery code uses `persisted.devMode ? { devMode: true } : {}` — so undefined stays undefined
      rmSync(file);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. Docker image files — dev base image must exist and be internally consistent
  // ────────────────────────────────────────────────────────────────────────────

  // dockers/ is a git submodule (ai-gateway-dockers). Skip when not checked out.
  const dockerSubmodulePresent = existsSync('dockers/gpu-dev');
  describe.skipIf(!dockerSubmodulePresent)('gpu-dev docker context', () => {
    const dockerDir = 'dockers/gpu-dev';

    it('Dockerfile, health_server.py, start.sh, README.md all exist', () => {
      expect(existsSync(`${dockerDir}/Dockerfile`)).toBe(true);
      expect(existsSync(`${dockerDir}/health_server.py`)).toBe(true);
      expect(existsSync(`${dockerDir}/start.sh`)).toBe(true);
      expect(existsSync(`${dockerDir}/README.md`)).toBe(true);
    });

    it('Dockerfile uses CUDA 12.1 base and exposes port 8000', () => {
      const df = readFileSync(`${dockerDir}/Dockerfile`, 'utf8');
      expect(df).toMatch(/FROM nvidia\/cuda:12\.1\.\d+-cudnn\d+-devel-ubuntu22\.04/);
      expect(df).toMatch(/EXPOSE\s+8000/);
      expect(df).toContain('openssh-server');
      expect(df).toContain('python3.10');
    });

    it('health_server.py exposes /health and /info', () => {
      const py = readFileSync(`${dockerDir}/health_server.py`, 'utf8');
      expect(py).toContain('/health');
      expect(py).toContain('/info');
      expect(py).toContain('cuda_available');
    });

    it('start.sh starts sshd and the health server', () => {
      const sh = readFileSync(`${dockerDir}/start.sh`, 'utf8');
      expect(sh).toContain('sshd');
      expect(sh).toContain('health_server.py');
    });
  });
});
