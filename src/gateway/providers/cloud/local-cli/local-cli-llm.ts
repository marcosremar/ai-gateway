// Local-CLI LLM provider: shells out to a local binary (codex, claude) and
// returns its stdout as a chat response. No HTTP — used for routing requests
// to logged-in CLIs that hold their own auth/keychain credentials.

import { spawn, spawnSync } from 'node:child_process';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatMessage,
} from '../types';

export interface LocalCliLLMConfig {
  providerId: string;
  /** Binary to spawn (resolved against PATH unless absolute). */
  bin: string;
  /** Build the argv passed to the binary. Receives the resolved model
   *  (after `modelAliases` lookup) and the original alias the caller used.
   *  Factories use the alias suffix to encode per-call options like
   *  reasoning effort (`codex-gpt-5.5-xhigh`). */
  buildArgs: (model: string, requestedAlias: string) => string[];
  /** Aliases the proxy uses for routing (e.g. `codex-gpt-5.5`) → the real
   *  model name accepted by the CLI binary. The proxy's chat[] map indexes
   *  by alias, but the CLI only knows real names. */
  modelAliases?: Record<string, string>;
  /** Extract the assistant message text from the binary's stdout. */
  parseOutput: (stdout: string) => string;
  defaultModel?: string;
  /** Default per-call timeout (ms). Override via ChatRequest.timeoutMs. */
  timeoutMs?: number;
  /** Extra env merged on top of process.env when spawning. */
  env?: Record<string, string>;
}

function serializeMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((p) => (p.type === 'text' && p.text ? p.text : ''))
              .filter(Boolean)
              .join('\n');
      return `${m.role.toUpperCase()}:\n${text}`;
    })
    .join('\n\n');
}

function runSpawn(
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (err: Error | null, value?: string) => {
      if (finished) return;
      finished = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      err ? reject(err) : resolve(value ?? '');
    };
    const timer = setTimeout(
      () => finish(new Error(`[local-cli:${bin}] timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    proc.stdout.on('data', (d) => { stdout += String(d); });
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      finish(new Error(`[local-cli:${bin}] spawn failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(new Error(`[local-cli:${bin}] exit=${code} stderr=${stderr.slice(0, 600)}`));
      } else {
        finish(null, stdout);
      }
    });
    proc.stdin.end(stdin);
  });
}

export class LocalCliLLMProvider implements LLMProvider {
  readonly providerId: string;
  private readonly cfg: LocalCliLLMConfig;
  private _binResolved: boolean | null = null;

  constructor(cfg: LocalCliLLMConfig) {
    this.cfg = cfg;
    this.providerId = cfg.providerId;
  }

  isConfigured(): boolean {
    if (this._binResolved !== null) return this._binResolved;
    const probe = spawnSync('command', ['-v', this.cfg.bin], { shell: true });
    this._binResolved = probe.status === 0;
    return this._binResolved;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error(
        `[local-cli:${this.cfg.bin}] binary not found in PATH (set LOCAL_${this.providerId.toUpperCase().replace(/-/g, '_')}_BIN to override)`,
      );
    }
    const requested = request.model || this.cfg.defaultModel || '';
    const aliased = this.cfg.modelAliases?.[requested];
    const model = aliased || requested || this.cfg.defaultModel || '';
    const prompt = serializeMessages(request.messages);
    const args = this.cfg.buildArgs(model, requested);
    const timeoutMs = request.timeoutMs ?? this.cfg.timeoutMs ?? 120_000;
    const stdout = await runSpawn(this.cfg.bin, args, prompt, timeoutMs, this.cfg.env ?? {});
    const content = this.cfg.parseOutput(stdout).trim();
    return { content, model };
  }
}
