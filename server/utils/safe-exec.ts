/**
 * Safe command execution — prevents command injection.
 *
 * Fixes: #387 (command injection), #388 (shell injection), #402 (use execFile)
 *
 * Usage:
 * ```ts
 * import { safeExec, safeExecSync } from './safe-exec';
 *
 * // Instead of: exec(`bash "${script}" "${variant}"`)
 * const result = await safeExec('bash', [script, variant]);
 * ```
 */

import { execFile, execFileSync, type ExecFileOptions } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface SafeExecOptions {
  /** Timeout in ms (default: 30_000) */
  timeoutMs?: number;
  /** Allowed commands (if set, only these can be executed) */
  allowedCommands?: Set<string>;
  /** Max stdout size in bytes (default: 1MB) */
  maxStdoutBytes?: number;
  /** Max stderr size in bytes (default: 1MB) */
  maxStderrBytes?: number;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: NodeJS.ProcessEnv;
  /** Max buffer size in bytes */
  maxBuffer?: number;
  /** Signal to kill child process */
  killSignal?: NodeJS.Signals;
}

const DEFAULT_OPTIONS: Required<SafeExecOptions> = {
  timeoutMs: 30_000,
  allowedCommands: new Set(),
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  cwd: process.cwd(),
  env: process.env,
  maxBuffer: 1024 * 1024,
  killSignal: 'SIGTERM',
};

/**
 * Validate command and arguments for safety.
 */
function validateCommand(
  command: string,
  args: string[],
  options: SafeExecOptions,
): void {
  // Check against allowlist if configured
  if (options.allowedCommands && options.allowedCommands.size > 0) {
    const cmd = command.split('/').pop(); // Get basename
    if (!options.allowedCommands.has(cmd ?? command)) {
      throw new Error(
        `Command '${command}' is not in the allowed list: ${Array.from(options.allowedCommands).join(', ')}`,
      );
    }
  }

  // Validate arguments — reject anything that looks like shell metacharacters
  const dangerousPattern = /[;&|`$(){}!<>\\]/;
  for (const arg of args) {
    if (dangerousPattern.test(arg)) {
      throw new Error(
        `Argument contains potentially dangerous characters: ${arg.slice(0, 50)}...`,
      );
    }
  }
}

/**
 * Execute a command safely with argument validation.
 *
 * @example
 * ```ts
 * const result = await safeExec('bash', ['script.sh', variant]);
 * if (result.exitCode !== 0) {
 *   console.error('Command failed:', result.stderr);
 * }
 * ```
 */
export async function safeExec(
  command: string,
  args: string[] = [],
  options: SafeExecOptions = {},
): Promise<ExecResult> {
  const opts: Required<SafeExecOptions> = { ...DEFAULT_OPTIONS, ...options };

  // Validate before execution
  validateCommand(command, args, opts);

  return new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: opts.maxBuffer,
        timeout: opts.timeoutMs,
        killSignal: opts.killSignal,
      },
      (error, stdout, stderr) => {
        const outStr = Buffer.isBuffer(stdout) ? stdout.toString() : String(stdout ?? '');
        const errStr = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr ?? '');
        const errNode = error as NodeJS.ErrnoException | null;

        resolve({
          stdout: outStr.slice(0, opts.maxStdoutBytes),
          stderr: errStr.slice(0, opts.maxStderrBytes),
          exitCode: errNode?.code != null && typeof errNode.code === 'number' ? errNode.code : 0,
          signal: error?.signal ?? null,
          timedOut: errNode?.code === 'ETIMEOUT',
        });
      },
    );
  });
}

/**
 * Sync version of safeExec.
 *
 * ⚠️ Only use when sync execution is absolutely necessary.
 */
export function safeExecSync(
  command: string,
  args: string[] = [],
  options: SafeExecOptions = {},
): ExecResult {
  const opts: Required<SafeExecOptions> = { ...DEFAULT_OPTIONS, ...options };

  // Validate before execution
  validateCommand(command, args, opts);

  try {
    const stdout = execFileSync(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      maxBuffer: opts.maxBuffer,
      timeout: opts.timeoutMs,
      killSignal: opts.killSignal,
    });

    return {
      stdout: String(stdout).slice(0, opts.maxStdoutBytes),
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  } catch (error: unknown) {
    const err = error as { status?: number; signal?: NodeJS.Signals; code?: string; stdout?: unknown; stderr?: unknown };
    return {
      stdout: String(err.stdout ?? '').slice(0, opts.maxStdoutBytes),
      stderr: String(err.stderr ?? '').slice(0, opts.maxStderrBytes),
      exitCode: typeof err.status === 'number' ? err.status : 1,
      signal: err.signal ?? null,
      timedOut: err.code === 'ETIMEOUT',
    };
  }
}
