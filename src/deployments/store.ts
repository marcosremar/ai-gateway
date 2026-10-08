/**
 * Deployment specs, profiles and the network releases still owed after a delete persist as one JSON file (atomic
 * tmp + rename, writes serialized). On Railway point `DEPLOYMENTS_STATE_DIR` at a mounted volume: the container
 * filesystem is wiped on every deploy.
 *
 * Replicas are NOT stored here — the provider is their source of truth (found by tag).
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
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
}

export class FileDeploymentStore extends MemoryDeploymentStore {
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    super();
  }

  static inDir(dir: string): FileDeploymentStore {
    return new FileDeploymentStore(join(dir, 'deployments.json'));
  }

  override async load() {
    if (!this.loaded) {
      try {
        const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StateFile>;
        this.state = {
          version: 1, deployments: parsed.deployments ?? {}, profiles: parsed.profiles ?? {}, networkReleases: parsed.networkReleases ?? {},
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        this.state = empty();
      }
      this.loaded = true;
    }
    return super.load();
  }

  protected override flush(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    // A failed write must not poison every later one: chain on the settled previous write.
    this.chain = this.chain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.chain;
  }
}
