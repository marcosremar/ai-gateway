/**
 * FileDeploymentRepository — JSON-file backed implementation of DeploymentRepository.
 *
 * Wraps the existing ~/.babelcast/active_deploy.json persistence with the
 * Clean Architecture entity model. This lets use cases persist Deployment
 * aggregates without knowing about disk I/O.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Deployment, type DeploymentSnapshot } from '../entities/deployment';
import { DeployId } from '../entities/value-objects/deploy-id';
import type { DeploymentRepository } from '../ports/deployment-repository';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');

export class FileDeploymentRepository implements DeploymentRepository {
  async loadActive(): Promise<Deployment | null> {
    if (!existsSync(ACTIVE_DEPLOY_FILE)) return null;
    try {
      const raw = readFileSync(ACTIVE_DEPLOY_FILE, 'utf-8');
      const data = JSON.parse(raw) as DeploymentSnapshot & { id?: string };
      if (!data?.id) return null;
      return Deployment.rehydrate({ ...data, id: DeployId.from(data.id) });
    } catch {
      return null;
    }
  }

  async load(id: DeployId): Promise<Deployment | null> {
    const active = await this.loadActive();
    return active?.id === id ? active : null;
  }

  async save(deployment: Deployment): Promise<void> {
    if (!existsSync(BABELCAST_DIR)) mkdirSync(BABELCAST_DIR, { recursive: true });
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify(deployment.snapshot, null, 2));
  }

  async clearActive(): Promise<void> {
    if (existsSync(ACTIVE_DEPLOY_FILE)) {
      try { unlinkSync(ACTIVE_DEPLOY_FILE); } catch { /* best effort */ }
    }
  }
}
