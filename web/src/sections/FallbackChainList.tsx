'use client';

import { useState, useEffect, useRef } from 'react';
import Sortable from 'sortablejs';
import { GripVertical, Plus, Trash2, ChevronDown } from 'lucide-react';
import { Button, Toggle } from '@/components/ui';
import { type PipelineChainEntry, PIPELINE_CATALOG } from './provider-types';

interface Accent { iconColor: string; dot: string; }

interface FallbackChainListProps {
  stage: 'stt' | 'llm' | 'tts';
  chain: PipelineChainEntry[];
  setChain: (chain: PipelineChainEntry[]) => void;
  accent: Accent;
}

export default function FallbackChainList({ stage, chain, setChain, accent }: FallbackChainListProps) {
  const [addingFallback, setAddingFallback] = useState(false);
  const [newProvider, setNewProvider] = useState('');
  const [newModel, setNewModel] = useState('');

  const catalog = PIPELINE_CATALOG[stage];
  const providers = catalog.providers;

  const sortableContainerRef = useRef<HTMLDivElement>(null);
  const sortableInstanceRef = useRef<Sortable | null>(null);

  useEffect(() => {
    const el = sortableContainerRef.current;
    if (!el) return;
    if (sortableInstanceRef.current) sortableInstanceRef.current.destroy();
    sortableInstanceRef.current = Sortable.create(el, {
      handle: '.chain-drag-handle',
      animation: 150,
      ghostClass: 'opacity-50',
      onEnd: (evt) => {
        const { oldIndex, newIndex } = evt;
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
        const next = [...chain];
        const [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        setChain(next);
      },
    });
    return () => { try { sortableInstanceRef.current?.destroy(); } catch {} sortableInstanceRef.current = null; };
  }, [chain.length, setChain, chain]);

  const getProviderLabel = (provId: string) => providers.find(p => p.id === provId)?.label || provId;
  const getModelLabel = (provId: string, modelId: string) => {
    const models = (catalog.models as Record<string, { id: string; label: string }[]>)[provId] ?? [];
    return models.find(m => m.id === modelId)?.label || modelId;
  };
  const getModelsForProvider = (provId: string) =>
    (catalog.models as Record<string, { id: string; label: string }[]>)[provId] ?? [];

  const removeEntry = (index: number) => {
    if (chain.length <= 1) return;
    setChain(chain.filter((_, i) => i !== index));
  };

  const toggleEnabled = (index: number) => {
    setChain(chain.map((e, i) => i === index ? { ...e, enabled: !(e.enabled !== false) } : e));
  };

  const handleAddFallback = () => {
    if (!newProvider || !newModel) return;
    setChain([...chain, { provider: newProvider, model: newModel, enabled: true }]);
    setAddingFallback(false);
    setNewProvider('');
    setNewModel('');
  };

  const startAddFallback = () => {
    const existing = new Set(chain.map(e => `${e.provider}::${e.model}`));
    for (const p of providers) {
      for (const m of getModelsForProvider(p.id)) {
        if (!existing.has(`${p.id}::${m.id}`)) {
          setNewProvider(p.id); setNewModel(m.id); setAddingFallback(true); return;
        }
      }
    }
    const first = providers[0];
    if (first) { setNewProvider(first.id); setNewModel(getModelsForProvider(first.id)[0]?.id || ''); }
    setAddingFallback(true);
  };

  return (
    <div>
      {chain.length > 1 && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
            Tries top to bottom
          </span>
          <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        </div>
      )}

      <div ref={sortableContainerRef} className="space-y-0">
        {chain.map((entry, index) => {
          const isPrimary = index === 0;
          const isLast = index === chain.length - 1;
          const isEnabled = entry.enabled !== false;

          return (
            <div key={`${entry.provider}-${entry.model}-${index}`} data-id={index}>
              <div
                className="group flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all relative"
                style={{
                  borderColor: !isEnabled
                    ? 'var(--color-border-light)'
                    : isPrimary
                      ? `color-mix(in srgb, ${accent.dot} 30%, var(--color-border))`
                      : 'var(--color-border)',
                  background: !isEnabled
                    ? 'transparent'
                    : isPrimary
                      ? `color-mix(in srgb, ${accent.dot} 4%, var(--color-surface))`
                      : 'var(--color-surface)',
                  opacity: isEnabled ? 1 : 0.5,
                }}
              >
                {/* Drag */}
                {chain.length > 1 && (
                  <div className="chain-drag-handle cursor-grab active:cursor-grabbing flex-shrink-0 p-0.5 rounded hover:bg-white/5">
                    <GripVertical className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                  </div>
                )}

                {/* Order */}
                <span className="text-[10px] font-bold w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    background: isPrimary && isEnabled
                      ? `color-mix(in srgb, ${accent.dot} 20%, transparent)`
                      : 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
                    color: isPrimary && isEnabled ? accent.dot : 'var(--color-text-muted)',
                  }}>
                  {index + 1}
                </span>

                {/* Role */}
                <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0"
                  style={{ color: isPrimary && isEnabled ? accent.dot : 'var(--color-text-muted)', minWidth: '52px' }}>
                  {isPrimary ? 'Primary' : 'Fallback'}
                </span>

                {/* Provider + Model */}
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-semibold truncate ${!isEnabled ? 'line-through' : ''}`}>
                    {getProviderLabel(entry.provider)}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {getModelLabel(entry.provider, entry.model)}
                  </div>
                </div>

                {/* Enable/Disable toggle */}
                <Toggle checked={isEnabled} onChange={() => toggleEnabled(index)} size="sm" />

                {/* Remove */}
                {chain.length > 1 && (
                  <button type="button" onClick={() => removeEntry(index)}
                    className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded hover:bg-red-500/10 transition-opacity cursor-pointer">
                    <Trash2 className="w-3 h-3 text-red-400" />
                  </button>
                )}
              </div>

              {/* Arrow connector */}
              {!isLast && chain.length > 1 && (
                <div className="flex items-center justify-center py-0.5">
                  <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add fallback */}
      <div className="mt-2">
        {addingFallback ? (
          <div className="flex flex-col gap-1.5 p-2.5 rounded-lg border border-dashed"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] font-medium flex-shrink-0 w-14" style={{ color: 'var(--color-text-muted)' }}>Provider</label>
              <select value={newProvider}
                onChange={(e) => { setNewProvider(e.target.value); setNewModel(getModelsForProvider(e.target.value)[0]?.id || ''); }}
                className="flex-1 rounded-lg border px-2 py-1 text-xs"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}>
                {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] font-medium flex-shrink-0 w-14" style={{ color: 'var(--color-text-muted)' }}>Model</label>
              <select value={newModel} onChange={(e) => setNewModel(e.target.value)}
                className="flex-1 rounded-lg border px-2 py-1 text-xs"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}>
                {getModelsForProvider(newProvider).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5 justify-end">
              <Button variant="outline" size="sm" onClick={() => { setAddingFallback(false); setNewProvider(''); setNewModel(''); }}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleAddFallback} disabled={!newProvider || !newModel}>Add</Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={startAddFallback}
            className="flex items-center gap-1 w-full px-2 py-1.5 rounded-lg border border-dashed text-xs cursor-pointer transition-all hover:border-[var(--color-text-muted)]"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <Plus className="w-3 h-3" /> Add fallback
          </button>
        )}
      </div>
    </div>
  );
}
