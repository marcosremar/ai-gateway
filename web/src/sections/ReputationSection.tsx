'use client';

import { useState, useEffect, useCallback } from 'react';
import { getGpuReputation, type ReputationHost } from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, AlertBanner, Spinner, FormSelect } from '@/components/ui';
import { Shield, ArrowUpDown, RefreshCw } from 'lucide-react';

type SortKey = 'reputationScore' | 'deployCount' | 'avgBootTimeS' | 'avgLatencyMs' | 'totalCostUsd';

export function ReputationSection() {
  const [hosts, setHosts] = useState<ReputationHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('reputationScore');
  const [sortAsc, setSortAsc] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getGpuReputation(providerFilter || undefined);
      setHosts(data.hosts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reputation data');
    } finally {
      setLoading(false);
    }
  }, [providerFilter]);

  useEffect(() => { load(); }, [load]);

  const sorted = [...hosts].sort((a, b) => {
    const mul = sortAsc ? 1 : -1;
    return ((a[sortKey] as number) - (b[sortKey] as number)) * mul;
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  function scoreColor(score: number): string {
    if (score >= 0.7) return 'text-emerald-400';
    if (score >= 0.4) return 'text-amber-400';
    return 'text-red-400';
  }

  if (error) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield className="w-5 h-5 text-amber-400" />
              <h3 className="font-semibold">Host Reputation</h3>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{hosts.length} hosts</span>
            </div>
            <div className="flex items-center gap-3">
              <FormSelect value={providerFilter} onChange={e => setProviderFilter(e.target.value)} className="!py-1.5 !text-xs">
                <option value="">All providers</option>
                <option value="vast">Vast.ai</option>
                <option value="tensordock">TensorDock</option>
                <option value="runpod">RunPod</option>
              </FormSelect>
              <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="w-3 h-3" /></Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : sorted.length === 0 ? (
            <p className="text-center py-8" style={{ color: 'var(--color-text-muted)' }}>No reputation data yet. Deploy a GPU to start tracking.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <th className="pb-2 font-medium">Host</th>
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium">GPU</th>
                    <th className="pb-2 font-medium cursor-pointer" onClick={() => toggleSort('reputationScore')}>
                      <span className="flex items-center gap-1">Score <ArrowUpDown className="w-3 h-3" /></span>
                    </th>
                    <th className="pb-2 font-medium cursor-pointer" onClick={() => toggleSort('deployCount')}>
                      <span className="flex items-center gap-1">Deploys <ArrowUpDown className="w-3 h-3" /></span>
                    </th>
                    <th className="pb-2 font-medium">Success</th>
                    <th className="pb-2 font-medium cursor-pointer" onClick={() => toggleSort('avgBootTimeS')}>
                      <span className="flex items-center gap-1">Boot <ArrowUpDown className="w-3 h-3" /></span>
                    </th>
                    <th className="pb-2 font-medium cursor-pointer" onClick={() => toggleSort('avgLatencyMs')}>
                      <span className="flex items-center gap-1">Latency <ArrowUpDown className="w-3 h-3" /></span>
                    </th>
                    <th className="pb-2 font-medium cursor-pointer" onClick={() => toggleSort('totalCostUsd')}>
                      <span className="flex items-center gap-1">Cost <ArrowUpDown className="w-3 h-3" /></span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(h => (
                    <tr key={h.hostKey} className="border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                      <td className="py-2 font-mono text-xs truncate max-w-[120px]" title={h.hostKey}>{h.hostKey}</td>
                      <td className="py-2">{h.provider}</td>
                      <td className="py-2 text-xs">{h.gpuType}</td>
                      <td className={`py-2 font-mono font-bold ${scoreColor(h.reputationScore)}`}>{h.reputationScore.toFixed(2)}</td>
                      <td className="py-2 font-mono">{h.deployCount}</td>
                      <td className="py-2 font-mono">{h.deployCount > 0 ? `${((h.successCount / h.deployCount) * 100).toFixed(0)}%` : '-'}</td>
                      <td className="py-2 font-mono">{h.avgBootTimeS.toFixed(0)}s</td>
                      <td className="py-2 font-mono">{h.avgLatencyMs.toFixed(0)}ms</td>
                      <td className="py-2 font-mono">${h.totalCostUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
