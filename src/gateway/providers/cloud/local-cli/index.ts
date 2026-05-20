// Local-CLI provider factories — codex (OpenAI Codex CLI) and claude (Claude Code).
// Both inherit auth from the user's logged-in CLI session (keychain/OAuth),
// so no API keys are required at the gateway layer.

import { LocalCliLLMProvider } from './local-cli-llm';

const CODEX_BIN = process.env.LOCAL_CODEX_BIN || 'codex';
const CODEX_DEFAULT_MODEL = process.env.LOCAL_CODEX_MODEL || 'gpt-5.5';
const CODEX_DEFAULT_REASONING = process.env.LOCAL_CODEX_REASONING_EFFORT || 'xhigh';
const CODEX_TIMEOUT_MS = Number(process.env.LOCAL_CODEX_TIMEOUT_MS || 180_000);

const CLAUDE_BIN = process.env.LOCAL_CLAUDE_BIN || 'claude';
const CLAUDE_DEFAULT_MODEL = process.env.LOCAL_CLAUDE_MODEL || 'sonnet';
const CLAUDE_DEFAULT_EFFORT = process.env.LOCAL_CLAUDE_EFFORT || 'xhigh';
const CLAUDE_TIMEOUT_MS = Number(process.env.LOCAL_CLAUDE_TIMEOUT_MS || 180_000);

export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const CODEX_MODELS = ['gpt-5.5'] as const;
export const CLAUDE_MODELS = ['sonnet', 'haiku', 'opus'] as const;

// Codex prints a TUI-style transcript:
//
//   --------
//   user
//   <prompt>
//
//   codex
//   <assistant message lines>
//   tokens used
//   <count>
//   <duplicated assistant message>
//
// We carve out the block between the last `^codex$` marker and the trailing
// `^tokens used$` line. The trailing duplicate after the token count is a
// safer fallback when the marker layout drifts across versions.
function parseCodexOutput(stdout: string): string {
  const tokensIdx = stdout.lastIndexOf('\ntokens used\n');
  if (tokensIdx >= 0) {
    const before = stdout.slice(0, tokensIdx);
    const codexIdx = before.lastIndexOf('\ncodex\n');
    if (codexIdx >= 0) return before.slice(codexIdx + '\ncodex\n'.length);
  }
  // Fallback: codex sometimes echoes the final answer as the last non-empty line.
  const lines = stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  return lines[lines.length - 1] ?? stdout;
}

// Claude Code emits a single JSON object on stdout when run with
// `-p --output-format json`. The `result` field carries the assistant text.
function parseClaudeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as { result?: string; is_error?: boolean };
    if (parsed.is_error) throw new Error(`[local-cli:claude] ${parsed.result || 'error'}`);
    return parsed.result ?? '';
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('[local-cli:claude]')) throw err;
    return trimmed;
  }
}

// Aliases exposed in the proxy chat[] map. Each alias encodes
//   `<provider>-<model>[-<reasoning-level>]`
// and the buildArgs function below extracts the level from the alias suffix.
function buildAliases(
  prefix: string,
  models: readonly string[],
  defaultModel: string,
): Record<string, string> {
  const aliases: Record<string, string> = {
    [`${prefix}-local`]: defaultModel,
  };
  for (const m of models) {
    aliases[`${prefix}-${m}`] = m;
    for (const level of REASONING_LEVELS) {
      aliases[`${prefix}-${m}-${level}`] = m;
    }
  }
  return aliases;
}

function effortFromAlias(alias: string, prefix: string, fallback: string): string {
  // alias is one of: `<prefix>-local`, `<prefix>-<model>`, `<prefix>-<model>-<level>`
  if (!alias.startsWith(`${prefix}-`)) return fallback;
  const tail = alias.slice(prefix.length + 1);
  const lastDash = tail.lastIndexOf('-');
  if (lastDash < 0) return fallback;
  const candidate = tail.slice(lastDash + 1);
  return (REASONING_LEVELS as readonly string[]).includes(candidate) ? candidate : fallback;
}

export const codexLocalLLM = new LocalCliLLMProvider({
  providerId: 'local-codex',
  bin: CODEX_BIN,
  defaultModel: CODEX_DEFAULT_MODEL,
  timeoutMs: CODEX_TIMEOUT_MS,
  modelAliases: buildAliases('codex', CODEX_MODELS, CODEX_DEFAULT_MODEL),
  buildArgs: (model, alias) => {
    const effort = effortFromAlias(alias, 'codex', CODEX_DEFAULT_REASONING);
    return [
      'exec',
      '--skip-git-repo-check',
      '--model', model,
      '-c', `model_reasoning_effort="${effort}"`,
      '-',
    ];
  },
  parseOutput: parseCodexOutput,
});

export const claudeLocalLLM = new LocalCliLLMProvider({
  providerId: 'local-claude',
  bin: CLAUDE_BIN,
  defaultModel: CLAUDE_DEFAULT_MODEL,
  timeoutMs: CLAUDE_TIMEOUT_MS,
  modelAliases: buildAliases('claude', CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL),
  buildArgs: (model, alias) => {
    const effort = effortFromAlias(alias, 'claude', CLAUDE_DEFAULT_EFFORT);
    return [
      '-p',
      '--model', model,
      '--effort', effort,
      '--output-format', 'json',
      '--max-turns', '1',
    ];
  },
  parseOutput: parseClaudeOutput,
});

export { LocalCliLLMProvider } from './local-cli-llm';
