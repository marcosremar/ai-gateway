/**
 * Scaleway network leftovers for the external reaper (`reaper.ts`): reserved IPs and security groups tagged for a
 * namespace (`aigw-ns-<ns>`, plus `aigw-dep-<name>` for an exposed deployment's own IP and firewall, scaleway-backend.ts
 * `ensureNetwork`). A reserved IP bills while it exists, attached or not; a firewall bills nothing but piles up.
 *
 * Read straight from the Instance API (`GET /zones/{zone}/ips`, `/security_groups`, filtered by tag) because the
 * reaper needs what the shared client does not return: which server holds the IP, which servers use the group, and the
 * group's creation date.
 */

import { KNOWN_ZONES } from '../cpu-providers/scaleway-client';
import type { NetworkResource, NetworkSweeper } from './reaper';
import { depTag, nsTag } from './scaleway-backend';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ScwIp { id: string; address?: string; tags?: string[]; server?: { id?: string } | null }
interface ScwGroup { id: string; name?: string; tags?: string[]; servers?: Array<{ id?: string }>; creation_date?: string }

export const SCW_INSTANCE_API = 'https://api.scaleway.com/instance/v1';

const deploymentOf = (tags: string[] | undefined): string | null => {
  const dep = (tags ?? []).find(t => t.startsWith(depTag('')));
  return dep ? dep.slice(depTag('').length) || null : null;
};

export class ScalewayNetworkSweeper implements NetworkSweeper {
  readonly provider = 'scaleway';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly secretKey: string, private readonly opts: {
    projectId?: string; zones?: string[]; fetch?: FetchLike; apiBase?: string;
  } = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { 'X-Auth-Token': this.secretKey }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`scaleway GET ${url.replace(/\?.*$/, '')}: HTTP ${res.status}`);
    return await res.json() as T;
  }

  private zoneUrl(zone: string): string {
    return `${this.opts.apiBase ?? SCW_INSTANCE_API}/zones/${zone}`;
  }

  async listNetwork(namespace: string): Promise<{ resources: NetworkResource[]; errors: string[] }> {
    const tag = nsTag(namespace);
    const query = `tags=${encodeURIComponent(tag)}&per_page=100${this.opts.projectId ? `&project=${encodeURIComponent(this.opts.projectId)}` : ''}`;
    const resources: NetworkResource[] = [];
    const errors: string[] = [];
    await Promise.all((this.opts.zones ?? KNOWN_ZONES).map(async (zone) => {
      try {
        const [{ ips = [] }, { security_groups: groups = [] }] = await Promise.all([
          this.get<{ ips?: ScwIp[] }>(`${this.zoneUrl(zone)}/ips?${query}`),
          this.get<{ security_groups?: ScwGroup[] }>(`${this.zoneUrl(zone)}/security_groups?${query}`),
        ]);
        // The API filter is checked again here: a resource without the namespace tag is never ours to delete.
        for (const ip of ips.filter(i => i.tags?.includes(tag))) {
          resources.push({
            kind: 'ip', id: ip.id, zone, deployment: deploymentOf(ip.tags), inUse: Boolean(ip.server?.id), createdAt: null,
            label: `ip ${ip.address ?? ip.id} (${zone})`,
          });
        }
        for (const g of groups.filter(x => x.tags?.includes(tag))) {
          const created = g.creation_date ? Date.parse(g.creation_date) : NaN;
          resources.push({
            kind: 'security-group', id: g.id, zone, deployment: deploymentOf(g.tags), inUse: (g.servers?.length ?? 0) > 0,
            createdAt: Number.isFinite(created) ? created : null, label: `security group ${g.name ?? g.id} (${zone})`,
          });
        }
      } catch (err) {
        errors.push(`scaleway:${zone}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
    return { resources, errors };
  }

  /** An already-deleted resource (404) counts as done. */
  async releaseNetwork(r: NetworkResource): Promise<void> {
    const path = r.kind === 'ip' ? 'ips' : 'security_groups';
    const res = await this.fetchImpl(`${this.zoneUrl(r.zone)}/${path}/${r.id}`, {
      method: 'DELETE', headers: { 'X-Auth-Token': this.secretKey }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`scaleway DELETE ${path}/${r.id}: HTTP ${res.status}`);
  }
}
