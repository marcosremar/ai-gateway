'use client';

import {
  useMemo, useCallback, useState, useEffect, useRef, memo,
  createContext, useContext,
} from 'react';
import {
  ReactFlow, Background,
  Handle, Position, MarkerType,
  useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type NodeProps, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Sortable from 'sortablejs';
import {
  Mic, Bot, Volume2, Headphones, Plus, GripVertical, ChevronDown,
  Cloud, Cpu, Zap, Upload, Type, Radio, Play, Square, X, Loader2,
  Image as ImageIcon,
} from 'lucide-react';
import { PIPELINE_CATALOG, type PipelineChainEntry, type Service } from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import { DropdownList, type DropdownOption } from '@/components/ui';
import { pMeta } from './constants';
import type { StageResult, PipelineStatus, PipelineInput, PipelineRunState } from './usePipelineRunner';

/* ══════════════════════════════════════════════════════════════
   Pipeline Context
   ══════════════════════════════════════════════════════════════ */

interface PipelineCtx {
  status: PipelineStatus;
  activeStage: string | null;
  results: Record<string, StageResult | undefined>;
  totalMs?: number;
  error?: string;
  inputType: string | null;
  onRunPipeline?: (input: PipelineInput) => void;
  onResetPipeline?: () => void;
}

const PipelineContext = createContext<PipelineCtx>({
  status: 'idle',
  activeStage: null,
  results: {},
  inputType: null,
});

/* ══════════════════════════════════════════════════════════════
   Input Types & Data Type Constants
   ══════════════════════════════════════════════════════════════ */

const INPUT_TYPES = [
  { id: 'mic', label: 'Mic', Icon: Mic, color: '#38bdf8' },
  { id: 'upload', label: 'Upload', Icon: Upload, color: '#10b981' },
  { id: 'text', label: 'Text', Icon: Type, color: '#a78bfa' },
  { id: 'image', label: 'Image', Icon: ImageIcon, color: '#ec4899' },
  { id: 'stream', label: 'Stream', Icon: Radio, color: '#f59e0b' },
];

/** Maps input-selector value to output data type carried on the edge */
const INPUT_TYPE_DATA: Record<string, string> = {
  mic: 'audio', upload: 'audio', text: 'text', image: 'image', stream: 'audio',
};

const DATA_TYPE_COLORS: Record<string, string> = {
  audio: '#38bdf8', text: '#a78bfa', vector: '#06b6d4', image: '#ec4899',
};

/** Create a styled edge for the pipeline diagram */
function makeStyledEdge(id: string, source: string, target: string, dataType: string): Edge {
  const color = DATA_TYPE_COLORS[dataType] ?? '#8b949e';
  return {
    id, source, target,
    style: { stroke: color, strokeWidth: 2 },
    label: dataType.toUpperCase(),
    labelStyle: { fontSize: 8, fontWeight: 700, fill: color, letterSpacing: '0.1em' },
    labelBgStyle: { fill: 'var(--color-bg)', fillOpacity: 0.9 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
  };
}

/* ══════════════════════════════════════════════════════════════
   Input Node
   ══════════════════════════════════════════════════════════════ */

const InputNode = memo(({ data }: NodeProps) => {
  const { status: pipelineStatus, onRunPipeline, onResetPipeline } = useContext(PipelineContext);
  const sttEnabled = data.sttEnabled as boolean;
  const onSelectInput = data.onSelectInput as ((type: string) => void) | undefined;

  const [selected, setSelected] = useState('mic');
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [textValue, setTextValue] = useState('');
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const sel = INPUT_TYPES.find(t => t.id === selected) ?? INPUT_TYPES[0];
  const outputDataType = INPUT_TYPE_DATA[selected] ?? 'audio';
  const handleColor = DATA_TYPE_COLORS[outputDataType] ?? sel.color;

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
        streamRef.current?.getTracks().forEach(t => t.stop());
      };
      recorder.start();
      setRecording(true);
      setDuration(0);
      const t0 = Date.now();
      timerRef.current = setInterval(() => setDuration((Date.now() - t0) / 1000), 100);
    } catch (err) { console.error('Mic error:', err); }
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setAudioBlob(file);
    setAudioUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  }, []);

  const handleImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImageBlob(file);
    setImageUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  }, []);

  const clearInput = useCallback(() => {
    setAudioBlob(null); setAudioUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setImageBlob(null); setImageUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setTextValue(''); setDuration(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (imageInputRef.current) imageInputRef.current.value = '';
  }, []);

  const hasInput = selected === 'text' ? textValue.trim().length > 0 : selected === 'image' ? !!imageBlob : !!audioBlob;
  const isAudioWithoutStt = (selected === 'mic' || selected === 'upload') && !sttEnabled && !!audioBlob;
  const isRunning = pipelineStatus === 'running';
  const canRun = hasInput && !isRunning && !recording && !isAudioWithoutStt;

  const handleRun = useCallback(() => {
    if (!onRunPipeline || !canRun) return;
    if (pipelineStatus === 'done' || pipelineStatus === 'error') onResetPipeline?.();
    if (selected === 'text') onRunPipeline({ type: 'text', text: textValue });
    else if (selected === 'image' && imageBlob) onRunPipeline({ type: 'image', blob: imageBlob });
    else if (audioBlob) onRunPipeline({ type: 'audio', blob: audioBlob });
  }, [onRunPipeline, onResetPipeline, canRun, pipelineStatus, selected, textValue, audioBlob, imageBlob]);

  const dropdownOptions: DropdownOption[] = INPUT_TYPES.map(t => ({ key: t.id, label: t.label, icon: t.Icon, iconColor: t.color }));
  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  return (
    <div className="rounded-2xl border-2" style={{ background: `color-mix(in srgb, ${sel.color} 4%, var(--color-bg))`, borderColor: `color-mix(in srgb, ${sel.color} 35%, var(--color-border))`, width: 260, overflow: 'visible' }}>
      <Handle type="source" position={Position.Right} style={{ background: handleColor, width: 10, height: 10, top: 28, border: '2px solid var(--color-bg)' }} />
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: `color-mix(in srgb, ${sel.color} 15%, var(--color-border))` }}>
        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `color-mix(in srgb, ${sel.color} 18%, transparent)` }}><sel.Icon className="w-3.5 h-3.5" style={{ color: sel.color }} /></div>
        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: sel.color }}>Input</span>
        <span className="ml-auto text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${handleColor} 15%, transparent)`, color: handleColor }}>{outputDataType}</span>
      </div>
      <div className="px-3 py-2.5 nodrag nopan">
        <DropdownList options={dropdownOptions} value={selected} onChange={v => { setSelected(v); clearInput(); onSelectInput?.(v); }} accent={sel.color} size="sm" />
      </div>
      <div className="px-3 pb-3 nodrag nopan" style={{ minHeight: 64 }}>
        {selected === 'mic' && !audioBlob && !recording && (<button onClick={startRecording} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold cursor-pointer transition-all" style={{ background: `color-mix(in srgb, ${sel.color} 12%, transparent)`, color: sel.color, border: `1.5px solid color-mix(in srgb, ${sel.color} 30%, transparent)` }}><Mic className="w-4 h-4" /> Record Audio</button>)}
        {selected === 'mic' && recording && (<div className="flex flex-col items-center gap-2"><div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" /><span className="text-xs font-mono font-semibold" style={{ color: 'var(--color-text)' }}>{fmt(duration)}</span></div><button onClick={stopRecording} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold cursor-pointer transition-all" style={{ background: 'color-mix(in srgb, #ef4444 12%, transparent)', color: '#ef4444', border: '1.5px solid color-mix(in srgb, #ef4444 30%, transparent)' }}><Square className="w-3.5 h-3.5" /> Stop</button></div>)}
        {selected === 'mic' && audioBlob && !recording && (<div className="flex flex-col gap-2"><div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--color-text-muted)' }}><Mic className="w-3 h-3" /><span className="font-mono">{fmt(duration)}</span></div><audio controls src={audioUrl!} className="w-full" style={{ height: 32 }} /><button onClick={clearInput} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer" style={{ color: 'var(--color-text-muted)', background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)' }}><X className="w-3 h-3" /> Clear</button></div>)}
        {selected === 'upload' && !audioBlob && (<label className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold cursor-pointer transition-all" style={{ background: `color-mix(in srgb, ${sel.color} 12%, transparent)`, color: sel.color, border: `1.5px dashed color-mix(in srgb, ${sel.color} 40%, transparent)` }}><Upload className="w-4 h-4" /> Choose Audio File<input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFile} /></label>)}
        {selected === 'upload' && audioBlob && (<div className="flex flex-col gap-2"><div className="flex items-center gap-2 text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}><Upload className="w-3 h-3 flex-shrink-0" /><span className="truncate">{(audioBlob as File).name || 'audio file'}</span></div><audio controls src={audioUrl!} className="w-full" style={{ height: 32 }} /><button onClick={clearInput} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer" style={{ color: 'var(--color-text-muted)', background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)' }}><X className="w-3 h-3" /> Clear</button></div>)}
        {selected === 'text' && (<textarea value={textValue} onChange={e => setTextValue(e.target.value)} placeholder="Type or paste text..." rows={3} className="w-full rounded-xl border px-3 py-2.5 text-xs resize-none" style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)', outline: 'none' }} />)}
        {selected === 'image' && !imageBlob && (<label className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold cursor-pointer transition-all" style={{ background: `color-mix(in srgb, ${sel.color} 12%, transparent)`, color: sel.color, border: `1.5px dashed color-mix(in srgb, ${sel.color} 40%, transparent)` }}><ImageIcon className="w-4 h-4" /> Choose Image<input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFile} /></label>)}
        {selected === 'image' && imageBlob && (<div className="flex flex-col gap-2"><img src={imageUrl!} alt="Input" className="w-full rounded-lg object-cover" style={{ maxHeight: 120 }} /><button onClick={clearInput} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer" style={{ color: 'var(--color-text-muted)', background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)' }}><X className="w-3 h-3" /> Clear</button></div>)}
        {selected === 'stream' && (<button disabled className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold opacity-40" style={{ background: `color-mix(in srgb, ${sel.color} 12%, transparent)`, color: sel.color, border: `1.5px solid color-mix(in srgb, ${sel.color} 30%, transparent)` }}><Radio className="w-4 h-4" /> Coming Soon</button>)}
      </div>
      {isAudioWithoutStt && (<div className="px-3 pb-1 text-[9px] text-center" style={{ color: '#f59e0b' }}>STT is disabled — enable it or use text input</div>)}
      <div className="px-3 pb-3 nodrag nopan">
        <button onClick={handleRun} disabled={!canRun && !isRunning} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold cursor-pointer transition-all disabled:opacity-35 disabled:cursor-not-allowed" style={{ background: isRunning ? 'color-mix(in srgb, #ef4444 12%, transparent)' : `color-mix(in srgb, ${sel.color} 15%, var(--color-surface-elevated))`, color: isRunning ? '#ef4444' : sel.color, border: `1.5px solid ${isRunning ? 'color-mix(in srgb, #ef4444 30%, transparent)' : `color-mix(in srgb, ${sel.color} 35%, transparent)`}` }}>
          {isRunning ? (<><Loader2 className="w-4 h-4 animate-spin" /> Running...</>) : (<><Play className="w-4 h-4" /> Run Pipeline</>)}
        </button>
      </div>
    </div>
  );
});
InputNode.displayName = 'InputNode';

/* ══════════════════════════════════════════════════════════════
   Output Node
   ══════════════════════════════════════════════════════════════ */

const OutputNode = memo(({ data }: NodeProps) => {
  const { status, results, totalMs, error } = useContext(PipelineContext);
  const color = (data.color as string) || '#fbbf24';
  const ttsResult = results.tts;
  const llmResult = results.llm;
  const sttResult = results.stt;
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioSrc = ttsResult?.audioBase64 ? `data:${ttsResult.contentType || 'audio/wav'};base64,${ttsResult.audioBase64}` : null;
  const togglePlay = useCallback(() => { const el = audioRef.current; if (!el) return; if (playing) { el.pause(); el.currentTime = 0; setPlaying(false); } else if (audioSrc) { el.src = audioSrc; el.play(); setPlaying(true); } }, [playing, audioSrc]);
  useEffect(() => { if (status !== 'done' && playing) { audioRef.current?.pause(); setPlaying(false); } }, [status, playing]);
  const isDone = status === 'done';
  const isError = status === 'error';
  const inputTypeLabel = (data.inputType as string) || '';
  const inputTypeColor = DATA_TYPE_COLORS[inputTypeLabel] ?? color;

  return (
    <div className="rounded-2xl border-2" style={{ background: `color-mix(in srgb, ${color} 4%, var(--color-bg))`, borderColor: isDone ? color : `color-mix(in srgb, ${color} 25%, var(--color-border))`, width: 260, transition: 'border-color 0.3s, box-shadow 0.3s', boxShadow: isDone ? `0 0 20px color-mix(in srgb, ${color} 20%, transparent)` : 'none' }}>
      <Handle type="target" position={Position.Left} style={{ background: inputTypeColor, width: 10, height: 10, top: 28, border: '2px solid var(--color-bg)' }} />
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: `color-mix(in srgb, ${color} 15%, var(--color-border))` }}>
        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}><Headphones className="w-3.5 h-3.5" style={{ color }} /></div>
        <span className="text-xs font-bold uppercase tracking-widest" style={{ color }}>Output</span>
        {inputTypeLabel && (<span className="ml-auto text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${inputTypeColor} 15%, transparent)`, color: inputTypeColor }}>{inputTypeLabel}</span>)}
      </div>
      <div className="px-3 py-3 nodrag nopan">
        {status === 'idle' && (<div className="text-center py-2"><span className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Run the pipeline to see output</span></div>)}
        {status === 'running' && (<div className="flex items-center justify-center gap-2 py-3"><Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--color-text-muted)' }} /><span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Processing...</span></div>)}
        {isDone && (<div className="flex flex-col gap-2.5">
          {sttResult?.text && (<div><span className="text-[8px] font-bold uppercase tracking-wider" style={{ color: '#38bdf8' }}>Transcription</span><div className="text-[10px] p-2 rounded-lg mt-0.5 leading-relaxed" style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}>{sttResult.text}</div></div>)}
          {llmResult?.text && (<div><span className="text-[8px] font-bold uppercase tracking-wider" style={{ color: '#a78bfa' }}>Translation</span><div className="text-[10px] p-2 rounded-lg mt-0.5 leading-relaxed" style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}>{llmResult.text}</div></div>)}
          {audioSrc && (<button onClick={togglePlay} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold cursor-pointer transition-all" style={{ background: playing ? 'color-mix(in srgb, #ef4444 12%, transparent)' : `color-mix(in srgb, ${color} 12%, transparent)`, color: playing ? '#ef4444' : color, border: `1.5px solid ${playing ? 'color-mix(in srgb, #ef4444 30%, transparent)' : `color-mix(in srgb, ${color} 35%, transparent)`}` }}>{playing ? (<><Square className="w-3.5 h-3.5" /> Stop</>) : (<><Play className="w-4 h-4" /> Play Output</>)}</button>)}
          {!audioSrc && !llmResult?.text && !sttResult?.text && (<div className="text-[10px] text-center py-1" style={{ color: 'var(--color-text-muted)' }}>No output data</div>)}
          {totalMs != null && (<div className="text-[9px] text-center" style={{ color: 'var(--color-text-muted)' }}>Total: <span className="font-mono font-semibold" style={{ color }}>{totalMs}ms</span></div>)}
        </div>)}
        {isError && (<div className="text-[10px] p-2 rounded-lg text-center" style={{ background: 'color-mix(in srgb, #ef4444 8%, transparent)', color: '#ef4444' }}>{error || 'Pipeline failed'}</div>)}
      </div>
      <audio ref={audioRef} onEnded={() => setPlaying(false)} className="hidden" />
    </div>
  );
});
OutputNode.displayName = 'OutputNode';

/* ══════════════════════════════════════════════════════════════
   Provider Item
   ══════════════════════════════════════════════════════════════ */

function ProviderItem({ entry, index, entryLabel, modelLabel, onClick }: { entry: PipelineChainEntry; index: number; entryLabel: string; modelLabel: string | null; onClick?: () => void; }) {
  const [hovered, setHovered] = useState(false);
  const pi = PROVIDER_ICON[entry.provider];
  const provColor = pi?.color ?? pMeta(entry.provider).color;
  const Icon = pi?.icon;
  const isDisabled = entry.enabled === false;
  const isPrimary = index === 0;
  return (
    <div className="flex items-center gap-1.5 rounded-lg border transition-all" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ opacity: isDisabled ? 0.4 : 1, cursor: onClick ? 'pointer' : 'default', background: hovered ? `color-mix(in srgb, ${provColor} 8%, var(--color-surface-elevated))` : 'var(--color-surface-elevated)', borderColor: hovered ? provColor : 'var(--color-border)' }}>
      <div className="drag-handle pl-1.5 py-2 cursor-grab active:cursor-grabbing flex-shrink-0" title="Drag to reorder"><GripVertical className="w-3 h-3 transition-opacity" style={{ color: 'var(--color-text-muted)', opacity: hovered ? 0.9 : 0.35 }} /></div>
      <div className="flex items-center gap-2 pr-2.5 py-1.5 flex-1 min-w-0" onClick={onClick} style={{ borderLeft: `2.5px solid ${isDisabled ? 'var(--color-border)' : isPrimary ? provColor : 'var(--color-border)'}`, paddingLeft: 8 }}>
        {Icon && (<div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0" style={{ background: `color-mix(in srgb, ${provColor} 18%, transparent)` }}><Icon className="w-3 h-3" style={{ color: provColor }} /></div>)}
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[10px] font-semibold truncate" title={entryLabel} style={{ color: isPrimary ? provColor : 'var(--color-text-muted)' }}>{entryLabel}</span>
            {isPrimary
              ? <span className="text-[7px] font-bold uppercase px-1 py-0.5 rounded flex-shrink-0" style={{ background: 'color-mix(in srgb, #10b981 12%, transparent)', color: '#34d399', letterSpacing: '0.05em' }}>1st</span>
              : <span className="text-[7px] font-bold uppercase px-1 py-0.5 rounded flex-shrink-0" style={{ background: 'color-mix(in srgb, #f59e0b 10%, transparent)', color: '#fbbf24', letterSpacing: '0.05em' }}>FB</span>
            }
          </div>
          {modelLabel && (<span className="text-[8px] truncate" title={modelLabel} style={{ color: 'var(--color-text-muted)' }}>{modelLabel}</span>)}
        </div>
        {hovered && onClick && (<ChevronDown className="w-3 h-3 -rotate-90 flex-shrink-0" style={{ color: provColor }} />)}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Stage Node — with type indicators + progressive highlighting
   ══════════════════════════════════════════════════════════════ */

const StageNode = memo(({ data }: NodeProps) => {
  const { status: pipelineStatus, activeStage, results, inputType } = useContext(PipelineContext);
  const [addOpen, setAddOpen] = useState(false);
  const color = (data.color as string) || '#8b5cf6';
  const stageKey = data.stageKey as string;
  const label = data.label as string;
  const sublabel = data.sublabel as string;
  const chain = data.chain as PipelineChainEntry[];
  const enabled = data.enabled !== false;
  const entryLabels = data.entryLabels as string[];
  const modelLabels = data.modelLabels as (string | null)[];
  const onAddService = data.onAddService as ((sk: string, p: string, m: string) => void) | undefined;
  const onReorderChain = data.onReorderChain as ((sk: string, c: PipelineChainEntry[]) => void) | undefined;
  const onClickProvider = data.onClickProvider as ((sk: string, idx: number) => void) | undefined;
  const stageInput = (data.input as string) || 'text';
  const stageOutput = (data.output as string) || 'text';
  const inputColor = DATA_TYPE_COLORS[stageInput] ?? color;
  const outputColor = DATA_TYPE_COLORS[stageOutput] ?? color;
  const StageIcon = stageKey === 'stt' ? Mic : stageKey === 'tts' ? Volume2 : Bot;
  const catalog = PIPELINE_CATALOG[stageKey as keyof typeof PIPELINE_CATALOG];
  const isActive = activeStage === stageKey;
  const stageResult = results[stageKey];
  const isDone = !!stageResult;
  const isSkipped = stageKey === 'stt' && (inputType === 'text' || inputType === 'image') && pipelineStatus !== 'idle';
  const pipelineRunning = pipelineStatus === 'running' || pipelineStatus === 'done' || pipelineStatus === 'error';

  const listRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<Sortable | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !onReorderChain || chain.length < 2) return;
    if (sortRef.current) sortRef.current.destroy();
    sortRef.current = Sortable.create(el, { handle: '.drag-handle', animation: 150, ghostClass: 'opacity-50', onEnd: (evt) => { const { oldIndex, newIndex } = evt; if (oldIndex == null || newIndex == null || oldIndex === newIndex) return; const next = [...chain]; const [moved] = next.splice(oldIndex, 1); next.splice(newIndex, 0, moved); onReorderChain(stageKey, next); } });
    return () => { try { sortRef.current?.destroy(); } catch {} sortRef.current = null; };
  }, [chain.length, stageKey, onReorderChain, chain]);

  const borderColor = isActive ? color : isDone ? `color-mix(in srgb, ${color} 50%, var(--color-border))` : `color-mix(in srgb, ${color} 25%, var(--color-border))`;
  const boxShadow = isActive ? `0 0 20px color-mix(in srgb, ${color} 25%, transparent), 0 0 40px color-mix(in srgb, ${color} 10%, transparent)` : 'none';

  return (
    <div className="rounded-xl border cursor-grab active:cursor-grabbing" style={{ width: data.width as number, overflow: 'visible', background: enabled ? `color-mix(in srgb, ${color} 3%, var(--color-bg))` : 'var(--color-surface)', borderColor, borderTop: `3px solid ${enabled ? color : 'var(--color-border)'}`, opacity: enabled ? 1 : 0.4, boxShadow, transition: 'border-color 0.3s, box-shadow 0.3s' }}>
      <Handle type="target" position={Position.Left} style={{ background: inputColor, width: 10, height: 10, top: 24, border: '2px solid var(--color-bg)' }} />
      <Handle type="source" position={Position.Right} style={{ background: outputColor, width: 10, height: 10, top: 24, border: '2px solid var(--color-bg)' }} />

      {/* Header */}
      <div className="flex items-center justify-center gap-1.5 px-3 py-2.5 border-b" style={{ borderColor: `color-mix(in srgb, ${color} 15%, var(--color-border))` }}>
        <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}><StageIcon className="w-3 h-3" style={{ color }} /></div>
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color, letterSpacing: '0.1em' }}>{label}</span>
        <span className="text-[8px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{sublabel}</span>
      </div>

      {/* Data type indicators */}
      <div className="flex items-center justify-center gap-1.5 px-3 py-1.5">
        <span className="text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `color-mix(in srgb, ${inputColor} 15%, transparent)`, color: inputColor }}>{stageInput}</span>
        <span className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>{'\u2192'}</span>
        <span className="text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `color-mix(in srgb, ${outputColor} 15%, transparent)`, color: outputColor }}>{stageOutput}</span>
      </div>

      {/* Sortable provider list */}
      <div className="px-3 py-2.5" style={{ overflow: 'visible' }}>
        <div ref={listRef} className="flex flex-col gap-1.5" style={{ overflow: 'visible' }}>
          {chain.map((entry, j) => (
            <div key={`${entry.provider}-${entry.model}-${j}`} data-index={j}>
              {j > 0 && (<div className="flex justify-center py-0.5"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 0 L5 7 M2 5 L5 9 L8 5" stroke="var(--color-text-muted)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" /></svg></div>)}
              <ProviderItem entry={entry} index={j} entryLabel={entryLabels[j]} modelLabel={modelLabels[j]} onClick={onClickProvider ? () => onClickProvider(stageKey, j) : undefined} />
            </div>
          ))}
        </div>

        {onAddService && enabled && (
          <div className="pt-1">
            {chain.length > 0 && !addOpen && (<div className="flex justify-center py-0.5"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 0 L5 7 M2 5 L5 9 L8 5" stroke="var(--color-text-muted)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.2" /></svg></div>)}
            {addOpen && (
              <div className="nodrag nopan mb-1 rounded-lg border overflow-hidden" style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
                {[
                  { type: 'cloud', label: 'Cloud API', sub: 'Groq, OpenAI, Deepgram...', color: '#38bdf8', provider: 'groq', Icon: Cloud },
                  { type: 'serverless', label: 'Serverless', sub: 'Modal, Lambda...', color: '#a78bfa', provider: 'modal', Icon: Zap },
                  { type: 'self-hosted', label: 'Self-hosted', sub: 'GPU Pod, Docker...', color: '#f59e0b', provider: 'gpu', Icon: Cpu },
                ].map(opt => {
                  const defaultModel = (catalog?.models as Record<string, { id: string }[]>)?.[opt.provider]?.[0]?.id ?? opt.provider;
                  return (<button key={opt.type} onClick={() => { onAddService(stageKey, opt.provider, defaultModel); setAddOpen(false); }} className="nodrag nopan w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer" onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-muted) 6%, transparent)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}><div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: `color-mix(in srgb, ${opt.color} 12%, transparent)` }}><opt.Icon className="w-3 h-3" style={{ color: opt.color }} /></div><div className="flex flex-col min-w-0"><span className="text-[10px] font-semibold" style={{ color: 'var(--color-text)' }}>{opt.label}</span><span className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>{opt.sub}</span></div></button>);
                })}
              </div>
            )}
            <button onClick={() => setAddOpen(prev => !prev)} className="nodrag nopan w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[10px] font-bold cursor-pointer transition-all" style={{ borderColor: addOpen ? color : `color-mix(in srgb, ${color} 35%, var(--color-border))`, borderStyle: addOpen ? 'solid' : 'dashed', color: addOpen ? color : `color-mix(in srgb, ${color} 80%, var(--color-text-muted))`, background: addOpen ? `color-mix(in srgb, ${color} 8%, transparent)` : `color-mix(in srgb, ${color} 3%, transparent)` }}><Plus className="w-3.5 h-3.5" style={{ transition: 'transform 0.2s', transform: addOpen ? 'rotate(45deg)' : 'none' }} />{addOpen ? 'Close' : 'Add Fallback'}</button>
          </div>
        )}
      </div>

      {/* Pipeline result section */}
      {pipelineRunning && (isActive || isDone || isSkipped) && (
        <div className="px-3 pb-2.5 border-t" style={{ borderColor: `color-mix(in srgb, ${color} 15%, var(--color-border))` }}>
          {isSkipped && !isDone && (<div className="text-[10px] py-2 text-center italic" style={{ color: 'var(--color-text-muted)' }}>Skipped ({inputType} input)</div>)}
          {isActive && !isDone && !isSkipped && (<div className="flex items-center justify-center gap-2 py-2.5"><Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color }} /><span className="text-[10px] font-medium" style={{ color }}>Processing...</span></div>)}
          {isDone && stageResult && (<div className="pt-2">
            {stageResult.text && (<div className="text-[10px] p-2 rounded-lg leading-relaxed" style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}>&ldquo;{stageResult.text}&rdquo;</div>)}
            {stageResult.audioBase64 && (<audio controls className="w-full mt-1.5 nodrag nopan" style={{ height: 28 }} src={`data:${stageResult.contentType || 'audio/wav'};base64,${stageResult.audioBase64}`} />)}
            <div className="flex items-center justify-between mt-1.5"><span className="text-[8px] truncate" style={{ color: 'var(--color-text-muted)' }}>{stageResult.provider}</span><span className="text-[8px] font-mono font-semibold" style={{ color }}>{stageResult.latencyMs}ms</span></div>
          </div>)}
        </div>
      )}
    </div>
  );
});
StageNode.displayName = 'StageNode';

/* ══════════════════════════════════════════════════════════════
   Node types
   ══════════════════════════════════════════════════════════════ */

const IONode = memo(({ data, ...rest }: NodeProps) => {
  if (data.ioType === 'input') return <InputNode data={data} {...rest} />;
  return <OutputNode data={data} {...rest} />;
});
IONode.displayName = 'IONode';

const nodeTypes = { io: IONode, stage: StageNode };

/* ══════════════════════════════════════════════════════════════
   Main Component — Controlled mode with connectable edges
   ══════════════════════════════════════════════════════════════ */

interface ReactFlowDiagramProps {
  sttChain: PipelineChainEntry[];
  llmChain: PipelineChainEntry[];
  ttsChain: PipelineChainEntry[];
  sttEnabled: boolean;
  ttsEnabled: boolean;
  services: Service[];
  onAddService?: (stageKey: string, provider: string, model: string) => void;
  onReorderChain?: (stageKey: string, newChain: PipelineChainEntry[]) => void;
  onClickProvider?: (stageKey: string, entryIdx: number) => void;
  pipelineState?: PipelineRunState;
  onRunPipeline?: (input: PipelineInput) => void;
  onResetPipeline?: () => void;
  onPipelineEdgesChange?: (edges: { source: string; target: string; dataType: string }[]) => void;
  /** Profile ID for persisting node positions to localStorage */
  profileId?: string | null;
}

export function ReactFlowPipelineDiagram({
  sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, services,
  onAddService, onReorderChain, onClickProvider,
  pipelineState, onRunPipeline, onResetPipeline,
  onPipelineEdgesChange, profileId,
}: ReactFlowDiagramProps) {

  const [inputType, setInputType] = useState('mic');
  const handleSelectInput = useCallback((type: string) => { setInputType(type); }, []);

  const gpuService = services.find(s => s.kind === 'container');

  // Stable refs for callbacks
  const onAddServiceRef = useRef(onAddService); onAddServiceRef.current = onAddService;
  const onReorderChainRef = useRef(onReorderChain); onReorderChainRef.current = onReorderChain;
  const onClickProviderRef = useRef(onClickProvider); onClickProviderRef.current = onClickProvider;
  const stableOnAddService = useCallback((sk: string, p: string, m: string) => { onAddServiceRef.current?.(sk, p, m); }, []);
  const stableOnReorderChain = useCallback((sk: string, c: PipelineChainEntry[]) => { onReorderChainRef.current?.(sk, c); }, []);
  const stableOnClickProvider = useCallback((sk: string, idx: number) => { onClickProviderRef.current?.(sk, idx); }, []);

  const getEntryLabel = useCallback((entry: PipelineChainEntry) => {
    if (entry.provider === 'gpu') { const svc = services.find(s => s.kind === 'container' && s.id === entry.model); if (svc) return svc.name; if (gpuService) return gpuService.name; return 'GPU Pod'; }
    return pMeta(entry.provider).label;
  }, [services, gpuService]);

  const getModelLabel = useCallback((stageKey: string, entry: PipelineChainEntry): string | null => {
    const catalog = PIPELINE_CATALOG[stageKey as keyof typeof PIPELINE_CATALOG]; if (!catalog) return null;
    const provModels = (catalog.models as Record<string, { id: string; label: string }[]>)[entry.provider] ?? [];
    const fromCatalog = provModels.find(m => m.id === entry.model)?.label; if (fromCatalog) return fromCatalog;
    if (entry.provider === 'gpu') { const gpuModels = (catalog.models as Record<string, { id: string; label: string }[]>)['gpu'] ?? []; const svc = services.find(s => s.kind === 'container' && s.id === entry.model) ?? gpuService; if (svc) { const mid = stageKey === 'stt' ? svc.sttModel : stageKey === 'llm' ? svc.llmModel : svc.ttsModel; if (mid) return gpuModels.find(m => m.id === mid)?.label ?? mid.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); } }
    return null;
  }, [services, gpuService]);

  // ── Position persistence ──
  const storageKey = profileId ? `babelcast:rf-positions:${profileId}` : null;

  const getSavedPositions = useCallback((): Record<string, { x: number; y: number }> => {
    if (!storageKey) return {};
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const arr = JSON.parse(raw) as Array<{ id: string; position: { x: number; y: number } }>;
      const map: Record<string, { x: number; y: number }> = {};
      for (const entry of arr) map[entry.id] = entry.position;
      return map;
    } catch { return {}; }
  }, [storageKey]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const rfNodesRef = useRef<Node[]>([]);

  const savePositions = useCallback(() => {
    if (!storageKey) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const toSave = rfNodesRef.current.map(n => ({ id: n.id, position: n.position }));
      try { localStorage.setItem(storageKey, JSON.stringify(toSave)); } catch {}
    }, 400);
  }, [storageKey]);

  // ── Build initial nodes + edges from props ──
  const { initialNodes, initialEdges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];
    const stagesDef = [
      { key: 'stt', label: 'STT', sublabel: 'Speech \u2192 Text', chain: sttChain, enabled: sttEnabled, color: '#38bdf8', input: 'audio', output: 'text' },
      { key: 'llm', label: 'LLM', sublabel: 'Translation',       chain: llmChain, enabled: true,       color: '#a78bfa', input: 'text',  output: 'text' },
      { key: 'tts', label: 'TTS', sublabel: 'Text \u2192 Speech', chain: ttsChain, enabled: ttsEnabled, color: '#fbbf24', input: 'text',  output: 'audio' },
    ];
    const enabledStages = stagesDef.filter(s => s.enabled);
    const inputW = 260, stageW = 260, stageGap = 80, inputGap = 60;
    const startX = inputW + inputGap;
    const outputDataType = INPUT_TYPE_DATA[inputType] ?? 'audio';

    const inputNode: Node = { id: 'input', type: 'io', position: { x: 0, y: 20 }, data: { ioType: 'input', sttEnabled, onSelectInput: handleSelectInput, outputType: outputDataType }, draggable: true };

    enabledStages.forEach((stage, i) => {
      n.push({ id: `stage-${stage.key}`, type: 'stage', position: { x: startX + i * (stageW + stageGap), y: 10 }, data: { ...stage, stageKey: stage.key, width: stageW, entryLabels: stage.chain.map(ce => getEntryLabel(ce)), modelLabels: stage.chain.map(ce => getModelLabel(stage.key, ce)), services, onAddService: stableOnAddService, onReorderChain: stableOnReorderChain, onClickProvider: stableOnClickProvider }, draggable: true });
    });

    // Build edges based on type compatibility
    let prevId = 'input';
    let prevType = outputDataType;
    for (const stage of enabledStages) {
      if (prevType === stage.input) {
        e.push(makeStyledEdge(`e-${prevId}-stage-${stage.key}`, prevId, `stage-${stage.key}`, stage.input));
        prevId = `stage-${stage.key}`;
        prevType = stage.output;
      }
    }

    const outX = startX + enabledStages.length * (stageW + stageGap) - stageGap + inputGap;
    const outColor = DATA_TYPE_COLORS[prevType] ?? '#fbbf24';
    const outputNode: Node = { id: 'output', type: 'io', position: { x: outX, y: 20 }, data: { ioType: 'output', label: prevType.toUpperCase(), color: outColor, inputType: prevType }, draggable: true };
    e.push(makeStyledEdge('e-last-output', prevId, 'output', prevType));
    n.push(inputNode, outputNode);

    // Apply saved positions from localStorage
    const saved = getSavedPositions();
    if (Object.keys(saved).length > 0) {
      for (const node of n) {
        const pos = saved[node.id];
        if (pos) node.position = pos;
      }
    }

    return { initialNodes: n, initialEdges: e };
  }, [sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, inputType, getEntryLabel, getModelLabel, services, handleSelectInput, stableOnAddService, stableOnReorderChain, stableOnClickProvider, getSavedPositions]);

  // ── Controlled React Flow state ──
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(initialNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Keep ref in sync for debounced save
  rfNodesRef.current = rfNodes;

  // Save positions on drag (wraps onNodesChange)
  const handleNodesChangeWithSave = useCallback((changes: import('@xyflow/react').NodeChange[]) => {
    onNodesChange(changes);
    if (changes.some(c => c.type === 'position' && !('dragging' in c && c.dragging))) {
      savePositions();
    }
  }, [onNodesChange, savePositions]);

  const dataKey = [sttChain.map(c => c.provider + c.model + (c.enabled === false ? 'off' : '')).join(','), llmChain.map(c => c.provider + c.model + (c.enabled === false ? 'off' : '')).join(','), ttsChain.map(c => c.provider + c.model + (c.enabled === false ? 'off' : '')).join(','), inputType, sttEnabled, ttsEnabled].join('|');
  const prevDataKey = useRef(dataKey);
  useEffect(() => { if (prevDataKey.current !== dataKey) { setRfNodes(initialNodes); setRfEdges(initialEdges); prevDataKey.current = dataKey; } }, [dataKey, initialNodes, initialEdges, setRfNodes, setRfEdges]);

  // ── Connection validation ──
  const isValidConnection = useCallback((conn: Connection | Edge) => {
    const tgt = rfNodes.find(nd => nd.id === conn.target);
    if (!tgt) return false;
    if (tgt.data.ioType === 'output') return true;
    const src = rfNodes.find(nd => nd.id === conn.source);
    if (!src) return false;
    const srcOut = (src.data.outputType as string) ?? (src.data.output as string) ?? 'text';
    const tgtIn = (tgt.data.input as string) ?? 'text';
    return srcOut === tgtIn;
  }, [rfNodes]);

  // ── Handle new connection ──
  const handleConnect = useCallback((conn: Connection) => {
    const src = rfNodes.find(nd => nd.id === conn.source);
    const dataType = (src?.data.outputType as string) ?? (src?.data.output as string) ?? 'text';
    const newEdge = makeStyledEdge(`e-${conn.source}-${conn.target}`, conn.source!, conn.target!, dataType);
    setRfEdges(eds => { const filtered = eds.filter(ed => ed.source !== conn.source && ed.target !== conn.target); return addEdge(newEdge, filtered); });
  }, [rfNodes, setRfEdges]);

  const onPipelineEdgesChangeRef = useRef(onPipelineEdgesChange); onPipelineEdgesChangeRef.current = onPipelineEdgesChange;
  const handleEdgesDelete = useCallback((_deleted: Edge[]) => {
    if (!onPipelineEdgesChangeRef.current) return;
    onPipelineEdgesChangeRef.current(rfEdges.map(ed => ({ source: ed.source, target: ed.target, dataType: (ed.label?.toString().toLowerCase()) ?? 'text' })));
  }, [rfEdges]);

  const pipelineCtx = useMemo<PipelineCtx>(() => ({ status: pipelineState?.status ?? 'idle', activeStage: pipelineState?.activeStage ?? null, results: pipelineState?.results ?? {}, totalMs: pipelineState?.totalMs, error: pipelineState?.error, inputType: pipelineState?.inputType ?? null, onRunPipeline, onResetPipeline }), [pipelineState, onRunPipeline, onResetPipeline]);

  return (
    <PipelineContext.Provider value={pipelineCtx}>
      <div style={{ background: 'var(--color-surface)', width: '100%', height: '100%', overflow: 'hidden' }}>
        <style>{`.react-flow .react-flow__handle{transition:box-shadow .15s ease,transform .15s ease;cursor:crosshair}.react-flow .react-flow__handle:hover{transform:scale(1.4);box-shadow:0 0 8px 2px rgba(255,255,255,.25)}.react-flow__edge{cursor:pointer}.react-flow__edge.selected .react-flow__edge-path{stroke-width:3!important;filter:drop-shadow(0 0 6px currentColor)}.react-flow__connection-path{stroke-width:2.5}`}</style>
        <ReactFlow
          nodes={rfNodes} edges={rfEdges}
          onNodesChange={handleNodesChangeWithSave} onEdgesChange={onEdgesChange}
          onConnect={handleConnect} onEdgesDelete={handleEdgesDelete}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 10, y: 10, zoom: 1 }}
          minZoom={0.5} maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={true} nodesConnectable={true}
          elementsSelectable={true} edgesFocusable={true} nodesFocusable={false}
          deleteKeyCode="Backspace"
          panOnDrag panOnScroll zoomOnScroll zoomOnPinch
          zoomOnDoubleClick={false} preventScrolling
        >
          <Background color="var(--color-border)" gap={30} size={2} />
        </ReactFlow>
      </div>
    </PipelineContext.Provider>
  );
}
