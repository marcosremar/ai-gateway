'use client';

import { GripVertical, Trash2, Sparkles } from 'lucide-react';
import { IconBox } from '@/components/ui';
import { PIPELINE_CATALOG, type PipelineChainEntry, type ProfileService } from '../provider-types';
import FallbackChainList from '../FallbackChainList';
import { STAGE_CATALOG, IO_OPTIONS } from './constants';

export interface StageRowProps {
  stageKey: string;
  label: string;
  input: string;
  output: string;
  onChangeInput: (v: string) => void;
  onChangeOutput: (v: string) => void;
  chain: PipelineChainEntry[];
  setChain: (c: PipelineChainEntry[]) => void;
  enabled: boolean;
  onToggle: () => void;
  onRemove: () => void;
  services: ProfileService[];
}

export function StageRow({ stageKey, label, input, output, onChangeInput, onChangeOutput, chain, setChain, enabled, onToggle, onRemove, services }: StageRowProps) {
  const catEntry = STAGE_CATALOG.find(s => s.key === stageKey);
  const color = catEntry?.color ?? '#6b7280';
  const Icon = catEntry?.icon ?? Sparkles;
  const accent = { iconColor: color, dot: color };
  const catalog = (PIPELINE_CATALOG as any)[stageKey];

  return (
    <div
      className="rounded-xl border p-4 transition-all"
      style={{
        borderColor: enabled
          ? `color-mix(in srgb, ${color} 25%, var(--color-border))`
          : 'var(--color-border)',
        background: 'var(--color-surface)',
        opacity: enabled ? 1 : 0.55,
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="stage-drag-handle cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-white/5">
          <GripVertical className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <IconBox icon={Icon} color={color} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{label}</span>
            {catalog?.subtitle && (
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {catalog.subtitle}
              </span>
            )}
            {!catalog && catEntry && (
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {catEntry.subtitle}
              </span>
            )}
            {!enabled && (
              <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded"
                style={{ background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)', color: 'var(--color-text-muted)' }}>
                disabled
              </span>
            )}
          </div>
        </div>
        {/* I/O type pills */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <select value={input} onChange={e => onChangeInput(e.target.value)}
            className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-md border-none cursor-pointer appearance-none text-center"
            style={{ background: 'color-mix(in srgb, #38bdf8 10%, transparent)', color: '#38bdf8', width: 'auto', minWidth: '44px' }}
            title="Input type">
            {IO_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>&rarr;</span>
          <select value={output} onChange={e => onChangeOutput(e.target.value)}
            className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-md border-none cursor-pointer appearance-none text-center"
            style={{ background: 'color-mix(in srgb, #10b981 10%, transparent)', color: '#10b981', width: 'auto', minWidth: '44px' }}
            title="Output type">
            {IO_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="text-[10px] font-medium px-2 py-1 rounded border cursor-pointer transition-all"
          style={{
            borderColor: enabled
              ? `color-mix(in srgb, ${color} 30%, var(--color-border))`
              : 'var(--color-border)',
            color: enabled ? color : 'var(--color-text-muted)',
            background: enabled
              ? `color-mix(in srgb, ${color} 6%, transparent)`
              : 'transparent',
          }}
        >
          {enabled ? 'enabled' : 'disabled'}
        </button>
        <button type="button" onClick={onRemove}
          className="p-1 rounded hover:bg-red-500/10 cursor-pointer transition-colors"
          title="Remove stage">
          <Trash2 className="w-3.5 h-3.5 text-red-400" />
        </button>
      </div>
      {enabled && (
        <FallbackChainList
          stage={stageKey as any}
          chain={chain}
          setChain={setChain}
          accent={accent}
          services={services}
        />
      )}
    </div>
  );
}
