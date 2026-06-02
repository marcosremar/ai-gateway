import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProjectEnvLoadResult {
  loaded: boolean;
  path?: string;
  keys: string[];
}

export interface ProjectEnvLoadOptions {
  cwd?: string;
  projectRoot?: string;
  envFile?: string;
  override?: boolean;
  preferProjectRoot?: boolean;
}

let loaded = false;
let lastResult: ProjectEnvLoadResult = { loaded: false, keys: [] };

function defaultProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function candidateEnvPaths(options: ProjectEnvLoadOptions): string[] {
  if (options.envFile) return [resolve(options.envFile)];

  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };

  const projectEnvPath = join(resolve(options.projectRoot ?? defaultProjectRoot()), '.env');
  if (options.preferProjectRoot) push(projectEnvPath);

  let dir = resolve(options.cwd ?? process.cwd());
  for (let depth = 0; depth < 8; depth++) {
    push(join(dir, '.env'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  push(projectEnvPath);
  return candidates;
}

function parseEnvLine(line: string): [string, string] | null {
  const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) return null;
  let value = match[2].trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    const comment = value.match(/\s+#/);
    if (comment) value = value.slice(0, comment.index).trimEnd();
  }

  return [match[1], value];
}

export function loadProjectEnv(options: ProjectEnvLoadOptions = {}): ProjectEnvLoadResult {
  if (loaded && !options.envFile && !options.projectRoot && !options.cwd && !options.preferProjectRoot) return lastResult;

  const envPath = candidateEnvPaths(options).find((path) => existsSync(path));
  if (!envPath) {
    lastResult = { loaded: false, keys: [] };
    loaded = true;
    return lastResult;
  }

  const keys: string[] = [];
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (options.override || process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }

  lastResult = { loaded: true, path: envPath, keys };
  loaded = true;
  return lastResult;
}

export function resetProjectEnvLoaderForTests(): void {
  loaded = false;
  lastResult = { loaded: false, keys: [] };
}
