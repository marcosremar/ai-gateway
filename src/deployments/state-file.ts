import { copyFile, link, mkdir, open, readFile, rename, unlink } from 'fs/promises';
import { dirname } from 'path';

export class StateFileError extends Error {}

export type StateSource = 'file' | 'backup' | 'none';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function parseOrNull<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a JSON object');
  return value as T;
}

async function restoreFromBackup(path: string): Promise<void> {
  await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
  await copyFile(`${path}.bak`, path);
}

export async function readStateFile<T>(path: string): Promise<{ data: T | null; from: StateSource; problem?: string }> {
  let mainError: unknown = null;
  try {
    const main = await parseOrNull<T>(path);
    if (main) return { data: main, from: 'file' };
  } catch (err) {
    mainError = err;
  }
  let backup: T | null;
  try {
    backup = await parseOrNull<T>(`${path}.bak`);
  } catch (err) {
    throw new StateFileError(`state file ${path} unreadable (${errText(mainError ?? 'missing')}) and its backup too (${errText(err)})`);
  }
  if (backup) {
    await restoreFromBackup(path);
    return { data: backup, from: 'backup', problem: mainError ? errText(mainError) : 'missing' };
  }
  if (mainError) throw new StateFileError(`state file ${path} unreadable (${errText(mainError)}) and no backup`);
  return { data: null, from: 'none' };
}

export async function writeStateFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const backup = `${path}.bak`;
  await unlink(backup).catch(() => {});
  await link(path, backup).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') await copyFile(path, backup);
  });
  await rename(tmp, path);
}
