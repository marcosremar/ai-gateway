'use client';

import { useMemo, useCallback, useState, useEffect, useRef, memo } from 'react';
import {
  ReactFlow, Background,
  Handle, Position, MarkerType,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Sortable from 'sortablejs';
import { Mic, Bot, Volume2, Headphones, Plus, GripVertical, ChevronDown } from 'lucide-react';
import { PIPELINE_CATALOG, type PipelineChainEntry, type ProfileService } from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import { pMeta } from './constants';

// ── IO Node (mic / headphones) ──

const IONode = memo(({ data }: NodeProps) => {
  const isInput = data.ioType === 'input';
  const color = (data.color as string) || '#38bdf8';
  const Icon = isInput ? Mic : Headphones;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-10 h-10 rounded-full flex items-center justify-center shadow-md"
        style={{ background: `color-mix(in srgb, ${color} 15%, var(--color-surface-elevated))`, border: `2px solid ${color}` }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color }}>{data.label as string}</span>
      {isInput && <Handle type="source" position={Position.Right} style={{ background: color, width: 6, height: 6 }} />}
      {!isInput && <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6 }} />}
    </div>
  );
});
IONode.displayName = 'IONode';

// ── Provider Item (rendered inside StageNode's sortable list) ──

function ProviderItem({ entry, index, entryLabel, modelLabel }: {
  entry: PipelineChainEntry; index: number;
  entryLabel: string; modelLabel: string | null;
}) {
  const pi = PROVIDER_ICON[entry.provider];
  const provColor = pi?.color ?? pMeta(entry.provider).color;
  const Icon = pi?.icon;
  const isDisabled = entry.enabled === false;

  return (
    <div className="flex items-center gap-1.5 rounded-lg border transition-all"
      style={{ opacity: isDisabled ? 0.4 : 1, background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
      {/* Drag handle */}
      <div className="drag-handle pl-1.5 py-2 cursor-grab active:cursor-grabbing flex-shrink-0">
        <GripVertical className="w-3 h-3" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
      </div>
      {/* Card content */}
      <div className="flex items-center gap-2 pr-2.5 py-1.5 flex-1 min-w-0"
        style={{
          borderLeft: `2.5px solid ${isDisabled ? 'var(--color-border)' : index === 0 ? provColor : 'var(--color-border)'}`,
          paddingLeft: 8,
        }}>
        {Icon && (
          <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
            style={{ background: `color-mix(in srgb, ${provColor} 18%, transparent)` }}>
            <Icon className="w-3 h-3" style={{ color: provColor }} />
          </div>
        )}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[10px] font-semibold truncate" style={{ color: index === 0 ? provColor : 'var(--color-text-muted)' }}>
            {entryLabel}
          </span>
          {modelLabel && (
            <span className="text-[8px] truncate" style={{ color: 'var(--color-text-muted)' }}>
              {modelLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stage Node (group with sortable provider list) ──

const StageNode = memo(({ data }: NodeProps) => {
  const [addOpen, setAddOpen] = useState(false);
  const color = (data.color as string) || '#8b5cf6';
  const stageKey = data.stageKey as string;
  const label = data.label as string;
  const sublabel = data.sublabel as string;
  const chain = data.chain as PipelineChainEntry[];
  const enabled = data.enabled !== false;
  const entryLabels = data.entryLabels as string[];
  const modelLabels = data.modelLabels as (string | null)[];
  const services = data.services as ProfileService[];
  const onAddFallback = data.onAddFallback as ((sk: string, p: string, m: string) => void) | undefined;
  const onReorderChain = data.onReorderChain as ((sk: string, c: PipelineChainEntry[]) => void) | undefined;
  const existingProviders = chain.map(c => c.provider);

  const StageIcon = stageKey === 'stt' ? Mic : stageKey === 'tts' ? Volume2 : Bot;

  const catalog = PIPELINE_CATALOG[stageKey as keyof typeof PIPELINE_CATALOG];
  const availableProviders = catalog?.providers ?? [];

  // Sortable.js for drag-and-drop reorder
  const listRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<Sortable | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !onReorderChain || chain.length < 2) return;
    if (sortRef.current) sortRef.current.destroy();
    sortRef.current = Sortable.create(el, {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'opacity-50',
      onEnd: (evt) => {
        const { oldIndex, newIndex } = evt;
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
        const next = [...chain];
        const [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        onReorderChain(stageKey, next);
      },
    });
    return () => { try { sortRef.current?.destroy(); } catch {} sortRef.current = null; };
  }, [chain.length, stageKey, onReorderChain, chain]);

  return (
    <div className="nodrag nopan rounded-xl border"
      style={{
        width: data.width as number,
        background: enabled ? `color-mix(in srgb, ${color} 3%, var(--color-bg))` : 'var(--color-surface)',
        borderColor: `color-mix(in srgb, ${color} 25%, var(--color-border))`,
        borderTop: `3px solid ${enabled ? color : 'var(--color-border)'}`,
        opacity: enabled ? 1 : 0.4,
      }}>
      <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6, top: 24 }} />
      <Handle type="source" position={Position.Right} style={{ background: color, width: 6, height: 6, top: 24 }} />

      {/* Header */}
      <div className="flex items-center justify-center gap-1.5 px-3 py-2.5 border-b"
        style={{ borderColor: `color-mix(in srgb, ${color} 15%, var(--color-border))` }}>
        <div className="w-5 h-5 rounded-md flex items-center justify-center"
          style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
          <StageIcon className="w-3 h-3" style={{ color }} />
        </div>
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color, letterSpacing: '0.1em' }}>
          {label}
        </span>
        <span className="text-[8px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
          {sublabel}
        </span>
      </div>

      {/* Sortable provider list (sortablejs) */}
      <div className="px-3 py-2.5">
        <div ref={listRef} className="flex flex-col gap-1.5">
          {chain.map((entry, j) => (
            <div key={`${entry.provider}-${entry.model}-${j}`} data-index={j}>
              {j > 0 && (
                <div className="flex justify-center py-0.5">
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M5 0 L5 7 M2 5 L5 9 L8 5" stroke="var(--color-text-muted)" strokeWidth="1.2"
                      fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" />
                  </svg>
                </div>
              )}
              <ProviderItem
                entry={entry} index={j}
                entryLabel={entryLabels[j]} modelLabel={modelLabels[j]}
              />
            </div>
          ))}
        </div>

        {/* Add Fallback button */}
        {onAddFallback && enabled && (
          <div className="pt-1">
            {chain.length > 0 && (
              <div className="flex justify-center py-0.5">
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M5 0 L5 7 M2 5 L5 9 L8 5" stroke="var(--color-text-muted)" strokeWidth="1.2"
                    fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.2" />
                </svg>
              </div>
            )}
            <button
              onClick={() => setAddOpen(prev => !prev)}
              className="nodrag nopan w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-[10px] font-semibold cursor-pointer transition-all"
              style={{
                borderColor: addOpen ? color : `color-mix(in srgb, ${color} 20%, var(--color-border))`,
                borderStyle: addOpen ? 'solid' : 'dashed',
                color: addOpen ? color : 'var(--color-text-muted)',
                background: addOpen ? `color-mix(in srgb, ${color} 6%, transparent)` : 'transparent',
              }}>
              <Plus className="w-3.5 h-3.5" style={{ transition: 'transform 0.2s', transform: addOpen ? 'rotate(45deg)' : 'none' }} />
              {addOpen ? 'Choose provider' : 'Add Fallback'}
            </button>
            {addOpen && (
              <div className="nodrag nopan mt-1.5 rounded-lg border overflow-hidden"
                style={{ background: 'var(--color-surface-elevated)', borderColor: color, boxShadow: `0 4px 16px color-mix(in srgb, ${color} 15%, rgba(0,0,0,0.4))` }}>
                {availableProviders.map(p => {
                  const ppi = PROVIDER_ICON[p.id];
                  const pColor = ppi?.color ?? '#8b949e';
                  const PIcon = ppi?.icon;
                  const already = existingProviders.includes(p.id);
                  const models = (catalog?.models as Record<string, { id: string; label: string }[]>)?.[p.id] ?? [];
                  const defaultModel = models[0]?.id ?? p.id;
                  return (
                    <button key={p.id} disabled={already}
                      onClick={() => { onAddFallback(stageKey, p.id, defaultModel); setAddOpen(false); }}
                      className="nodrag nopan w-full flex items-center gap-2.5 px-3 py-2 text-left text-[10px] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                      style={{ color: already ? 'var(--color-text-muted)' : 'var(--color-text)' }}
                      onMouseEnter={e => { if (!already) e.currentTarget.style.background = `color-mix(in srgb, ${pColor} 10%, transparent)`; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {PIcon && (
                        <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                          style={{ background: `color-mix(in srgb, ${pColor} 15%, transparent)` }}>
                          <PIcon className="w-3 h-3" style={{ color: pColor }} />
                        </div>
                      )}
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="font-semibold" style={{ color: already ? 'var(--color-text-muted)' : pColor }}>{p.label}</span>
                        {models[0] && <span className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>{models[0].label}</span>}
                      </div>
                      {already && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)', color: 'var(--color-text-muted)' }}>
                          added
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
StageNode.displayName = 'StageNode';

// ── Constants ──

const DATA_TYPE_COLORS: Record<string, string> = {
  audio: '#38bdf8', text: '#a78bfa', vector: '#06b6d4',
};

const nodeTypes = { io: IONode, stage: StageNode };

// ── Main Component ──

interface ReactFlowDiagramProps {
  sttChain: PipelineChainEntry[];
  llmChain: PipelineChainEntry[];
  ttsChain: PipelineChainEntry[];
  sttEnabled: boolean;
  ttsEnabled: boolean;
  services: ProfileService[];
  onAddService?: () => void;
  onAddFallback?: (stageKey: string, provider: string, model: string) => void;
  onReorderChain?: (stageKey: string, newChain: PipelineChainEntry[]) => void;
}

export function ReactFlowPipelineDiagram({
  sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, services,
  onAddFallback, onReorderChain,
}: ReactFlowDiagramProps) {

  const gpuService = services.find(s => s.kind === 'gpu-pod');

  const getEntryLabel = useCallback((entry: PipelineChainEntry) => {
    if (entry.provider === 'gpu') {
      const svc = services.find(s => s.kind === 'gpu-pod' && s.id === entry.model);
      if (svc) return svc.name;
      if (gpuService) return gpuService.name;
      return 'GPU Pod';
    }
    return pMeta(entry.provider).label;
  }, [services, gpuService]);

  const getModelLabel = useCallback((stageKey: string, entry: PipelineChainEntry): string | null => {
    const catalog = PIPELINE_CATALOG[stageKey as keyof typeof PIPELINE_CATALOG];
    if (!catalog) return null;
    const provModels = (catalog.models as Record<string, { id: string; label: string }[]>)[entry.provider] ?? [];
    const fromCatalog = provModels.find(m => m.id === entry.model)?.label;
    if (fromCatalog) return fromCatalog;
    if (entry.provider === 'gpu') {
      const gpuModels = (catalog.models as Record<string, { id: string; label: string }[]>)['gpu'] ?? [];
      const svc = services.find(s => s.kind === 'gpu-pod' && s.id === entry.model) ?? gpuService;
      if (svc) {
        const mid = stageKey === 'stt' ? svc.sttModel : stageKey === 'llm' ? svc.llmModel : svc.ttsModel;
        if (mid) return gpuModels.find(m => m.id === mid)?.label ?? mid.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    return null;
  }, [services, gpuService]);

  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];

    const stagesDef = [
      { key: 'stt', label: 'STT', sublabel: 'Speech → Text', chain: sttChain, enabled: sttEnabled, color: '#38bdf8', input: 'audio', output: 'text' },
      { key: 'llm', label: 'LLM', sublabel: 'Translation',   chain: llmChain, enabled: true,       color: '#a78bfa', input: 'text',  output: 'text' },
      { key: 'tts', label: 'TTS', sublabel: 'Text → Speech',  chain: ttsChain, enabled: ttsEnabled, color: '#fbbf24', input: 'text',  output: 'audio' },
    ];

    const enabledStages = stagesDef.filter(s => s.enabled);
    const stageW = 220;
    const stageGap = 80;
    const ioSize = 50;
    const ioGap = 40;
    const startX = ioSize + ioGap;

    // Input
    n.push({
      id: 'input', type: 'io',
      position: { x: 0, y: 80 },
      data: { ioType: 'input', label: 'AUDIO', color: '#38bdf8' },
      draggable: false,
    });

    enabledStages.forEach((stage, i) => {
      const x = startX + i * (stageW + stageGap);

      n.push({
        id: `stage-${stage.key}`, type: 'stage',
        position: { x, y: 0 },
        data: {
          ...stage, stageKey: stage.key, width: stageW,
          entryLabels: stage.chain.map(e => getEntryLabel(e)),
          modelLabels: stage.chain.map(e => getModelLabel(stage.key, e)),
          services,
          onAddFallback,
          onReorderChain,
        },
        draggable: false,
      });

      // Edge from previous
      const prevId = i === 0 ? 'input' : `stage-${enabledStages[i - 1].key}`;
      const edgeColor = DATA_TYPE_COLORS[stage.input] ?? '#8b949e';
      e.push({
        id: `e-${prevId}-${stage.key}`,
        source: prevId, target: `stage-${stage.key}`,
        style: { stroke: edgeColor, strokeWidth: 1.5 },
        label: stage.input.toUpperCase(),
        labelStyle: { fontSize: 8, fontWeight: 700, fill: edgeColor, letterSpacing: '0.1em' },
        labelBgStyle: { fill: 'var(--color-bg)', fillOpacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor, width: 12, height: 12 },
      });
    });

    // Output
    const lastStage = enabledStages[enabledStages.length - 1];
    const outX = startX + enabledStages.length * (stageW + stageGap) - stageGap + ioGap;
    const outColor = DATA_TYPE_COLORS[lastStage?.output ?? 'audio'] ?? '#fbbf24';

    n.push({
      id: 'output', type: 'io',
      position: { x: outX, y: 80 },
      data: { ioType: 'output', label: (lastStage?.output ?? 'AUDIO').toUpperCase(), color: outColor },
      draggable: false,
    });

    e.push({
      id: 'e-last-output',
      source: `stage-${lastStage?.key ?? 'tts'}`, target: 'output',
      style: { stroke: outColor, strokeWidth: 1.5 },
      label: (lastStage?.output ?? 'audio').toUpperCase(),
      labelStyle: { fontSize: 8, fontWeight: 700, fill: outColor, letterSpacing: '0.1em' },
      labelBgStyle: { fill: 'var(--color-bg)', fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: outColor, width: 12, height: 12 },
    });

    return { nodes: n, edges: e };
  }, [sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, getEntryLabel, getModelLabel, services, onAddFallback, onReorderChain]);

  const maxChainLen = Math.max(sttChain.length, llmChain.length, ttsChain.length, 1);
  const diagramHeight = Math.max(300, 46 + 14 + maxChainLen * 62 + 60 + 14 + 80);

  return (
    <div className="rounded-xl border"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', width: '100%', height: `${diagramHeight}px`, overflow: 'visible' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, minZoom: 0.7, maxZoom: 1 }}
        minZoom={0.5}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        selectNodesOnDrag={false}
        nodesFocusable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <Background color="var(--color-border)" gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
