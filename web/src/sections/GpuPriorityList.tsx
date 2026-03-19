'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Sortable from 'sortablejs';
import { GripVertical, X, Loader2, RefreshCw, Search } from 'lucide-react';
import { getGpuTypes, type GpuTypeInfo } from '@/lib/gateway';

interface GpuPriorityListProps {
  providerId:   string;
  providerColor: string;
  gpuList:      string[];
  onChange:     (list: string[]) => void;
}

function shortGpu(name: string) {
  return name.replace('NVIDIA ', '').replace('GeForce ', '');
}

function latencyColor(ms: number | null): string {
  if (ms === null) return 'var(--color-text-muted)';
  if (ms <= 30)  return '#10b981';
  if (ms <= 70)  return '#f59e0b';
  return '#ef4444';
}

export default function GpuPriorityList({ providerId, providerColor, gpuList, onChange }: GpuPriorityListProps) {
  const [available, setAvailable]   = useState<GpuTypeInfo[]>([]);
  const [loading, setLoading]       = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const sortableRef  = useRef<HTMLDivElement>(null);
  const sortableInst = useRef<Sortable | null>(null);
  const searchRef    = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Fetch available GPU types from the provider's API
  const fetchTypes = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await getGpuTypes(providerId);
      setAvailable(data.gpuTypes);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void fetchTypes(); }, [fetchTypes]);

  // SortableJS drag-and-drop
  useEffect(() => {
    const el = sortableRef.current;
    if (!el) return;
    sortableInst.current?.destroy();
    sortableInst.current = Sortable.create(el, {
      handle: '.gpu-drag-handle',
      animation: 150,
      ghostClass: 'opacity-40',
      onEnd: evt => {
        const { oldIndex, newIndex } = evt;
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
        const next = [...gpuList];
        const [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        onChange(next);
      },
    });
    return () => { try { sortableInst.current?.destroy(); } catch {} sortableInst.current = null; };
  }, [gpuList, onChange]);

  function removeGpu(idx: number) {
    onChange(gpuList.filter((_, i) => i !== idx));
  }

  // Build the "add GPU" options: types from provider API not yet in the list, filtered by search
  const addOptions = available.filter(g => !gpuList.includes(g.name));
  const filteredOptions = searchQuery.trim()
    ? addOptions.filter(g =>
        g.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        g.shortName.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : addOptions;

  function addGpuFromSearch(name: string) {
    if (!name || gpuList.includes(name)) return;
    onChange([...gpuList, name]);
    setSearchQuery('');
    setShowDropdown(false);
  }

  // Enrich list items with latency data
  const latencyMap = new Map(available.map(g => [g.name, g]));

  return (
    <div className="space-y-1">
      {/* List */}
      <div ref={sortableRef} className="space-y-0.5">
        {gpuList.map((gpu, idx) => {
          const info = latencyMap.get(gpu);
          const isPrimary = idx === 0;
          return (
            <div key={gpu} data-id={idx}>
              <div
                className="group flex items-center gap-2 px-2.5 py-2 rounded-lg border text-xs"
                style={{
                  borderColor: isPrimary
                    ? `color-mix(in srgb, ${providerColor} 35%, var(--color-border))`
                    : 'var(--color-border)',
                  background: isPrimary
                    ? `color-mix(in srgb, ${providerColor} 5%, var(--color-surface))`
                    : 'var(--color-surface)',
                }}
              >
                {/* Drag handle */}
                <div className="gpu-drag-handle cursor-grab active:cursor-grabbing flex-shrink-0 p-0.5 rounded hover:bg-white/5">
                  <GripVertical className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                </div>

                {/* Rank */}
                <span
                  className="text-[10px] font-bold w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    background: isPrimary
                      ? `color-mix(in srgb, ${providerColor} 20%, transparent)`
                      : 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
                    color: isPrimary ? providerColor : 'var(--color-text-muted)',
                  }}
                >
                  {idx + 1}
                </span>

                {/* GPU name */}
                <span className="flex-1 font-mono">{shortGpu(gpu)}</span>

                {/* VRAM */}
                {info?.vram != null && info.vram > 0 && (
                  <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {info.vram}GB
                  </span>
                )}

                {/* Latency badge */}
                {info?.bestLatencyMs != null ? (
                  <span
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{
                      background: `color-mix(in srgb, ${latencyColor(info.bestLatencyMs)} 12%, transparent)`,
                      color: latencyColor(info.bestLatencyMs),
                    }}
                    title={info.bestRegion ?? undefined}
                  >
                    {info.bestLatencyMs}ms
                  </span>
                ) : (
                  <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>—</span>
                )}

                {/* Region (truncated) */}
                {info?.bestRegion && (
                  <span
                    className="text-[10px] hidden sm:block truncate max-w-[80px] flex-shrink-0"
                    style={{ color: 'var(--color-text-muted)' }}
                    title={info.bestRegion}
                  >
                    {info.bestRegion.split(',')[0]}
                  </span>
                )}

                {/* Price */}
                {info?.minPricePerHr != null && info.minPricePerHr > 0 && (
                  <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    ${info.minPricePerHr.toFixed(2)}/h
                  </span>
                )}

                {/* Remove */}
                <button
                  onClick={() => removeGpu(idx)}
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded hover:bg-red-500/10 transition-opacity cursor-pointer"
                >
                  <X className="w-3 h-3 text-red-400" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add GPU — searchable */}
      <div className="pt-1">
        {loading ? (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <Loader2 className="w-3 h-3 animate-spin" /> Loading GPUs…
          </div>
        ) : fetchError ? (
          <div className="flex items-center gap-1.5 text-[10px]" style={{ color: '#ef4444' }}>
            {fetchError}
            <button onClick={fetchTypes} className="hover:opacity-70 cursor-pointer"><RefreshCw className="w-3 h-3" /></button>
          </div>
        ) : (
          <div ref={searchRef} className="relative">
            {/* Search input */}
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" style={{ color: 'var(--color-text-muted)' }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setShowDropdown(true); }}
                  onFocus={() => setShowDropdown(true)}
                  placeholder={`Search ${addOptions.length} available GPUs…`}
                  className="w-full rounded-lg border text-xs pl-6 pr-2 py-1.5 outline-none"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                />
              </div>
              <button
                onClick={fetchTypes}
                className="p-1.5 rounded-lg border cursor-pointer hover:opacity-70 flex-shrink-0"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                title="Refresh available GPUs"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>

            {/* Dropdown */}
            {showDropdown && filteredOptions.length > 0 && (
              <div
                className="absolute top-full left-0 right-6 z-50 mt-0.5 rounded-lg border overflow-hidden overflow-y-auto max-h-48 shadow-lg"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
              >
                {filteredOptions.map(g => (
                  <button
                    key={g.name}
                    onMouseDown={e => { e.preventDefault(); addGpuFromSearch(g.name); }}
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-xs hover:opacity-80 cursor-pointer border-b last:border-b-0 text-left"
                    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  >
                    <span className="flex-1 font-mono">{g.shortName}</span>
                    {g.vram > 0 && (
                      <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{g.vram}GB</span>
                    )}
                    {g.bestLatencyMs != null && (
                      <span
                        className="text-[10px] font-mono px-1 rounded flex-shrink-0"
                        style={{ background: `color-mix(in srgb, ${latencyColor(g.bestLatencyMs)} 12%, transparent)`, color: latencyColor(g.bestLatencyMs) }}
                      >
                        {g.bestLatencyMs}ms
                      </span>
                    )}
                    {g.bestRegion && (
                      <span className="text-[10px] flex-shrink-0 hidden sm:block" style={{ color: 'var(--color-text-muted)' }}>
                        {g.bestRegion.split(',')[0]}
                      </span>
                    )}
                    {(g.minPricePerHr ?? 0) > 0 && (
                      <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                        ${(g.minPricePerHr ?? 0).toFixed(2)}/h
                      </span>
                    )}
                    <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      {g.count} avail
                    </span>
                  </button>
                ))}
              </div>
            )}
            {showDropdown && searchQuery.trim() && filteredOptions.length === 0 && (
              <div
                className="absolute top-full left-0 right-6 z-50 mt-0.5 rounded-lg border px-3 py-2 text-xs"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}
              >
                No GPUs match &ldquo;{searchQuery}&rdquo;
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
