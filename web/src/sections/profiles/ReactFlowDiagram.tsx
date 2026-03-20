'use client';

import { useMemo, useCallback, useState, useEffect, useRef, memo } from 'react';
import {
  ReactFlow, Background,
  Handle, Position, MarkerType,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Sortable from 'sortablejs';
import { Mic, Bot, Volume2, Headphones, Plus, GripVertical, ChevronDown, Cloud, Cpu, Zap, Upload, Type, Radio } from 'lucide-react';
import { PIPELINE_CATALOG, type PipelineChainEntry, type ProfileService } from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import { pMeta } from './constants';

// ── IO Node (mic / headphones) ──

const INPUT_TYPES = [
  { id: 'mic', label: 'Mic', Icon: Mic, color: '#38bdf8' },
  { id: 'upload', label: 'Upload', Icon: Upload, color: '#10b981' },
  { id: 'text', label: 'Text', Icon: Type, color: '#a78bfa' },
  { id: 'stream', label: 'Stream', Icon: Radio, color: '#f59e0b' },
];

const IONode = memo(({ data }: NodeProps) => {
  const isInput = data.ioType === 'input';
  const color = (data.color as string) || '#38bdf8';
  const [selected, setSelected] = useState('mic');
  const onSelectInput = data.onSelectInput as ((type: string) => void) | undefined;

  if (!isInput) {
    // Output node — simple box
    return (
      <div className="rounded-xl border px-4 py-3 text-center"
        style={{
          background: `color-mix(in srgb, ${color} 3%, var(--color-bg))`,
          borderColor: `color-mix(in srgb, ${color} 25%, var(--color-border))`,
          borderTop: `3px solid ${color}`,
          minWidth: 120,
        }}>
        <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6 }} />
        <div className="flex items-center justify-center gap-1.5 mb-0.5">
          <div className="w-5 h-5 rounded-md flex items-center justify-center"
            style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
            <Headphones className="w-3 h-3" style={{ color }} />
          </div>
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color }}>Output</span>
        </div>
        <span className="text-[8px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{data.label as string}</span>
      </div>
    );
  }

  // Input node — box with selectable input types
  const sel = INPUT_TYPES.find(t => t.id === selected) ?? INPUT_TYPES[0];

  return (
    <div className="rounded-xl border"
      style={{
        background: `color-mix(in srgb, ${sel.color} 3%, var(--color-bg))`,
        borderColor: `color-mix(in srgb, ${sel.color} 25%, var(--color-border))`,
        borderTop: `3px solid ${sel.color}`,
        minWidth: 140,
        overflow: 'visible',
      }}>
      <Handle type="source" position={Position.Right} style={{ background: sel.color, width: 6, height: 6 }} />
      {/* Header */}
      <div className="flex items-center justify-center gap-1.5 px-3 py-2 border-b"
        style={{ borderColor: `color-mix(in srgb, ${sel.color} 15%, var(--color-border))` }}>
        <div className="w-5 h-5 rounded-md flex items-center justify-center"
          style={{ background: `color-mix(in srgb, ${sel.color} 15%, transparent)` }}>
          <sel.Icon className="w-3 h-3" style={{ color: sel.color }} />
        </div>
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: sel.color }}>Input</span>
        <span className="text-[8px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{sel.label}</span>
      </div>
      {/* Input type options */}
      <div className="px-2 py-2 flex flex-col gap-1">
        {INPUT_TYPES.map(t => {
          const active = selected === t.id;
          return (
            <button key={t.id}
              onClick={() => { setSelected(t.id); onSelectInput?.(t.id); }}
              className="nodrag nopan flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all cursor-pointer text-left"
              style={{
                background: active ? `color-mix(in srgb, ${t.color} 10%, transparent)` : 'transparent',
                border: active ? `1px solid ${t.color}` : '1px solid transparent',
              }}>
              <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                style={{ background: `color-mix(in srgb, ${t.color} 15%, transparent)` }}>
                <t.Icon className="w-2.5 h-2.5" style={{ color: active ? t.color : 'var(--color-text-muted)' }} />
              </div>
              <span className="text-[9px] font-semibold" style={{ color: active ? t.color : 'var(--color-text-muted)' }}>
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
IONode.displayName = 'IONode';

// ── Provider Item (rendered inside StageNode's sortable list) ──

function ProviderItem({ entry, index, entryLabel, modelLabel, onClick }: {
  entry: PipelineChainEntry; index: number;
  entryLabel: string; modelLabel: string | null;
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const pi = PROVIDER_ICON[entry.provider];
  const provColor = pi?.color ?? pMeta(entry.provider).color;
  const Icon = pi?.icon;
  const isDisabled = entry.enabled === false;

  return (
    <div
      className="flex items-center gap-1.5 rounded-lg border transition-all"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        opacity: isDisabled ? 0.4 : 1,
        cursor: onClick ? 'pointer' : 'default',
        background: hovered ? `color-mix(in srgb, ${provColor} 8%, var(--color-surface-elevated))` : 'var(--color-surface-elevated)',
        borderColor: hovered ? provColor : 'var(--color-border)',
      }}>
      {/* Drag handle */}
      <div className="drag-handle pl-1.5 py-2 cursor-grab active:cursor-grabbing flex-shrink-0">
        <GripVertical className="w-3 h-3" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
      </div>
      {/* Card content — click opens service settings */}
      <div className="flex items-center gap-2 pr-2.5 py-1.5 flex-1 min-w-0"
        onClick={onClick}
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
        {/* Arrow hint on hover */}
        {hovered && onClick && (
          <ChevronDown className="w-3 h-3 -rotate-90 flex-shrink-0" style={{ color: provColor }} />
        )}
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
  const onAddService = data.onAddService as ((sk: string, p: string, m: string) => void) | undefined;
  const onReorderChain = data.onReorderChain as ((sk: string, c: PipelineChainEntry[]) => void) | undefined;
  const onClickProvider = data.onClickProvider as ((sk: string, idx: number) => void) | undefined;
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
    <div className="rounded-xl border cursor-grab active:cursor-grabbing"
      style={{
        width: data.width as number,
        overflow: 'visible',
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
      <div className="px-3 py-2.5" style={{ overflow: 'visible' }}>
        <div ref={listRef} className="flex flex-col gap-1.5" style={{ overflow: 'visible' }}>
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
                onClick={onClickProvider ? () => onClickProvider(stageKey, j) : undefined}
              />
            </div>
          ))}
        </div>

        {/* Add Fallback button */}
        {onAddService && enabled && (
          <div className="pt-1">
            {chain.length > 0 && !addOpen && (
              <div className="flex justify-center py-0.5">
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M5 0 L5 7 M2 5 L5 9 L8 5" stroke="var(--color-text-muted)" strokeWidth="1.2"
                    fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.2" />
                </svg>
              </div>
            )}
            {/* Service type selector */}
            {addOpen && (
              <div className="nodrag nopan mb-1 rounded-lg border overflow-hidden"
                style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
                {[
                  { type: 'cloud', label: 'Cloud API', sub: 'Groq, OpenAI, Deepgram...', color: '#38bdf8', provider: 'groq', Icon: Cloud },
                  { type: 'serverless', label: 'Serverless', sub: 'Modal, Lambda...', color: '#a78bfa', provider: 'modal', Icon: Zap },
                  { type: 'self-hosted', label: 'Self-hosted', sub: 'GPU Pod, Docker...', color: '#f59e0b', provider: 'gpu', Icon: Cpu },
                ].map(opt => {
                  const defaultModel = (catalog?.models as Record<string, { id: string }[]>)?.[opt.provider]?.[0]?.id ?? opt.provider;
                  return (
                    <button key={opt.type}
                      onClick={() => { onAddService(stageKey, opt.provider, defaultModel); setAddOpen(false); }}
                      className="nodrag nopan w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer"
                      onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-muted) 6%, transparent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
                        style={{ background: `color-mix(in srgb, ${opt.color} 12%, transparent)` }}>
                        <opt.Icon className="w-3 h-3" style={{ color: opt.color }} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--color-text)' }}>{opt.label}</span>
                        <span className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>{opt.sub}</span>
                      </div>
                    </button>
                  );
                })}
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
              {addOpen ? 'Close' : 'Add Service'}
            </button>
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
  onAddService?: (stageKey: string, provider: string, model: string) => void;
  onReorderChain?: (stageKey: string, newChain: PipelineChainEntry[]) => void;
  onClickProvider?: (stageKey: string, entryIdx: number) => void;
}

export function ReactFlowPipelineDiagram({
  sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, services,
  onAddService, onReorderChain, onClickProvider,
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
    const stageGap = 120;
    const ioSize = 50;
    const ioGap = 100;
    const startX = ioSize + ioGap;

    // Input — added last (below) so it renders on top of stage boxes
    const inputNode: Node = {
      id: 'input', type: 'io',
      position: { x: 0, y: 40 },
      data: { ioType: 'input', label: 'AUDIO', color: '#38bdf8' },
      draggable: true,
    };

    enabledStages.forEach((stage, i) => {
      const x = startX + i * (stageW + stageGap);

      n.push({
        id: `stage-${stage.key}`, type: 'stage',
        position: { x, y: 10 },
        data: {
          ...stage, stageKey: stage.key, width: stageW,
          entryLabels: stage.chain.map(e => getEntryLabel(e)),
          modelLabels: stage.chain.map(e => getModelLabel(stage.key, e)),
          services,
          onAddService,
          onReorderChain,
          onClickProvider,
        },
        draggable: true,
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

    const outputNode: Node = {
      id: 'output', type: 'io',
      position: { x: outX, y: 40 },
      data: { ioType: 'output', label: (lastStage?.output ?? 'AUDIO').toUpperCase(), color: outColor },
      draggable: true,
    };

    e.push({
      id: 'e-last-output',
      source: `stage-${lastStage?.key ?? 'tts'}`, target: 'output',
      style: { stroke: outColor, strokeWidth: 1.5 },
      label: (lastStage?.output ?? 'audio').toUpperCase(),
      labelStyle: { fontSize: 8, fontWeight: 700, fill: outColor, letterSpacing: '0.1em' },
      labelBgStyle: { fill: 'var(--color-bg)', fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: outColor, width: 12, height: 12 },
    });

    // Add IO nodes last so they render on top of stage boxes
    n.push(inputNode, outputNode);

    return { nodes: n, edges: e };
  }, [sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, getEntryLabel, getModelLabel, services, onAddService, onReorderChain]);

  const maxChainLen = Math.max(sttChain.length, llmChain.length, ttsChain.length, 1);
  const diagramHeight = Math.max(500, 46 + 14 + maxChainLen * 62 + 60 + 14 + 200);

  // Uncontrolled mode: React Flow manages drag state internally.
  // key={dataKey} forces re-mount only when chain data changes.
  const dataKey = `${sttChain.map(c=>c.provider+c.model+(c.enabled===false?'off':'')).join(',')}-${llmChain.map(c=>c.provider+c.model+(c.enabled===false?'off':'')).join(',')}-${ttsChain.map(c=>c.provider+c.model+(c.enabled===false?'off':'')).join(',')}`;

  return (
    <div className=""
      style={{ background: 'var(--color-surface)', width: '100%', height: 'calc(100vh - 105px)', overflow: 'hidden' }}>
      <ReactFlow
        key={dataKey}
        defaultNodes={nodes}
        defaultEdges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={{ x: 10, y: 10, zoom: 1 }}
        minZoom={1}
        maxZoom={1}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        panOnDrag
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        preventScrolling
      >
        <Background color="var(--color-border)" gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
