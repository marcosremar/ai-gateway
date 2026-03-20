'use client';

import { useState, useEffect, useCallback } from 'react';
import { getGpuReputation, type ReputationHost } from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, AlertBanner, Spinner } from '@/components/ui';
import { Shield, ArrowUpDown, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';

type SortKey = 'reputationScore' | 'deployCount' | 'avgBootTimeS' | 'avgLatencyMs' | 'totalCostUsd';

// Tier definitions
interface Tier {
  label: string;
  minScore: number;
  maxScore: number;
  borderColor: string;
  labelColor: string;
  bgColor: string;
  defaultExpanded: boolean;
}

const TIERS: Tier[] = [
  { label: 'Excellent', minScore: 0.9, maxScore: Infinity, borderColor: '#10b981', labelColor: '#34d399', bgColor: 'rgba(16,185,129,0.07)', defaultExpanded: true },
  { label: 'Good',      minScore: 0.7, maxScore: 0.9,      borderColor: '#60a5fa', labelColor: '#93c5fd', bgColor: 'rgba(96,165,250,0.07)',  defaultExpanded: true },
  { label: 'Fair',      minScore: 0.4, maxScore: 0.7,      borderColor: '#f59e0b', labelColor: '#fbbf24', bgColor: 'rgba(245,158,11,0.06)', defaultExpanded: false },
  { label: 'Poor',      minScore: 0,   maxScore: 0.4,      borderColor: '#ef4444', labelColor: '#f87171', bgColor: 'rgba(239,68,68,0.06)',  defaultExpanded: false },
];

const PROVIDERS = ['', 'vast', 'tensordock', 'runpod'] as const;
const PROVIDER_LABELS: Record<string, string> = {
  '': 'All providers',
  vast: 'Vast.ai',
  tensordock: 'TensorDock',
  runpod: 'RunPod',
};

export function ReputationSection() {
  const [hosts, setHosts] = useState<ReputationHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('reputationScore');
  const [sortAsc, setSortAsc] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');

  // Tier collapsed state — keyed by tier label
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const t of TIERS) init[t.label] = !t.defaultExpanded;
    return init;
  });

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

  function toggleTier(label: string) {
    setCollapsed(prev => ({ ...prev, [label]: !prev[label] }));
  }

  // Score → continuous color
  function scoreColor(score: number): string {
    if (score >= 0.9) return '#34d399';
    if (score >= 0.7) return '#60a5fa';
    if (score >= 0.4) return '#fbbf24';
    return '#f87171';
  }

  // Row background tint interpolated by score
  function rowBgTint(score: number): string {
    if (score >= 0.9) return 'rgba(16,185,129,0.04)';
    if (score >= 0.7) return 'rgba(96,165,250,0.04)';
    if (score >= 0.4) return 'rgba(245,158,11,0.04)';
    return 'rgba(239,68,68,0.04)';
  }

  // Sort header button
  function SortTh({ sortKeyVal, label }: { sortKeyVal: SortKey; label: string }) {
    const active = sortKey === sortKeyVal;
    return (
      <th
        className="pb-3 font-medium cursor-pointer select-none whitespace-nowrap"
        style={{ color: active ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}
        onClick={() => toggleSort(sortKeyVal)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          <ArrowUpDown
            className="w-3 h-3 flex-shrink-0"
            style={{ opacity: active ? 1 : 0.4 }}
          />
        </span>
      </th>
    );
  }

  if (error) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            {/* Title */}
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(251,191,36,0.12)' }}
              >
                <Shield className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Host Reputation</h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {hosts.length} host{hosts.length !== 1 ? 's' : ''} tracked
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Segmented provider filter */}
              <div
                className="flex rounded-lg overflow-hidden"
                style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
              >
                {PROVIDERS.map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProviderFilter(p)}
                    className="px-3 py-1.5 text-xs font-medium transition-all cursor-pointer"
                    style={{
                      background: providerFilter === p
                        ? 'color-mix(in srgb, #60a5fa 15%, var(--color-surface-elevated))'
                        : 'transparent',
                      color: providerFilter === p
                        ? '#93c5fd'
                        : 'var(--color-text-muted)',
                      borderRight: p !== 'runpod' ? '1px solid var(--color-border)' : 'none',
                    }}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>

              <Button variant="ghost" size="sm" onClick={load}>
                <RefreshCw className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardBody>
          {loading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : sorted.length === 0 ? (
            <p className="text-center py-8 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No reputation data yet. Deploy a GPU to start tracking.
            </p>
          ) : (
            <div className="space-y-3">
              {/* Sort header row */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs">
                      <th className="pb-3 font-medium pr-4" style={{ color: 'var(--color-text-muted)', minWidth: 120 }}>Host</th>
                      <th className="pb-3 font-medium pr-4" style={{ color: 'var(--color-text-muted)', minWidth: 80 }}>Provider</th>
                      <th className="pb-3 font-medium pr-4" style={{ color: 'var(--color-text-muted)', minWidth: 120 }}>GPU</th>
                      <SortTh sortKeyVal="reputationScore" label="Score" />
                      <th className="pb-3 font-medium pr-4" style={{ color: 'var(--color-text-muted)', minWidth: 160 }}>
                        <span
                          className="inline-flex items-center gap-1 cursor-pointer select-none"
                          onClick={() => toggleSort('deployCount')}
                          style={{ color: sortKey === 'deployCount' ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}
                        >
                          Success Rate <ArrowUpDown className="w-3 h-3" style={{ opacity: sortKey === 'deployCount' ? 1 : 0.4 }} />
                        </span>
                      </th>
                      <SortTh sortKeyVal="avgBootTimeS" label="Boot" />
                      <SortTh sortKeyVal="avgLatencyMs" label="Latency" />
                      <SortTh sortKeyVal="totalCostUsd" label="Cost" />
                    </tr>
                  </thead>
                </table>
              </div>

              {/* Tier groups */}
              {TIERS.map(tier => {
                const tierHosts = sorted.filter(
                  h => h.reputationScore >= tier.minScore && h.reputationScore < tier.maxScore
                );
                if (tierHosts.length === 0) return null;
                const isCollapsed = collapsed[tier.label];

                return (
                  <div key={tier.label} className="rounded-xl overflow-hidden" style={{ border: `1px solid var(--color-border)` }}>
                    {/* Tier header */}
                    <button
                      type="button"
                      onClick={() => toggleTier(tier.label)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-white/[0.02]"
                      style={{
                        background: tier.bgColor,
                        borderLeft: `3px solid ${tier.borderColor}`,
                      }}
                    >
                      {isCollapsed
                        ? <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: tier.labelColor }} />
                        : <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" style={{ color: tier.labelColor }} />
                      }
                      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: tier.labelColor }}>
                        {tier.label}
                      </span>
                      <span
                        className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: `color-mix(in srgb, ${tier.borderColor} 20%, transparent)`, color: tier.labelColor }}
                      >
                        {tierHosts.length}
                      </span>
                    </button>

                    {/* Tier rows */}
                    {!isCollapsed && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <tbody>
                            {tierHosts.map((h, i) => {
                              const successRate = h.deployCount > 0
                                ? (h.successCount / h.deployCount) * 100
                                : 0;
                              const sc = scoreColor(h.reputationScore);

                              return (
                                <tr
                                  key={h.hostKey}
                                  style={{
                                    background: rowBgTint(h.reputationScore),
                                    borderTop: i > 0 ? '1px solid var(--color-border)' : 'none',
                                  }}
                                >
                                  {/* Host */}
                                  <td className="py-3 px-4 font-mono text-xs truncate max-w-[120px]" title={h.hostKey} style={{ color: 'var(--color-text-secondary)', minWidth: 120 }}>
                                    {h.hostKey}
                                  </td>

                                  {/* Provider */}
                                  <td className="py-3 pr-4 text-xs" style={{ color: 'var(--color-text-secondary)', minWidth: 80 }}>
                                    {h.provider}
                                  </td>

                                  {/* GPU */}
                                  <td className="py-3 pr-4 text-xs" style={{ color: 'var(--color-text-muted)', minWidth: 120 }}>
                                    {h.gpuType}
                                  </td>

                                  {/* Score — large and dominant */}
                                  <td className="py-3 pr-6" style={{ minWidth: 70 }}>
                                    <span
                                      className="text-base font-bold font-mono"
                                      style={{ color: sc }}
                                    >
                                      {h.reputationScore.toFixed(2)}
                                    </span>
                                  </td>

                                  {/* Success rate bar */}
                                  <td className="py-3 pr-6" style={{ minWidth: 160 }}>
                                    {h.deployCount > 0 ? (
                                      <div className="flex items-center gap-2">
                                        <div
                                          className="h-2 rounded-full overflow-hidden flex-1"
                                          style={{ background: 'rgba(239,68,68,0.25)', minWidth: 80, maxWidth: 110 }}
                                        >
                                          <div
                                            className="h-full rounded-full transition-all"
                                            style={{
                                              width: `${successRate}%`,
                                              background: successRate >= 90
                                                ? 'linear-gradient(90deg, #10b981, #34d399)'
                                                : successRate >= 70
                                                  ? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
                                                  : successRate >= 40
                                                    ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
                                                    : 'linear-gradient(90deg, #dc2626, #f87171)',
                                            }}
                                          />
                                        </div>
                                        <span
                                          className="text-xs font-mono font-semibold flex-shrink-0"
                                          style={{ color: 'var(--color-text-secondary)', minWidth: 32 }}
                                        >
                                          {successRate.toFixed(0)}%
                                        </span>
                                        <span
                                          className="text-[10px] flex-shrink-0"
                                          style={{ color: 'var(--color-text-muted)' }}
                                        >
                                          ({h.deployCount})
                                        </span>
                                      </div>
                                    ) : (
                                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>—</span>
                                    )}
                                  </td>

                                  {/* Boot time */}
                                  <td className="py-3 pr-6" style={{ minWidth: 70 }}>
                                    <span
                                      className="px-2 py-0.5 rounded-md text-xs font-mono font-medium"
                                      style={{
                                        background: 'var(--color-surface-elevated)',
                                        border: '1px solid var(--color-border)',
                                        color: 'var(--color-text-secondary)',
                                      }}
                                    >
                                      {h.avgBootTimeS.toFixed(0)}s
                                    </span>
                                  </td>

                                  {/* Latency */}
                                  <td className="py-3 pr-6" style={{ minWidth: 80 }}>
                                    <span
                                      className="px-2 py-0.5 rounded-md text-xs font-mono font-medium"
                                      style={{
                                        background: 'var(--color-surface-elevated)',
                                        border: '1px solid var(--color-border)',
                                        color: 'var(--color-text-secondary)',
                                      }}
                                    >
                                      {h.avgLatencyMs.toFixed(0)}ms
                                    </span>
                                  </td>

                                  {/* Cost */}
                                  <td className="py-3 pr-4" style={{ minWidth: 70 }}>
                                    <span
                                      className="text-xs font-mono"
                                      style={{ color: 'var(--color-text-muted)' }}
                                    >
                                      ${h.totalCostUsd.toFixed(2)}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
