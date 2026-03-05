/** Probe a GPU endpoint's /health to check if it's serving. */
export async function probeGpuHealth(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'healthy';
  } catch {
    return false;
  }
}

/** Probe health via SSH — for providers where HTTP is unreachable (Vast.ai without direct ports). */
export async function probeGpuHealthSsh(sshHost: string, sshPort: number): Promise<boolean> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      '-o', 'BatchMode=yes',
      '-p', String(sshPort),
      `root@${sshHost}`,
      'curl -s http://localhost:8000/health',
    ], { timeout: 10_000 });
    const data = JSON.parse(stdout);
    return data.status === 'healthy';
  } catch {
    return false;
  }
}
