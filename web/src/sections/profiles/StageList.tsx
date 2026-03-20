'use client';

import React, { useState, useEffect, useRef } from 'react';
import Sortable from 'sortablejs';
import { Plus } from 'lucide-react';
import {
  Card, CardHeader, CardBody, Button, IconBox,
} from '@/components/ui';
import {
  type PipelineChainEntry, type ProfileService,
} from '../provider-types';
import { STAGE_CATALOG, uid, type ProfileStage, type StageCatalogEntry } from './constants';
import { StageRow } from './StageRow';

// ── Stage list with drag-reorder + add/remove ──

function StageList({ stages, setStages, services }: {
  stages: ProfileStage[];
  setStages: React.Dispatch<React.SetStateAction<ProfileStage[]>>;
  services: ProfileService[];
}) {
  const [showAddStage, setShowAddStage] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const sortInst = useRef<Sortable | null>(null);
  const stagesRef = useRef(stages);
  useEffect(() => { stagesRef.current = stages; }, [stages]);

  useEffect(() => {
    const el = sortRef.current;
    if (!el) return;
    if (sortInst.current) sortInst.current.destroy();
    sortInst.current = Sortable.create(el, {
      handle: '.stage-drag-handle',
      animation: 150,
      ghostClass: 'opacity-50',
      onEnd: (evt) => {
        const { oldIndex, newIndex } = evt;
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
        const next = [...stagesRef.current];
        const [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        setStages(next);
      },
    });
    return () => { try { sortInst.current?.destroy(); } catch {} sortInst.current = null; };
  }, [setStages]);

  const updateStageChain = (id: string, chain: PipelineChainEntry[]) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, chain } : s));
  };

  const toggleStage = (id: string) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const removeStage = (id: string) => {
    setStages(prev => prev.filter(s => s.id !== id));
  };

  const updateStageIO = (id: string, field: 'input' | 'output', value: string) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  const addStage = (catalogEntry: StageCatalogEntry) => {
    setStages(prev => [...prev, {
      id: uid(),
      key: catalogEntry.key,
      label: catalogEntry.label,
      chain: [...catalogEntry.defaultChain],
      enabled: true,
      input: catalogEntry.input,
      output: catalogEntry.output,
    }]);
    setShowAddStage(false);
  };

  // Which stage types are available to add (not already present)
  const existingKeys = new Set(stages.map(s => s.key));
  const availableStages = STAGE_CATALOG.filter(s => !existingKeys.has(s.key));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Stages</h3>
          <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            {stages.length} stage{stages.length !== 1 ? 's' : ''} &middot; drag to reorder
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div ref={sortRef} className="space-y-3">
          {stages.map(stage => (
            <div key={stage.id} data-id={stage.id}>
              <StageRow
                stageKey={stage.key}
                label={stage.label}
                input={stage.input || STAGE_CATALOG.find(s => s.key === stage.key)?.input || 'text'}
                output={stage.output || STAGE_CATALOG.find(s => s.key === stage.key)?.output || 'text'}
                onChangeInput={(v) => updateStageIO(stage.id, 'input', v)}
                onChangeOutput={(v) => updateStageIO(stage.id, 'output', v)}
                chain={stage.chain}
                setChain={(c) => updateStageChain(stage.id, c)}
                enabled={stage.enabled}
                onToggle={() => toggleStage(stage.id)}
                onRemove={() => removeStage(stage.id)}
                services={services}
              />
            </div>
          ))}
        </div>

        {/* Add stage */}
        {showAddStage ? (
          <div className="p-3 rounded-xl border border-dashed space-y-2"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
              Add Stage
            </p>
            <div className="flex flex-wrap gap-1.5">
              {availableStages.map(s => (
                <button key={s.key} type="button" onClick={() => addStage(s)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium cursor-pointer transition-all"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = s.color; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}
                >
                  <IconBox icon={s.icon} color={s.color} size="xs" />
                  <div>
                    <span className="font-semibold">{s.label}</span>
                    <span className="ml-1.5 opacity-60">{s.subtitle}</span>
                  </div>
                </button>
              ))}
              {availableStages.length === 0 && (
                <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>All stage types already added</p>
              )}
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowAddStage(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowAddStage(true)}
            className="flex items-center gap-1.5 w-full px-3 py-2 rounded-xl border border-dashed text-xs font-medium cursor-pointer transition-all hover:border-[var(--color-text-muted)]"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <Plus className="w-3.5 h-3.5" /> Add Stage
          </button>
        )}
      </CardBody>
    </Card>
  );
}

export { StageList };
