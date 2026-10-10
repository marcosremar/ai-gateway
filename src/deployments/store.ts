/**
 * Deployment specs, profiles and the network releases still owed after a delete persist as one JSON file (state-file.ts:
 * tmp + fsync + rename, last good copy in `.bak`, writes serialized). On Railway point `DEPLOYMENTS_STATE_DIR` at a mounted volume: the container
 * filesystem is wiped on every deploy.
 *
 * Replicas are NOT stored here — the provider is their source of truth (found by tag).
 */

import { join } from 'path';
import { readStateFile, writeStateFile } from './state-file';
import type { DeploymentRecord, DeploymentStore, PendingNetworkRelease, Profile } from './types';

interface StateFile {
  version: 1;
  deployments: Record<string, DeploymentRecord>;
  profiles: Record<string, Profile>;
  networkReleases: Record<string, PendingNetworkRelease>;
}

const empty = (): StateFile => ({ version: 1, deployments: {}, profiles: {}, networkReleases: {} });

export class MemoryDeploymentStore implements DeploymentStore {
  protected state: StateFile = empty();

  async load() {
    return {
      deployments: Object.values(this.state.deployments), profiles: Object.values(this.state.profiles),
      networkReleases: Object.values(this.state.networkReleases),
    };
  }
  async saveDeployment(record: DeploymentRecord) {
    this.state.deployments[record.spec.name] = structuredClone(record);
    await this.flush();
  }
  async deleteDeployment(name: string, release?: PendingNetworkRelease) {
    delete this.state.deployments[name];
    if (release) this.state.networkReleases[release.network.ipId] = structuredClone(release);
    await this.flush();
  }
  async deleteNetworkRelease(ipId: string) {
    delete this.state.networkReleases[ipId];
    await this.flush();
  }
  async saveProfile(profile: Profile) {
    this.state.profiles[profile.name] = structuredClone(profile);
    await this.flush();
  }
  async deleteProfile(name: string) {
    delete this.state.profiles[name];
    await this.flush();
  }
  protected async flush(): Promise<void> {}
  async settled(): Promise<void> {}
}

export type StateLog = (msg: string, data?: Record<string, unknown>) => void;

export class FileDeploymentStore extends MemoryDeploymentStore {
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();
  fresh = false;
  writeError: string | null = null;

  constructor(private readonly path: string, private readonly log: StateLog = (msg, data) => console.error(msg, data ?? {})) {
    super();
  }

  static inDir(dir: string, log?: StateLog): FileDeploymentStore {
    return new FileDeploymentStore(join(dir, 'deployments.json'), log);
  }

  override async load() {
    if (!this.loaded) {
      const read = await readStateFile<Partial<StateFile>>(this.path);
      if (read.from === 'backup') this.log('deployments: STATE FILE UNREADABLE, recovered from the last good backup', { path: this.path, problem: read.problem });
      const parsed = read.data ?? {};
      this.state = {
        version: 1, deployments: parsed.deployments ?? {}, profiles: parsed.profiles ?? {}, networkReleases: parsed.networkReleases ?? {},
      };
      this.fresh = read.from === 'none';
      this.loaded = true;
    }
    return super.load();
  }

  protected override flush(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.catch(() => {}).then(async () => {
      try {
        await writeStateFile(this.path, snapshot);
        this.writeError = null;
      } catch (err) {
        this.writeError = err instanceof Error ? err.message : String(err);
        this.log('deployments: STATE WRITE FAILED', { path: this.path, error: this.writeError });
        throw err;
      }
    });
    return this.chain;
  }

  override settled(): Promise<void> {
    return this.chain.catch(() => {});
  }
}
