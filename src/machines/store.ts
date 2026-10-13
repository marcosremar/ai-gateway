import { join } from 'path';
import { readStateFile, writeStateFile } from '../deployments/state-file';
import type { JobRecord, MachineRecord } from './types';

export interface MachineState {
  machines: Record<string, MachineRecord>;
  jobs: Record<string, JobRecord>;
}

export class MachineStore {
  private chain: Promise<void> = Promise.resolve();
  writeError: string | null = null;
  recovered: string | null = null;

  constructor(private readonly path: string | null) {}

  static inDir(dir: string): MachineStore {
    return new MachineStore(join(dir, 'machines.json'));
  }

  async load(): Promise<MachineState> {
    if (!this.path) return { machines: {}, jobs: {} };
    const read = await readStateFile<Partial<MachineState>>(this.path);
    if (read.from === 'backup') this.recovered = read.problem ?? 'unreadable';
    return { machines: read.data?.machines ?? {}, jobs: read.data?.jobs ?? {} };
  }

  save(state: MachineState): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const text = JSON.stringify(state, null, 2);
    this.chain = this.chain.catch(() => {}).then(async () => {
      try {
        await writeStateFile(path, text);
        this.writeError = null;
      } catch (err) {
        this.writeError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    });
    return this.chain;
  }

  settled(): Promise<void> {
    return this.chain.catch(() => {});
  }
}
