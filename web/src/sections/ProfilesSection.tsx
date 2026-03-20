'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  getProviderConfig, patchProviderConfig, getGpuTypes, deployGpu, terminateGpu, inspectDockerImage, getRequestLog, speechPipeline, benchmarkPaths, type GpuTypeInfo, type DockerManifest, type SpeechTransport, type BenchmarkPathsResponse, type PathOption, type StageBenchResult, type ProviderBenchResult, type PipelineIteration,
} from '@/lib/gateway';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import {
  Card, CardHeader, CardBody, Button, FormSelect, FormInput, SectionHeader,
  IconBox, StatusBadge, Toggle, DropdownList, AlertBanner,
} from '@/components/ui';
import {
  ChevronLeft, Mic, Plus, Check, Trash2,
  Package, Server, Bot, Volume2, Pencil, Clock, Gauge, Timer, Loader2,
  GripVertical, ClipboardCheck, Sparkles, Brain, Play, Square, Cpu, ScanSearch, AlertCircle,
  Upload, Zap, X as XIcon, BarChart3, Trophy, Activity, AlertTriangle,
  TrendingDown, ArrowRight, ChevronDown, Settings2, Cloud, MoreVertical, Eye, EyeOff, MapPin,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Sortable from 'sortablejs';
import {
  DEFAULT_DOCKER_IMAGES, GPU_TYPES, GPU_TYPES_BY_PROVIDER, PIPELINE_CATALOG, GPU_PROVIDERS,
  type PipelineChainEntry, type ProviderProfile,
  type Latency, type ProfileService,
} from './provider-types';
import FallbackChainList, { PROVIDER_ICON } from './FallbackChainList';
import ProfilesPanel from './ProfilesPanel';

const DEFAULT_STT: PipelineChainEntry[] = [{ provider: 'groq', model: 'whisper-large-v3-turbo' }];
const DEFAULT_LLM: PipelineChainEntry[] = [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }];
const DEFAULT_TTS: PipelineChainEntry[] = [{ provider: 'gpu', model: 'qwen3-tts' }];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// ── Stage catalog ──

export interface ProfileStage {
  id: string;
  key: string;          // 'stt' | 'llm' | 'tts' | 'eval' | custom
  label: string;
  chain: PipelineChainEntry[];
  enabled: boolean;
  input?: string;       // 'audio' | 'text' | 'vector' | custom
  output?: string;
}

interface StageCatalogEntry {
  key: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  color: string;
  defaultChain: PipelineChainEntry[];
  input: string;
  output: string;
}

const STAGE_CATALOG: StageCatalogEntry[] = [
  { key: 'stt', label: 'STT', subtitle: 'Speech-to-Text', icon: Mic, color: '#0ea5e9', defaultChain: DEFAULT_STT, input: 'audio', output: 'text' },
  { key: 'llm', label: 'LLM', subtitle: 'Translation', icon: Bot, color: '#8b5cf6', defaultChain: DEFAULT_LLM, input: 'text', output: 'text' },
  { key: 'tts', label: 'TTS', subtitle: 'Text-to-Speech', icon: Volume2, color: '#f59e0b', defaultChain: DEFAULT_TTS, input: 'text', output: 'audio' },
  { key: 'eval', label: 'Eval', subtitle: 'Quality Evaluation', icon: ClipboardCheck, color: '#10b981', defaultChain: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }], input: 'text', output: 'text' },
  { key: 'postprocess', label: 'Post', subtitle: 'Post-processing', icon: Sparkles, color: '#ec4899', defaultChain: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }], input: 'text', output: 'text' },
  { key: 'embedding', label: 'Embed', subtitle: 'Embedding', icon: Brain, color: '#06b6d4', defaultChain: [{ provider: 'openai', model: 'text-embedding-3-small' }], input: 'text', output: 'vector' },
];

const STAGE_ACCENT: Record<string, { color: string; Icon: LucideIcon }> = {};
for (const s of STAGE_CATALOG) STAGE_ACCENT[s.key] = { color: s.color, Icon: s.icon };

/** Default stages for a new profile */
const DEFAULT_STAGES: ProfileStage[] = [
  { id: uid(), key: 'stt', label: 'STT', chain: [...DEFAULT_STT], enabled: true },
  { id: uid(), key: 'llm', label: 'LLM', chain: [...DEFAULT_LLM], enabled: true },
  { id: uid(), key: 'tts', label: 'TTS', chain: [...DEFAULT_TTS], enabled: true },
];

/** Convert legacy stt/llm/tts fields to stages array */
function profileToStages(p: ProviderProfile): ProfileStage[] {
  const stages: ProfileStage[] = [];
  if (p.stt !== undefined) stages.push({ id: uid(), key: 'stt', label: 'STT', chain: p.stt.length ? p.stt : DEFAULT_STT, enabled: true });
  stages.push({ id: uid(), key: 'llm', label: 'LLM', chain: p.llm?.length ? p.llm : DEFAULT_LLM, enabled: true });
  if (p.tts !== undefined) stages.push({ id: uid(), key: 'tts', label: 'TTS', chain: p.tts.length ? p.tts : DEFAULT_TTS, enabled: true });
  // Load custom stages if present
  if ((p as any).customStages) {
    for (const cs of (p as any).customStages) {
      stages.push({ id: uid(), key: cs.key, label: cs.label, chain: cs.chain || [], enabled: cs.enabled !== false });
    }
  }
  return stages;
}

/** Convert stages array back to profile fields */
function stagesToProfileFields(stages: ProfileStage[]): {
  stt?: PipelineChainEntry[]; llm: PipelineChainEntry[]; tts?: PipelineChainEntry[];
  customStages?: { key: string; label: string; chain: PipelineChainEntry[]; enabled: boolean }[];
} {
  const sttStage = stages.find(s => s.key === 'stt' && s.enabled);
  const llmStage = stages.find(s => s.key === 'llm' && s.enabled);
  const ttsStage = stages.find(s => s.key === 'tts' && s.enabled);
  const custom = stages.filter(s => !['stt', 'llm', 'tts'].includes(s.key));
  return {
    // Only include stage if it has at least one chain entry; empty chains are omitted
    stt: sttStage?.chain.length ? sttStage.chain : undefined,
    llm: llmStage?.chain.length ? llmStage.chain : DEFAULT_LLM,
    tts: ttsStage?.chain.length ? ttsStage.chain : undefined,
    ...(custom.length > 0 ? { customStages: custom.map(s => ({ key: s.key, label: s.label, chain: s.chain, enabled: s.enabled })) } : {}),
  };
}

// ── Latency selector ──

const LATENCY_OPTIONS: { value: Latency; label: string; sub: string; color: string; Icon: typeof Clock }[] = [
  { value: 'realtime', label: 'realtime', sub: '<300ms', color: '#10b981', Icon: Gauge },
  { value: 'low', label: 'low', sub: '<1s', color: '#3b82f6', Icon: Timer },
  { value: 'batch', label: 'batch', sub: 'no limit', color: '#6b7280', Icon: Clock },
];

function LatencySelector({ value, onChange }: { value: Latency | undefined; onChange: (v: Latency) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {LATENCY_OPTIONS.map(opt => {
        const sel = value === opt.value;
        const { Icon } = opt;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
            style={{
              background: sel ? `color-mix(in srgb, ${opt.color} 10%, transparent)` : 'transparent',
              borderColor: sel ? `color-mix(in srgb, ${opt.color} 40%, transparent)` : 'var(--color-border)',
              color: sel ? opt.color : 'var(--color-text-muted)',
            }}
          >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="font-semibold">{opt.label}</span>
            <span className="opacity-60">{opt.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Stage row ──

const IO_OPTIONS = ['audio', 'text', 'vector', 'image'];

interface StageRowProps {
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

function StageRow({ stageKey, label, input, output, onChangeInput, onChangeOutput, chain, setChain, enabled, onToggle, onRemove, services }: StageRowProps) {
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
          <span className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>→</span>
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

// ── Service card ──

// ── Profile Flow Diagram ──

const PROVIDER_META: Record<string, { label: string; color: string; type: string }> = {
  gpu:          { label: 'GPU Pod',    color: '#f59e0b', type: 'Self-hosted' },
  groq:         { label: 'Groq',       color: '#7ba896', type: 'Cloud API'   },
  modal:        { label: 'Modal',      color: '#a78bfa', type: 'Serverless'  },
  'modal-moss': { label: 'Modal MOSS', color: '#c084fc', type: 'Serverless'  },
  openai:       { label: 'OpenAI',     color: '#8b8fc7', type: 'Cloud API'   },
  deepgram:     { label: 'Deepgram',   color: '#6366f1', type: 'Cloud API'   },
  elevenlabs:   { label: 'ElevenLabs', color: '#f43f5e', type: 'Cloud API'   },
  fireworks:    { label: 'Fireworks',  color: '#e07a3a', type: 'Cloud API'   },
  openrouter:   { label: 'OpenRouter', color: '#34d399', type: 'Cloud API'   },
  ollama:       { label: 'Ollama',     color: '#94a3b8', type: 'Self-hosted' },
};
function pMeta(provider: string) {
  return PROVIDER_META[provider] ?? { label: provider, color: '#8b949e', type: 'API' };
}

// ── Inline pipeline test types ──
type TestStageState = 'idle' | 'active' | 'done' | 'error';
interface TestStageStatus { key: string; state: TestStageState; latencyMs?: number; provider?: string; ttfacMs?: number; }
interface TestResult {
  transcription?: string; translation?: string;
  audioBase64?: string; contentType?: string;
  totalMs?: number; usedGpu?: boolean;
  stages: TestStageStatus[];
  error?: string;
  ttfacMs?: number;
}

type TestTransport = 'http' | 'sse' | 'ws' | 'webrtc';

interface TransportLatency {
  transport: TestTransport;
  totalMs?: number;
  ttfacMs?: number;
  audioDurationSec?: number;
  error?: string;
  running: boolean;
  audioBase64?: string;
  contentType?: string;
}

interface FlowStage {
  key: string; label: string; sublabel: string;
  chain: PipelineChainEntry[]; enabled: boolean; color: string;
  input: string; output: string;
}

function BenchProgressionRow({ it, maxMs }: { it: PipelineIteration; maxMs: number }) {
  const pct = maxMs > 0 ? Math.min((it.totalMs / maxMs) * 100, 100) : 0;
  const color = it.error ? '#f87171' : it.usedGpu ? '#34d399' : '#60a5fa';
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-6 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>{it.index + 1}</span>
      <div className="flex-1 h-3 rounded-full relative" style={{ background: 'var(--color-ink-300)' }}>
        <div className="h-3 rounded-full transition-all" style={{ width: `${pct}%`, background: color, opacity: 0.7 }} />
        {!it.error && it.totalMs > 0 && (
          <div className="absolute inset-0 flex rounded-full overflow-hidden">
            <div style={{ width: `${(it.sttMs / it.totalMs) * pct}%`, background: '#fbbf24', opacity: 0.8 }} title={`STT ${it.sttMs}ms`} />
            <div style={{ width: `${(it.llmMs / it.totalMs) * pct}%`, background: '#a78bfa', opacity: 0.8 }} title={`LLM ${it.llmMs}ms`} />
            <div style={{ width: `${(it.ttsMs / it.totalMs) * pct}%`, background: '#34d399', opacity: 0.8 }} title={`TTS ${it.ttsMs}ms`} />
          </div>
        )}
      </div>
      <span className="w-14 text-right font-mono font-medium" style={{ color }}>{it.totalMs}ms</span>
      <span className="w-10 text-center">{it.error ? '---' : it.usedGpu ? 'GPU' : 'Cloud'}</span>
    </div>
  );
}

function ProfileFlowDiagram({
  sttChain, llmChain, ttsChain, sttEnabled, ttsEnabled, services, latency, name,
  onToggleEntry, onToggleStage,
}: {
  sttChain: PipelineChainEntry[]; llmChain: PipelineChainEntry[]; ttsChain: PipelineChainEntry[];
  sttEnabled: boolean; ttsEnabled: boolean;
  services: ProfileService[]; latency: Latency; name?: string;
  onToggleEntry?: (stageKey: string, entryIdx: number) => void;
  onToggleStage?: (stageKey: string) => void;
}) {
  // ── Inline test panel state ──
  const [testOpen, setTestOpen] = useState(false);
  const [testSrc, setTestSrc] = useState('fr');
  const [testTgt, setTestTgt] = useState('en');
  const [testAudioFile, setTestAudioFile] = useState<File | null>(null);
  const [testRecordedBlob, setTestRecordedBlob] = useState<Blob | null>(null);
  const [testRecording, setTestRecording] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testRunningMs, setTestRunningMs] = useState(0);
  const [testStages, setTestStages] = useState<TestStageStatus[]>([
    { key: 'stt', state: 'idle' }, { key: 'llm', state: 'idle' }, { key: 'tts', state: 'idle' },
  ]);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [transportLatencies, setTransportLatencies] = useState<TransportLatency[]>([
    { transport: 'http', running: false },
    { transport: 'sse', running: false },
    { transport: 'ws', running: false },
    { transport: 'webrtc', running: false },
  ]);
  // SSE/WS/WebRTC are server-side only — UI uses HTTP API
  const testFileRef = useRef<HTMLInputElement>(null);
  const testAudioRef = useRef<HTMLAudioElement>(null);
  const [testPlaying, setTestPlaying] = useState(false);
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null);
  const testMediaRef = useRef<MediaRecorder | null>(null);
  const testChunksRef = useRef<Blob[]>([]);
  const testPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testElapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testStartRef = useRef(0);
  const testStagesRef = useRef(testStages);
  useEffect(() => { testStagesRef.current = testStages; }, [testStages]);

  // ── Benchmark state ──
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<BenchmarkPathsResponse | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const [benchAdvanced, setBenchAdvanced] = useState(false);
  const [benchIterations, setBenchIterations] = useState(3);
  const [benchPipelineIts, setBenchPipelineIts] = useState(5);
  const [benchWarmupIts, setBenchWarmupIts] = useState(2);
  const [benchIncludeGpu, setBenchIncludeGpu] = useState(true);
  const [benchIncludeCloud, setBenchIncludeCloud] = useState(true);

  const runBenchmark = async () => {
    setBenchRunning(true);
    setBenchError(null);
    setBenchResult(null);
    try {
      const result = await benchmarkPaths({
        iterations: benchAdvanced ? benchIterations : 3,
        pipelineIterations: benchAdvanced ? benchPipelineIts : 0,
        warmupIterations: benchAdvanced ? benchWarmupIts : 1,
        source: testSrc,
        target: testTgt,
        includeGpu: benchAdvanced ? benchIncludeGpu : true,
        includeCloud: benchAdvanced ? benchIncludeCloud : true,
      });
      setBenchResult(result);
    } catch (e) {
      setBenchError(e instanceof Error ? e.message : 'Benchmark failed');
    } finally {
      setBenchRunning(false);
    }
  };

  // ── Service chip hover tooltip ──
  const { gpu } = useGpuStatus(true, 10000);
  const [hoveredChip, setHoveredChip] = useState<{ stageKey: string; entryIdx: number } | null>(null);
  const [chipRect, setChipRect] = useState<DOMRect | null>(null);
  const hideTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHideTooltip = useCallback(() => {
    if (hideTooltipTimerRef.current) clearTimeout(hideTooltipTimerRef.current);
    hideTooltipTimerRef.current = setTimeout(() => setHoveredChip(null), 400);
  }, []);
  const cancelHideTooltip = useCallback(() => {
    if (hideTooltipTimerRef.current) { clearTimeout(hideTooltipTimerRef.current); hideTooltipTimerRef.current = null; }
  }, []);
  // mounted gate: avoids SSR/hydration mismatch with createPortal
  const [tooltipMounted, setTooltipMounted] = useState(false);
  useEffect(() => { setTooltipMounted(true); }, []);

  // ── Service chip context menu ──
  const [menuChip, setMenuChip] = useState<{ stageKey: string; entryIdx: number } | null>(null);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!menuChip) return;
    const close = () => setMenuChip(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuChip]);

  const resetTest = () => {
    setTestStages([{ key: 'stt', state: 'idle' }, { key: 'llm', state: 'idle' }, { key: 'tts', state: 'idle' }]);
    setTestResult(null); setTestError(null); setTestRunningMs(0);
    setTestAudioUrl(null); setTestPlaying(false);
    setTransportLatencies([
      { transport: 'http', running: false },
      { transport: 'sse', running: false },
      { transport: 'ws', running: false },
      { transport: 'webrtc', running: false },
    ]);
  };

  const testAdvanceRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTestTimers = () => {
    if (testPollRef.current) { clearInterval(testPollRef.current); testPollRef.current = null; }
    if (testElapsedRef.current) { clearInterval(testElapsedRef.current); testElapsedRef.current = null; }
    if (testAdvanceRef.current) { clearInterval(testAdvanceRef.current); testAdvanceRef.current = null; }
  };

  useEffect(() => () => stopTestTimers(), []);

  /** Helper: update a single transport's latency entry */
  const setTransportResult = (t: TestTransport, update: Partial<TransportLatency>) => {
    setTransportLatencies(prev => prev.map(x => x.transport === t ? { ...x, ...update } : x));
  };

  const runTest = async () => {
    const audio = testAudioFile || testRecordedBlob;
    if (!audio) return;
    resetTest();
    setTestRunning(true);
    testStartRef.current = Date.now();

    const initStages: TestStageStatus[] = [
      { key: 'stt', state: 'active', provider: sttChain[0]?.provider },
      { key: 'llm', state: 'idle', provider: llmChain[0]?.provider },
      { key: 'tts', state: 'idle', provider: ttsChain[0]?.provider },
    ];
    setTestStages(initStages);
    testStagesRef.current = initStages;

    testElapsedRef.current = setInterval(() => setTestRunningMs(Date.now() - testStartRef.current), 80);

    // Optimistic stage progression
    const stageKeys = stages.filter(s => s.enabled).map(s => s.key);
    let lastAdvancedIdx = 0;
    testAdvanceRef.current = setInterval(() => {
      const elapsed = Date.now() - testStartRef.current;
      const current = testStagesRef.current;
      const activeIdx = current.findIndex(s => s.state === 'active');
      if (activeIdx === -1) return;
      const shouldBeAt = Math.min(stageKeys.length - 1, Math.floor(elapsed / 2000));
      if (shouldBeAt > lastAdvancedIdx && activeIdx < shouldBeAt) {
        lastAdvancedIdx = shouldBeAt;
        setTestStages(prev => {
          const next = prev.map((s, i) => {
            if (i === activeIdx && s.state === 'active' && !s.latencyMs) return { ...s, state: 'done' as const };
            if (i === activeIdx + 1 && s.state === 'idle') return { ...s, state: 'active' as const };
            return s;
          });
          testStagesRef.current = next;
          return next;
        });
      }
    }, 500);

    // ── Fire all transports in parallel — no fallbacks, each must succeed on its own ──
    const transports: SpeechTransport[] = ['http', 'sse', 'ws', 'webrtc'];
    let firstResult = false;

    for (const t of transports) {
      setTransportResult(t, { running: true });
    }

    /** Estimate WAV audio duration from base64 */
    const estimateAudioDuration = (b64: string): number | undefined => {
      if (!b64) return undefined;
      const byteLen = Math.floor(b64.length * 3 / 4);
      // WAV: 44-byte header, 16-bit mono 16kHz → 32000 bytes/sec; or 16-bit mono 24kHz → 48000
      const dataBytes = Math.max(0, byteLen - 44);
      return dataBytes / 32000; // assume 16kHz mono 16-bit
    };

    const runTransport = (t: TestTransport, transport: SpeechTransport) => {
      const t0 = Date.now();
      return speechPipeline(audio, { source: testSrc, target: testTgt, transport, timeoutMs: 10_000 })
        .then(result => {
          setTransportResult(t, {
            running: false,
            totalMs: result.timing.totalMs || (Date.now() - t0),
            ttfacMs: result.timing.ttfacMs,
            audioBase64: result.audioBase64,
            contentType: result.contentType,
            audioDurationSec: estimateAudioDuration(result.audioBase64),
          });
          // First transport to finish populates the main result + stage timing
          if (!firstResult) {
            firstResult = true;
            const stageTiming: Record<string, { ms: number; provider?: string }> = {
              stt: { ms: result.timing.sttMs, provider: result.timing.sttProvider },
              llm: { ms: result.timing.llmMs, provider: result.timing.llmProvider },
              tts: { ms: result.timing.ttsMs, provider: result.timing.ttsProvider },
            };
            setTestStages(prev => {
              const next = prev.map(s => ({
                ...s,
                state: 'done' as const,
                latencyMs: s.latencyMs ?? stageTiming[s.key]?.ms,
                provider: s.provider ?? stageTiming[s.key]?.provider,
              }));
              testStagesRef.current = next;
              return next;
            });
            setTestResult({
              transcription: result.transcription, translation: result.response,
              audioBase64: result.audioBase64, contentType: result.contentType,
              totalMs: result.timing.totalMs || (Date.now() - t0),
              usedGpu: result.timing.usedGpu,
              stages: testStagesRef.current,
              ttfacMs: result.timing.ttfacMs,
            });
          }
        })
        .catch(e => {
          setTransportResult(t, { running: false, error: e instanceof Error ? e.message : 'Failed' });
        });
    };

    const promises = transports.map(t => runTransport(t, t));

    // Wait for all transports (success or failure)
    await Promise.allSettled(promises);

    // If no transport succeeded, show error
    if (!firstResult) {
      setTestError('All transports failed');
      setTestStages(prev => prev.map(s => ({ ...s, state: s.state === 'active' ? 'error' as const : s.state })));
    }

    stopTestTimers();
    setTestRunning(false);
  };

  const startTestRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      testChunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) testChunksRef.current.push(e.data); };
      mr.onstop = () => {
        setTestRecordedBlob(new Blob(testChunksRef.current, { type: 'audio/webm' }));
        setTestAudioFile(null);
        stream.getTracks().forEach(t => t.stop());
      };
      testMediaRef.current = mr;
      mr.start();
      setTestRecording(true);
    } catch { setTestError('Microphone access denied'); }
  };

  const toggleTestAudio = () => {
    if (!testAudioRef.current || !testResult?.audioBase64) return;
    if (!testAudioUrl) {
      const binary = atob(testResult.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: testResult.contentType || 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setTestAudioUrl(url);
      testAudioRef.current.src = url;
    }
    if (testPlaying) { testAudioRef.current.pause(); setTestPlaying(false); }
    else { testAudioRef.current.play(); setTestPlaying(true); }
  };

  useEffect(() => {
    const el = testAudioRef.current;
    if (!el) return;
    const onEnd = () => setTestPlaying(false);
    el.addEventListener('ended', onEnd);
    return () => el.removeEventListener('ended', onEnd);
  }, []);

  const gpuService = services.find(s => s.kind === 'gpu-pod');
  const latencyOpt = LATENCY_OPTIONS.find(o => o.value === latency);

  const stages: FlowStage[] = [
    { key: 'stt', label: 'STT', sublabel: 'Speech → Text',  chain: sttChain, enabled: sttEnabled, color: '#38bdf8', input: 'audio', output: 'text' },
    { key: 'llm', label: 'LLM', sublabel: 'Translation',    chain: llmChain, enabled: true,        color: '#a78bfa', input: 'text',  output: 'text' },
    { key: 'tts', label: 'TTS', sublabel: 'Text → Speech',  chain: ttsChain, enabled: ttsEnabled,  color: '#fbbf24', input: 'text',  output: 'audio' },
  ];

  const entryLabel = (entry: PipelineChainEntry) => {
    if (entry.provider === 'gpu') {
      const svc = services.find(s => s.kind === 'gpu-pod' && s.id === entry.model);
      if (svc) return svc.name;
      if (gpuService) return gpuService.name;
      return 'GPU Pod';
    }
    return pMeta(entry.provider).label;
  };

  const humanizeId = (id: string) =>
    id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const modelLabel = (stageKey: string, entry: PipelineChainEntry): string | null => {
    const catalog = PIPELINE_CATALOG[stageKey as keyof typeof PIPELINE_CATALOG];
    if (!catalog) return null;
    const gpuModels = (catalog.models as Record<string, { id: string; label: string }[]>)['gpu'] ?? [];
    const provModels = (catalog.models as Record<string, { id: string; label: string }[]>)[entry.provider] ?? [];
    // Direct catalog match (cloud providers + hardcoded GPU model IDs)
    const fromCatalog = provModels.find(m => m.id === entry.model)?.label;
    if (fromCatalog) return fromCatalog;
    if (entry.provider === 'gpu') {
      // Look for service where entry.model === service.id (new-style pod service)
      const svcById = services.find(s => s.kind === 'gpu-pod' && s.id === entry.model);
      if (svcById) {
        const stageModelId = stageKey === 'stt' ? svcById.sttModel : stageKey === 'llm' ? svcById.llmModel : svcById.ttsModel;
        if (stageModelId) return gpuModels.find(m => m.id === stageModelId)?.label ?? humanizeId(stageModelId);
        if (svcById.dockerImage) return svcById.dockerImage.split('/').pop()?.replace(/:.*$/, '') ?? null;
      }
      // Fall back: look at the first GPU pod service's stage model (legacy profiles)
      const gpuSvc = services.find(s => s.kind === 'gpu-pod');
      if (gpuSvc) {
        const stageModelId = stageKey === 'stt' ? gpuSvc.sttModel : stageKey === 'llm' ? gpuSvc.llmModel : gpuSvc.ttsModel;
        if (stageModelId) return gpuModels.find(m => m.id === stageModelId)?.label ?? humanizeId(stageModelId);
      }
      // Last resort: humanize the model ID directly
      return humanizeId(entry.model);
    }
    return null;
  };

  return (
    <div className="rounded-xl border overflow-hidden"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
          {name || 'Pipeline Flow'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={benchRunning}
            onClick={runBenchmark}
            className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer"
            style={{
              background: benchRunning
                ? 'color-mix(in srgb, #8b5cf6 8%, transparent)'
                : 'color-mix(in srgb, #8b5cf6 5%, transparent)',
              borderColor: 'color-mix(in srgb, #8b5cf6 25%, transparent)',
              color: '#8b5cf6',
              opacity: benchRunning ? 0.7 : 1,
            }}
            title="Benchmark all provider combinations to find the fastest path"
          >
            {benchRunning
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <BarChart3 className="w-3 h-3" />}
            {benchRunning ? 'Benchmarking...' : 'Compare'}
          </button>
          {latencyOpt && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg"
              style={{
                background: `color-mix(in srgb, ${latencyOpt.color} 10%, transparent)`,
                color: latencyOpt.color,
              }}>
              <latencyOpt.Icon className="w-3 h-3" />
              {latencyOpt.label} · {latencyOpt.sub}
            </span>
          )}
        </div>
      </div>

      {/* Flow */}
      <div className="p-5 rounded-b-xl relative"
        style={{
          background: 'var(--color-surface)',
          backgroundImage: 'radial-gradient(circle, color-mix(in srgb, var(--color-text-muted) 12%, transparent) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}>
        <div className="flex items-start gap-0">

          {/* Pipeline input — compact controls: lang, record, upload, run */}
          {(() => {
            const firstStage = stages.find(s => s.enabled);
            const inType = firstStage?.input || 'audio';
            const inColor = firstStage?.color || '#38bdf8';
            const isAudioInput = inType === 'audio';
            const hasAudio = !!(testAudioFile || testRecordedBlob);
            return (
              <div className="flex flex-col items-center flex-shrink-0 gap-1.5" style={{ minWidth: '64px' }}>
                {/* Language selects — compact inline */}
                <div className="flex items-center gap-0.5">
                  <select value={testSrc} onChange={e => setTestSrc(e.target.value)}
                    className="text-[9px] font-bold uppercase rounded px-1 py-0.5 focus:outline-none w-[34px] text-center appearance-none cursor-pointer"
                    style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: inColor, border: `1px solid color-mix(in srgb, ${inColor} 30%, transparent)` }}>
                    {['auto','en','fr','es','de','pt','it','ja','zh','ko','ar','ru'].map(c => (
                      <option key={c} value={c}>{c === 'auto' ? '?' : c.toUpperCase()}</option>
                    ))}
                  </select>
                  <span className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>→</span>
                  <select value={testTgt} onChange={e => setTestTgt(e.target.value)}
                    className="text-[9px] font-bold uppercase rounded px-1 py-0.5 focus:outline-none w-[34px] text-center appearance-none cursor-pointer"
                    style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: inColor, border: `1px solid color-mix(in srgb, ${inColor} 30%, transparent)` }}>
                    {['en','fr','es','de','pt','it','ja','zh','ko','ar','ru'].map(c => (
                      <option key={c} value={c}>{c.toUpperCase()}</option>
                    ))}
                  </select>
                </div>

                {/* Main input button */}
                <button
                  type="button"
                  onClick={() => {
                    if (testRunning) return;
                    if (hasAudio) { runTest(); }
                    else if (isAudioInput) {
                      if (testRecording) { testMediaRef.current?.stop(); setTestRecording(false); }
                      else { startTestRecording(); }
                    } else {
                      testFileRef.current?.click();
                    }
                  }}
                  className="w-12 h-12 rounded-xl flex items-center justify-center cursor-pointer transition-all relative"
                  style={{
                    background: testRecording
                      ? 'color-mix(in srgb, #ef4444 12%, var(--color-surface-elevated))'
                      : hasAudio
                        ? 'color-mix(in srgb, #10b981 12%, var(--color-surface-elevated))'
                        : `color-mix(in srgb, ${inColor} 8%, var(--color-surface-elevated))`,
                    border: `1.5px solid ${testRecording ? 'rgba(239,68,68,0.4)' : hasAudio ? 'rgba(16,185,129,0.4)' : `color-mix(in srgb, ${inColor} 30%, transparent)`}`,
                  }}
                  title={testRecording ? 'Stop recording' : hasAudio ? 'Run all transports' : isAudioInput ? 'Click to record' : 'Click to upload'}
                >
                  {testRecording ? (
                    <div className="w-3 h-3 rounded-sm bg-red-500 animate-pulse" />
                  ) : testRunning ? (
                    <Loader2 className="w-5 h-5 animate-spin" style={{ color: inColor }} />
                  ) : hasAudio ? (
                    <Play className="w-5 h-5" style={{ color: '#10b981' }} />
                  ) : (
                    <Mic className="w-5 h-5" style={{ color: inColor }} />
                  )}
                </button>

                {/* Action buttons row: Upload, Record, Clear — always visible */}
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => testFileRef.current?.click()}
                    disabled={testRunning}
                    className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                    style={{
                      cursor: testRunning ? 'default' : 'pointer',
                      opacity: testRunning ? 0.35 : 1,
                      background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--color-text-muted) 15%, transparent)',
                    }}
                    title="Upload audio file">
                    <Upload className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                  </button>
                  {isAudioInput && (
                    <button type="button"
                      disabled={testRunning}
                      onClick={() => {
                        if (testRecording) { testMediaRef.current?.stop(); setTestRecording(false); }
                        else startTestRecording();
                      }}
                      className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                      style={{
                        cursor: testRunning ? 'default' : 'pointer',
                        opacity: testRunning ? 0.35 : 1,
                        background: testRecording ? 'color-mix(in srgb, #ef4444 15%, transparent)' : 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                        border: `1px solid ${testRecording ? 'rgba(239,68,68,0.4)' : 'color-mix(in srgb, var(--color-text-muted) 15%, transparent)'}`,
                      }}
                      title={testRecording ? 'Stop recording' : 'Record audio'}>
                      {testRecording
                        ? <div className="w-2.5 h-2.5 rounded-sm bg-red-500 animate-pulse" />
                        : <Mic className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />}
                    </button>
                  )}
                  <button type="button"
                    disabled={!hasAudio || testRunning}
                    onClick={() => { setTestAudioFile(null); setTestRecordedBlob(null); resetTest(); }}
                    className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                    style={{
                      cursor: !hasAudio || testRunning ? 'default' : 'pointer',
                      opacity: !hasAudio || testRunning ? 0.25 : 1,
                      background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--color-text-muted) 15%, transparent)',
                    }}
                    title="Clear audio">
                    <XIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                  </button>
                </div>

                {/* Status label */}
                <span className="text-[8px] font-bold uppercase tracking-wider text-center"
                  style={{ color: testRecording ? '#ef4444' : hasAudio ? '#10b981' : inColor }}>
                  {testRecording ? 'rec...' : testRunning ? 'running' : hasAudio ? (testAudioFile?.name ? testAudioFile.name.slice(0, 8) : 'ready') : inType}
                </span>

                <input ref={testFileRef} type="file" accept="audio/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) { setTestAudioFile(f); setTestRecordedBlob(null); resetTest(); } e.target.value = ''; }} />
              </div>
            );
          })()}

          {stages.map((stage) => {
            const ts = testStages.find(s => s.key === stage.key);
            const arrowActive = ts?.state === 'active';
            const arrowDone = ts?.state === 'done';
            return (
            <div key={stage.key} className="flex items-start flex-1 min-w-0">
              {/* Arrow with data type label */}
              <div className="flex flex-col items-center w-10 flex-shrink-0 pt-3">
                <span className={`text-[7px] font-bold uppercase tracking-widest mb-1 ${arrowActive ? 'animate-pulse' : ''}`}
                  style={{
                    color: arrowDone ? '#10b981' : arrowActive ? stage.color : stage.enabled ? stage.color : 'var(--color-text-muted)',
                    opacity: arrowActive ? 1 : 0.65,
                    letterSpacing: '0.12em',
                  }}>
                  {stage.input}
                </span>
                <div className="flex items-center w-full">
                  <div className={`flex-1 transition-all duration-500 ${arrowActive ? 'h-[2.5px]' : 'h-[1.5px]'}`}
                    style={{
                      background: arrowDone
                        ? '#10b981'
                        : arrowActive
                          ? stage.color
                          : stage.enabled
                            ? `color-mix(in srgb, ${stage.color} 50%, transparent)`
                            : 'var(--color-border)',
                      borderRadius: '1px',
                    }} />
                  <svg width="6" height="10" viewBox="0 0 6 10" className="flex-shrink-0">
                    <path d="M0 1.5 L5 5 L0 8.5"
                      stroke={arrowDone ? '#10b981' : stage.enabled ? stage.color : 'var(--color-border)'}
                      strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"
                      strokeOpacity={arrowActive ? 1 : stage.enabled ? 0.65 : 1} />
                  </svg>
                </div>
              </div>

              {/* Stage block */}
              <div className={`flex flex-col items-center flex-1 min-w-0 ${!stage.enabled ? 'opacity-35' : ''}`}>
                {/* Stage box — rectangle with colored top bar (= "process" shape) */}
                {(() => {
                  const ts = testStages.find(s => s.key === stage.key);
                  const isActive = ts?.state === 'active';
                  const isDone = ts?.state === 'done';
                  const isError = ts?.state === 'error';
                  const anyTest = testRunning || (testResult != null);
                  const boxBorderColor = isError ? 'color-mix(in srgb, #ef4444 50%, transparent)'
                    : isDone ? 'color-mix(in srgb, #10b981 40%, transparent)'
                    : isActive ? `color-mix(in srgb, ${stage.color} 60%, transparent)`
                    : stage.enabled ? `color-mix(in srgb, ${stage.color} 35%, transparent)` : 'var(--color-border)';
                  const boxTopColor = isError ? '#ef4444' : isDone ? '#10b981'
                    : isActive ? stage.color : stage.enabled ? stage.color : 'var(--color-border)';
                  const boxBg = isActive ? `color-mix(in srgb, ${stage.color} 12%, var(--color-surface))`
                    : isDone ? 'color-mix(in srgb, #10b981 6%, var(--color-surface))'
                    : stage.enabled ? `color-mix(in srgb, ${stage.color} 6%, var(--color-surface))` : 'var(--color-surface)';
                  return (
                    <div className="w-full border px-3 py-2.5 text-center relative overflow-hidden transition-all"
                      style={{
                        borderRadius: '10px',
                        borderColor: boxBorderColor,
                        background: boxBg,
                        borderTop: `3px solid ${boxTopColor}`,
                        boxShadow: isActive ? `0 0 16px color-mix(in srgb, ${stage.color} 22%, transparent)` : isDone ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                        backdropFilter: 'blur(2px)',
                      }}>
                      {isActive && (
                        <div className="absolute inset-0 overflow-hidden pointer-events-none">
                          <div className="absolute inset-y-0 w-full opacity-20 animate-pulse"
                            style={{ background: `linear-gradient(90deg, transparent, ${stage.color}, transparent)` }} />
                        </div>
                      )}
                      {/* Stage enable/disable toggle */}
                      {onToggleStage && (
                        <button
                          type="button"
                          onClick={() => onToggleStage(stage.key)}
                          title={stage.enabled ? 'Disable stage' : 'Enable stage'}
                          className="absolute top-1 right-1 w-4 h-4 rounded flex items-center justify-center transition-colors"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0 }}
                          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={e => (e.currentTarget.style.opacity = '0')}>
                          {stage.enabled
                            ? <EyeOff className="w-2.5 h-2.5" style={{ color: 'var(--color-text-muted)' }} />
                            : <Eye className="w-2.5 h-2.5" style={{ color: '#10b981' }} />}
                        </button>
                      )}
                      {/* Stage icon + label row */}
                      <div className="flex items-center justify-center gap-1.5 mb-0.5">
                        <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
                          style={{ background: `color-mix(in srgb, ${isError ? '#ef4444' : isDone ? '#10b981' : stage.color} 15%, transparent)` }}>
                          {stage.key === 'stt' && <Mic className="w-3 h-3" style={{ color: isError ? '#ef4444' : isDone ? '#10b981' : isActive ? stage.color : stage.color }} />}
                          {stage.key === 'llm' && <Bot className="w-3 h-3" style={{ color: isError ? '#ef4444' : isDone ? '#10b981' : isActive ? stage.color : stage.color }} />}
                          {stage.key === 'tts' && <Volume2 className="w-3 h-3" style={{ color: isError ? '#ef4444' : isDone ? '#10b981' : isActive ? stage.color : stage.color }} />}
                        </div>
                        <span className="text-[11px] font-bold uppercase tracking-widest"
                          style={{ color: isError ? '#ef4444' : isDone ? '#10b981' : isActive ? stage.color : stage.enabled ? stage.color : 'var(--color-text-muted)', letterSpacing: '0.12em' }}>
                          {stage.label}
                        </span>
                        {isActive && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" style={{ color: stage.color }} />}
                        {isDone && <Check className="w-3 h-3 flex-shrink-0" style={{ color: '#10b981' }} />}
                        {isError && <XIcon className="w-3 h-3 flex-shrink-0" style={{ color: '#ef4444' }} />}
                      </div>
                      <div className="text-[9px] font-medium" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.02em' }}>
                        {stage.sublabel}
                      </div>
                      {/* Timing — prominent display after completion */}
                      {isDone && ts?.latencyMs != null && (
                        <div className="flex flex-col items-center gap-0.5 mt-1">
                          <div className="flex items-center justify-center gap-1 px-2 py-0.5 rounded-md"
                            style={{ background: 'color-mix(in srgb, #10b981 10%, transparent)' }}>
                            {ts.ttfacMs != null && stage.key === 'tts' && (
                              <span className="text-[9px] font-bold font-mono" style={{ color: '#f59e0b' }}
                                title="Time to First Audio Chunk">
                                TTFAC: {ts.ttfacMs}ms
                              </span>
                            )}
                            <span className="text-[10px] font-bold font-mono" style={{ color: '#10b981' }}>
                              {ts.ttfacMs != null && stage.key === 'tts' ? 'Total: ' : ''}
                              {ts.latencyMs < 1000 ? `${ts.latencyMs}ms` : `${(ts.latencyMs / 1000).toFixed(1)}s`}
                            </span>
                          </div>
                          {ts.provider && (
                            <span className="text-[8px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
                              {ts.provider}
                            </span>
                          )}
                        </div>
                      )}
                      {isActive && anyTest && (
                        <div className="text-[10px] font-mono font-bold mt-1" style={{ color: stage.color }}>
                          {(testRunningMs / 1000).toFixed(1)}s
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Connector line down */}
                {stage.enabled && stage.chain.length > 0 && (
                  <div className="flex flex-col items-center gap-0.5 py-1">
                    <div className="w-px h-3 flex-shrink-0"
                      style={{ background: `color-mix(in srgb, ${stage.color} 35%, transparent)` }} />
                    <svg width="6" height="5" viewBox="0 0 6 5">
                      <path d="M1 0.5 L3 4 L5 0.5" stroke={stage.color} strokeWidth="1.2" fill="none"
                        strokeLinecap="round" strokeOpacity="0.5" />
                    </svg>
                  </div>
                )}

                {/* Provider chain */}
                {stage.enabled && stage.chain.map((entry, j) => {
                  const meta = pMeta(entry.provider);
                  const color = meta.color;
                  const label = entryLabel(entry);
                  const mLabel = modelLabel(stage.key, entry);
                  const pi = PROVIDER_ICON[entry.provider];
                  const EntryIcon = pi?.icon;
                  const isEntryDisabled = entry.enabled === false;
                  // Highlight the service pill that was actually used in the test
                  const usedProvider = ts?.provider;
                  const isUsedService = !isEntryDisabled && ts?.state === 'done' && usedProvider && (
                    usedProvider === entry.provider ||
                    usedProvider.startsWith(entry.provider + '/') ||
                    (entry.provider === 'gpu' && usedProvider === 'gpu')
                  );
                  const iconColor = isUsedService ? '#10b981' : j === 0 ? (pi?.color ?? color) : 'var(--color-text-muted)';
                  const chipColor = isUsedService ? '#10b981' : j === 0 ? color : 'var(--color-text-muted)';
                  const isChipHovered = hoveredChip?.stageKey === stage.key && hoveredChip?.entryIdx === j;
                  return (
                    <div key={j} className="flex flex-col items-center w-full">
                      {j > 0 && (
                        <div className="flex items-center gap-1 py-1 w-full">
                          <div className="flex-1 h-px" style={{ background: 'var(--color-border)', opacity: 0.6 }} />
                          <span className="text-[7px] font-semibold uppercase tracking-widest px-1.5 py-0.5 rounded-full"
                            style={{
                              color: 'var(--color-text-muted)',
                              background: 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                              border: '1px solid var(--color-border)',
                              letterSpacing: '0.1em',
                            }}>
                            fallback
                          </span>
                          <div className="flex-1 h-px" style={{ background: 'var(--color-border)', opacity: 0.6 }} />
                        </div>
                      )}
                      {/* Chip wrapper — tracks hover for action buttons */}
                      <div className="relative w-full"
                        onMouseEnter={() => { cancelHideTooltip(); setHoveredChip({ stageKey: stage.key, entryIdx: j }); }}
                        onMouseLeave={() => scheduleHideTooltip()}>
                        {/* Service chip — horizontal card with left-border accent */}
                        <div className={`w-full flex items-center px-2 py-1.5 border gap-2 transition-all cursor-help ${isUsedService ? 'ring-1 ring-emerald-500/20' : ''}`}
                          style={{
                            borderRadius: '8px',
                            opacity: isEntryDisabled ? 0.4 : 1,
                            background: isUsedService
                              ? 'color-mix(in srgb, #10b981 8%, var(--color-surface))'
                              : j === 0
                                ? `color-mix(in srgb, ${color} 7%, var(--color-surface))`
                                : 'var(--color-surface-elevated)',
                            borderColor: isEntryDisabled
                              ? 'var(--color-border)'
                              : isUsedService
                                ? 'color-mix(in srgb, #10b981 35%, transparent)'
                                : j === 0
                                  ? `color-mix(in srgb, ${color} 25%, transparent)`
                                  : 'var(--color-border)',
                            borderLeft: `2.5px solid ${isEntryDisabled ? 'var(--color-border)' : isUsedService ? '#10b981' : j === 0 ? color : 'var(--color-border)'}`,
                            boxShadow: isUsedService ? `0 1px 6px color-mix(in srgb, #10b981 15%, transparent)` : j === 0 ? `0 1px 4px color-mix(in srgb, ${color} 10%, transparent)` : 'none',
                          }}
                          onMouseEnter={e => {
                            cancelHideTooltip();
                            setChipRect(e.currentTarget.getBoundingClientRect());
                            e.currentTarget.style.transform = 'translateX(1px)';
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.transform = '';
                          }}>
                          {/* Icon */}
                          {EntryIcon && (
                            <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                              style={{ background: `color-mix(in srgb, ${iconColor} 18%, transparent)` }}>
                              <EntryIcon className="w-3 h-3" style={{ color: iconColor }} />
                            </div>
                          )}
                          {/* Text stack */}
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="text-[10px] font-semibold truncate leading-tight"
                              style={{ color: chipColor }}>
                              {label}
                            </span>
                            {mLabel && (
                              <span className="text-[8px] truncate leading-tight"
                                style={{ color: 'var(--color-text-muted)' }}>
                                {mLabel}
                              </span>
                            )}
                          </div>
                          {/* Used indicator with latency */}
                          {isUsedService && ts?.latencyMs != null && (
                            <span className="text-[8px] font-bold font-mono flex-shrink-0 px-1 py-0.5 rounded"
                              style={{ color: '#10b981', background: 'color-mix(in srgb, #10b981 10%, transparent)' }}>
                              {ts.latencyMs < 1000 ? `${ts.latencyMs}ms` : `${(ts.latencyMs / 1000).toFixed(1)}s`}
                            </span>
                          )}
                          {/* Disabled badge */}
                          {isEntryDisabled && (
                            <span className="text-[7px] font-bold uppercase tracking-widest flex-shrink-0"
                              style={{ color: 'var(--color-text-muted)' }}>off</span>
                          )}
                        </div>

                        {/* Action overlay — shown on hover when editable */}
                        {onToggleEntry && isChipHovered && (
                          <div className="absolute flex flex-col gap-0.5"
                            style={{ top: '2px', right: '2px', zIndex: 20 }}
                            onMouseDown={e => e.stopPropagation()}>
                            {/* Toggle enable/disable */}
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); onToggleEntry(stage.key, j); }}
                              title={isEntryDisabled ? 'Enable provider' : 'Disable provider'}
                              className="w-5 h-5 rounded-full flex items-center justify-center shadow-sm"
                              style={{
                                background: isEntryDisabled
                                  ? 'color-mix(in srgb, #10b981 15%, var(--color-surface-elevated))'
                                  : 'var(--color-surface-elevated)',
                                border: `1px solid ${isEntryDisabled ? 'rgba(16,185,129,0.5)' : 'var(--color-border)'}`,
                              }}>
                              {isEntryDisabled
                                ? <Eye className="w-2.5 h-2.5" style={{ color: '#10b981' }} />
                                : <EyeOff className="w-2.5 h-2.5" style={{ color: 'var(--color-text-muted)' }} />}
                            </button>
                            {/* More options */}
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                setMenuChip({ stageKey: stage.key, entryIdx: j });
                                setMenuRect(e.currentTarget.getBoundingClientRect());
                              }}
                              title="More options"
                              className="w-5 h-5 rounded-full flex items-center justify-center shadow-sm"
                              style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
                              <MoreVertical className="w-2.5 h-2.5" style={{ color: 'var(--color-text-muted)' }} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}

          {/* Arrow to output */}
          {(() => {
            const lastStage = [...stages].reverse().find(s => s.enabled);
            const outType = lastStage?.output || 'audio';
            const outColor = lastStage?.color || '#fbbf24';
            return (
              <div className="flex flex-col items-center w-12 flex-shrink-0">
                <span className="text-[8px] font-semibold uppercase tracking-wider mb-0.5"
                  style={{ color: outColor, opacity: 0.7 }}>
                  {outType}
                </span>
                <div className="flex items-center w-full mt-0.5">
                  <div className="flex-1 h-px"
                    style={{ background: `color-mix(in srgb, ${outColor} 60%, transparent)` }} />
                  <svg width="7" height="10" viewBox="0 0 7 10" className="flex-shrink-0">
                    <path d="M0 1 L6 5 L0 9" stroke={outColor}
                      strokeWidth="1.5" fill="none" strokeLinecap="round" strokeOpacity={0.7} />
                  </svg>
                </div>
              </div>
            );
          })()}

          {/* Pipeline output — interactive: click to play result */}
          {(() => {
            const lastStage = [...stages].reverse().find(s => s.enabled);
            const outType = lastStage?.output || 'audio';
            const outColor = lastStage?.color || '#fbbf24';
            const hasResult = !!testResult;
            const isAudioOut = outType === 'audio';
            return (
              <div className="flex flex-col items-center flex-shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => { if (hasResult && isAudioOut) toggleTestAudio(); }}
                  disabled={!hasResult || !isAudioOut}
                  className="w-12 h-12 rounded-xl flex items-center justify-center transition-all"
                  style={{
                    cursor: hasResult && isAudioOut ? 'pointer' : 'default',
                    background: hasResult
                      ? `color-mix(in srgb, ${outColor} 12%, var(--color-surface-elevated))`
                      : `color-mix(in srgb, ${outColor} 5%, var(--color-surface-elevated))`,
                    border: `1.5px solid ${hasResult ? `color-mix(in srgb, ${outColor} 40%, transparent)` : `color-mix(in srgb, ${outColor} 20%, transparent)`}`,
                    opacity: hasResult ? 1 : 0.5,
                  }}
                  title={hasResult ? (testPlaying ? 'Stop playback' : 'Play result') : 'Output'}
                >
                  {testPlaying ? (
                    <Square className="w-4 h-4" style={{ color: outColor }} />
                  ) : (
                    <Volume2 className="w-5 h-5" style={{ color: outColor }} />
                  )}
                </button>
                <span className="text-[8px] font-bold uppercase tracking-wider"
                  style={{ color: hasResult ? outColor : 'var(--color-text-muted)' }}>
                  {hasResult ? (testPlaying ? 'playing' : '▶ play') : outType}
                </span>
                {hasResult && testResult?.transcription && (
                  <span className="text-[7px] max-w-[60px] text-center truncate"
                    style={{ color: 'var(--color-text-muted)' }}
                    title={testResult.transcription}>
                    {testResult.totalMs ? `${(testResult.totalMs / 1000).toFixed(1)}s` : ''}
                  </span>
                )}
                <audio ref={testAudioRef} onEnded={() => setTestPlaying(false)} className="hidden" />
              </div>
            );
          })()}
        </div>

        {/* Transport latency comparison — visible right below the flow */}
        {transportLatencies.some(t => t.totalMs != null || t.error || t.running) && (
          <div className="flex items-stretch gap-2 mt-4 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
            {transportLatencies.map(t => {
              const TRANSPORT_COLORS: Record<string, string> = { http: '#64748b', sse: '#8b5cf6', ws: '#0ea5e9', webrtc: '#f59e0b' };
              const color = TRANSPORT_COLORS[t.transport] || '#8b949e';
              const maxMs = Math.max(...transportLatencies.filter(x => x.totalMs).map(x => x.totalMs!), 1);
              const barPct = t.totalMs ? Math.max(8, (t.totalMs / maxMs) * 100) : 0;
              const completedWithTime = transportLatencies.filter(x => x.totalMs != null);
              const isFastest = t.totalMs != null && completedWithTime.length > 1 && t.totalMs === Math.min(...completedWithTime.map(x => x.totalMs!));
              return (
                <div key={t.transport} className="flex-1 rounded-lg border px-2.5 py-2 flex flex-col gap-1"
                  style={{
                    borderColor: isFastest ? `color-mix(in srgb, ${color} 50%, transparent)` : 'var(--color-border)',
                    background: isFastest ? `color-mix(in srgb, ${color} 6%, var(--color-surface))` : 'var(--color-surface)',
                  }}>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
                      {t.transport}
                    </span>
                    {t.running && <Loader2 className="w-3 h-3 animate-spin" style={{ color }} />}
                    {isFastest && <Zap className="w-3 h-3" style={{ color }} />}
                  </div>
                  {t.totalMs != null ? (
                    <>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${barPct}%`, background: color }} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-bold font-mono" style={{ color }}>
                          {t.totalMs < 1000 ? `${t.totalMs}ms` : `${(t.totalMs / 1000).toFixed(2)}s`}
                        </span>
                        {t.ttfacMs != null && (
                          <span className="text-[9px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                            TTFAC {t.ttfacMs}ms
                          </span>
                        )}
                        {t.audioBase64 && (
                          <button type="button"
                            className="flex items-center gap-1 ml-auto flex-shrink-0 cursor-pointer transition-all hover:scale-105 rounded-full px-1.5 py-0.5"
                            style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}
                            title={`Play ${t.transport.toUpperCase()} audio`}
                            onClick={() => {
                              try {
                                const binary = atob(t.audioBase64!);
                                const bytes = new Uint8Array(binary.length);
                                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                const blob = new Blob([bytes], { type: t.contentType || 'audio/wav' });
                                const url = URL.createObjectURL(blob);
                                const a = new Audio(url);
                                a.onended = () => URL.revokeObjectURL(url);
                                a.play();
                              } catch {}
                            }}>
                            <Play className="w-3 h-3" style={{ color }} />
                            {t.audioDurationSec != null && (
                              <span className="text-[9px] font-mono" style={{ color }}>
                                {t.audioDurationSec.toFixed(1)}s
                              </span>
                            )}
                          </button>
                        )}
                      </div>
                    </>
                  ) : t.error ? (
                    <span className="text-[10px]" style={{ color: '#ef4444' }}>
                      {t.error!.length > 40 ? t.error!.slice(0, 37) + '...' : t.error}
                    </span>
                  ) : t.running ? (
                    <span className="text-[10px] animate-pulse" style={{ color }}>running...</span>
                  ) : (
                    <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>—</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Legend */}
        {(() => {
          const allEntries = [...sttChain, ...llmChain, ...ttsChain];
          const seen = new Map<string, { label: string; color: string; type: string; Icon: React.ElementType }>();
          for (const entry of allEntries) {
            if (!seen.has(entry.provider)) {
              const meta = pMeta(entry.provider);
              const pi = PROVIDER_ICON[entry.provider];
              if (pi) seen.set(entry.provider, { ...meta, Icon: pi.icon });
            }
          }
          const stageDefs = [
            { key: 'stt', label: 'STT', desc: 'Speech-to-Text', color: '#38bdf8', enabled: sttEnabled },
            { key: 'llm', label: 'LLM', desc: 'Translation / AI', color: '#a78bfa', enabled: true },
            { key: 'tts', label: 'TTS', desc: 'Text-to-Speech', color: '#fbbf24', enabled: ttsEnabled },
          ];
          return (
            <div className="flex items-start justify-between mt-4 gap-4 pt-3"
              style={{ borderTop: '1px solid var(--color-border)' }}>
              {/* Stage glossary — rectangle shape indicator */}
              <div className="flex items-center gap-3">
                {/* Shape key: rectangle = stage */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className="w-5 h-3.5 border"
                    style={{ borderRadius: '2px', borderColor: 'var(--color-text-muted)', borderTop: '2px solid var(--color-text-muted)', opacity: 0.5 }} />
                  <span className="text-[9px] font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--color-text-muted)' }}>Stage</span>
                </div>
                {stageDefs.map(s => (
                  <div key={s.key} className="flex items-center gap-1" style={{ opacity: s.enabled ? 1 : 0.35 }}>
                    <span className="text-[10px] font-bold px-1.5 py-0.5"
                      style={{ borderRadius: '2px', borderTop: `2px solid ${s.color}`, border: `1px solid color-mix(in srgb, ${s.color} 35%, transparent)`, background: `color-mix(in srgb, ${s.color} 8%, transparent)`, color: s.color }}>
                      {s.label}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{s.desc}</span>
                  </div>
                ))}
              </div>
              {/* Provider legend */}
              {seen.size > 0 && (
                <div className="flex items-center gap-2.5 flex-shrink-0">
                  {/* Shape key: card = service */}
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 h-3.5 border"
                      style={{ borderRadius: '4px', borderColor: 'var(--color-text-muted)', borderLeft: '2px solid var(--color-text-muted)', opacity: 0.45 }} />
                    <span className="text-[9px] font-semibold uppercase tracking-widest"
                      style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}>Service</span>
                  </div>
                  {[...seen.values()].map(({ label, color, Icon }) => (
                    <div key={label} className="flex items-center gap-1">
                      <Icon className="w-3 h-3 flex-shrink-0" style={{ color }} />
                      <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Test Results (auto-shows when results exist) ── */}
        {(testResult || testError) && (
          <div className="mt-3 pt-3 space-y-2" style={{ borderTop: '1px solid var(--color-border)' }}>

              {/* Results */}
              {testError && (
                <div className="text-xs px-3 py-2 rounded-lg"
                  style={{ background: 'color-mix(in srgb, #ef4444 8%, transparent)', color: '#ef4444' }}>
                  {testError}
                </div>
              )}

              {testResult && !testError && (
                <div className="space-y-2">
                  {/* Timing row */}
                  <div className="flex items-center gap-3 flex-wrap text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    {testResult.totalMs != null && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" /> {(testResult.totalMs / 1000).toFixed(2)}s total
                      </span>
                    )}
                    {testResult.ttfacMs != null && (
                      <span className="flex items-center gap-1" style={{ color: '#f59e0b' }}>
                        <Timer className="w-2.5 h-2.5" /> TTFAC: {testResult.ttfacMs}ms
                      </span>
                    )}
                    {testResult.usedGpu && (
                      <span className="flex items-center gap-1" style={{ color: '#f59e0b' }}>
                        <Cpu className="w-2.5 h-2.5" /> GPU
                      </span>
                    )}
                    {testResult.stages.filter(s => s.latencyMs != null).map(s => {
                      const stageColor = s.key === 'stt' ? '#38bdf8' : s.key === 'llm' ? '#a78bfa' : '#fbbf24';
                      return (
                        <span key={s.key} className="flex items-center gap-1">
                          <span className="font-semibold" style={{ color: stageColor }}>{s.key.toUpperCase()}</span>
                          <span className="font-mono">{s.latencyMs! < 1000 ? `${s.latencyMs}ms` : `${(s.latencyMs! / 1000).toFixed(1)}s`}</span>
                        </span>
                      );
                    })}
                  </div>

                  {testResult.transcription && (
                    <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'color-mix(in srgb, #38bdf8 5%, var(--color-surface-elevated))' }}>
                      <span className="text-[9px] font-semibold uppercase tracking-wider block mb-0.5" style={{ color: '#38bdf8' }}>Transcription</span>
                      {testResult.transcription}
                    </div>
                  )}
                  {testResult.translation && (
                    <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'color-mix(in srgb, #a78bfa 5%, var(--color-surface-elevated))' }}>
                      <span className="text-[9px] font-semibold uppercase tracking-wider block mb-0.5" style={{ color: '#a78bfa' }}>Translation</span>
                      {testResult.translation}
                    </div>
                  )}
                  {testResult.audioBase64 && (
                    <Button size="sm" variant={testPlaying ? 'outline' : 'primary'} onClick={toggleTestAudio}>
                      {testPlaying ? <><Square className="w-3 h-3" /> Stop audio</> : <><Volume2 className="w-3 h-3" /> Play audio</>}
                    </Button>
                  )}
                </div>
              )}
          </div>
        )}
      </div>

      {/* ── Benchmark Results ── */}
      {(benchResult || benchError) && (
        <div className="px-6 pb-5">
          <div className="pt-4 space-y-3" style={{ borderTop: '1px solid var(--color-border)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5" style={{ color: '#8b5cf6' }} />
                <span className="text-xs font-bold" style={{ color: '#8b5cf6' }}>Provider Comparison</span>
                {benchResult?.durationMs != null && (
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    ({(benchResult.durationMs / 1000).toFixed(1)}s)
                  </span>
                )}
                <button type="button"
                  onClick={() => setBenchAdvanced(prev => !prev)}
                  className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg border cursor-pointer transition-all"
                  style={{
                    borderColor: benchAdvanced ? 'color-mix(in srgb, #8b5cf6 30%, transparent)' : 'var(--color-border)',
                    color: benchAdvanced ? '#8b5cf6' : 'var(--color-text-muted)',
                    background: benchAdvanced ? 'color-mix(in srgb, #8b5cf6 8%, transparent)' : 'transparent',
                  }}>
                  <Settings2 className="w-3 h-3" />
                  Advanced
                  <ChevronDown className={`w-3 h-3 transition-transform ${benchAdvanced ? 'rotate-180' : ''}`} />
                </button>
              </div>
              <button type="button" onClick={() => { setBenchResult(null); setBenchError(null); }}
                className="p-1 rounded hover:bg-white/10 cursor-pointer transition-colors">
                <XIcon className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
              </button>
            </div>

            {/* Advanced config panel */}
            {benchAdvanced && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 p-3 rounded-lg"
                style={{ background: 'color-mix(in srgb, #8b5cf6 4%, var(--color-surface))' }}>
                <div>
                  <label className="text-[9px] font-bold uppercase mb-1 block" style={{ color: 'var(--color-text-muted)' }}>Per-stage iters</label>
                  <input type="number" value={benchIterations} min={1} max={20}
                    onChange={e => setBenchIterations(Math.max(1, Math.min(20, parseInt(e.target.value) || 3)))}
                    className="w-full text-xs font-mono px-2 py-1.5 rounded-lg border"
                    style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }} />
                </div>
                <div>
                  <label className="text-[9px] font-bold uppercase mb-1 block" style={{ color: 'var(--color-text-muted)' }}>Pipeline iters</label>
                  <input type="number" value={benchPipelineIts} min={0} max={30}
                    onChange={e => setBenchPipelineIts(Math.max(0, Math.min(30, parseInt(e.target.value) || 5)))}
                    className="w-full text-xs font-mono px-2 py-1.5 rounded-lg border"
                    style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }} />
                </div>
                <div>
                  <label className="text-[9px] font-bold uppercase mb-1 block" style={{ color: 'var(--color-text-muted)' }}>Warmup iters</label>
                  <input type="number" value={benchWarmupIts} min={0} max={10}
                    onChange={e => setBenchWarmupIts(Math.max(0, Math.min(10, parseInt(e.target.value) || 2)))}
                    className="w-full text-xs font-mono px-2 py-1.5 rounded-lg border"
                    style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }} />
                </div>
                <div className="flex flex-col gap-1.5 justify-center">
                  <div className="flex items-center gap-2">
                    <Toggle checked={benchIncludeGpu} onChange={setBenchIncludeGpu} size="sm" />
                    <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>GPU</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Toggle checked={benchIncludeCloud} onChange={setBenchIncludeCloud} size="sm" />
                    <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>Cloud</span>
                  </div>
                </div>
                <div className="flex items-end">
                  <button type="button" disabled={benchRunning} onClick={runBenchmark}
                    className="flex items-center gap-1.5 text-[10px] font-semibold px-3 py-1.5 rounded-lg border cursor-pointer transition-all w-full justify-center"
                    style={{
                      background: 'color-mix(in srgb, #8b5cf6 10%, transparent)',
                      borderColor: 'color-mix(in srgb, #8b5cf6 30%, transparent)',
                      color: '#8b5cf6', opacity: benchRunning ? 0.7 : 1,
                    }}>
                    {benchRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    {benchRunning ? 'Running...' : 'Re-run'}
                  </button>
                </div>
              </div>
            )}

            {benchError && (
              <div className="text-xs px-3 py-2 rounded-lg"
                style={{ background: 'color-mix(in srgb, #ef4444 8%, transparent)', color: '#ef4444' }}>
                {benchError}
              </div>
            )}

            {benchResult?.notes && benchResult.notes.length > 0 && (
              <div className="text-[10px] px-3 py-1.5 rounded-lg"
                style={{ background: 'color-mix(in srgb, #f59e0b 8%, transparent)', color: '#f59e0b' }}>
                {benchResult.notes.join(' | ')}
              </div>
            )}

            {benchResult && (
              <>
                {/* GPU status (advanced) */}
                {benchAdvanced && benchResult.gpuStatus && (
                  <div className="flex items-center gap-2 text-[10px]">
                    <div className={`w-1.5 h-1.5 rounded-full ${benchResult.gpuStatus.available ? 'bg-emerald-500' : 'bg-gray-500'}`} />
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      GPU: {benchResult.gpuStatus.available
                        ? `${benchResult.gpuStatus.gpuType} (${benchResult.gpuStatus.dockerImage.split('/').pop()})`
                        : 'unavailable'}
                    </span>
                  </div>
                )}

                {/* Per-stage provider latency bars */}
                {benchResult.stages && (
                  <div className="space-y-3">
                    {(['stt', 'llm', 'tts'] as const).map(stageKey => {
                      const stageData = benchResult.stages[stageKey] as StageBenchResult | undefined;
                      if (!stageData?.providers) return null;
                      const STAGE_COLORS: Record<string, string> = { stt: '#38bdf8', llm: '#a78bfa', tts: '#fbbf24' };
                      const color = STAGE_COLORS[stageKey] || '#8b949e';
                      const entries = Object.entries(stageData.providers)
                        .filter(([, v]) => v && v.available && v.avg > 0)
                        .sort(([, a], [, b]) => (a?.avg ?? Infinity) - (b?.avg ?? Infinity));
                      if (entries.length === 0) return null;
                      const maxAvg = Math.max(...entries.map(([, v]) => v?.avg ?? 0), 1);

                      return (
                        <div key={stageKey}>
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
                              {stageKey}
                            </span>
                            {stageData.fastest && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                                background: 'color-mix(in srgb, #10b981 10%, transparent)', color: '#10b981',
                              }}>fastest: {stageData.fastest}</span>
                            )}
                          </div>
                          <div className="space-y-1">
                            {entries.map(([provider, data]) => {
                              if (!data) return null;
                              const isFastest = provider === stageData.fastest;
                              const barPct = Math.max(8, (data.avg / maxAvg) * 100);
                              const pi = PROVIDER_ICON[provider];
                              const provColor = pi?.color ?? pMeta(provider).color;
                              return (
                                <div key={provider} className="flex items-center gap-2">
                                  <span className="text-[10px] font-semibold w-16 text-right truncate flex-shrink-0"
                                    style={{ color: isFastest ? '#10b981' : provColor }}>
                                    {pMeta(provider).label}
                                  </span>
                                  <div className="flex-1 h-4 rounded-full overflow-hidden relative"
                                    style={{ background: 'color-mix(in srgb, var(--color-text) 5%, transparent)' }}>
                                    <div className="h-full rounded-full transition-all duration-500 flex items-center justify-end pr-1.5"
                                      style={{
                                        width: `${barPct}%`,
                                        background: isFastest
                                          ? 'linear-gradient(90deg, color-mix(in srgb, #10b981 30%, transparent), #10b981)'
                                          : `linear-gradient(90deg, color-mix(in srgb, ${provColor} 20%, transparent), color-mix(in srgb, ${provColor} 60%, transparent))`,
                                      }}>
                                      <span className="text-[9px] font-bold font-mono whitespace-nowrap"
                                        style={{ color: isFastest ? '#10b981' : provColor }}>
                                        {data.avg < 1000 ? `${data.avg}ms` : `${(data.avg / 1000).toFixed(1)}s`}
                                      </span>
                                    </div>
                                  </div>
                                  {isFastest && <Trophy className="w-3 h-3 flex-shrink-0" style={{ color: '#10b981' }} />}
                                  {benchAdvanced && data.p95 !== undefined && (
                                    <span className="text-[9px] font-mono flex-shrink-0 flex gap-2" style={{ color: 'var(--color-text-muted)' }}>
                                      <span>p95={data.p95}ms</span>
                                      <span>min={data.min}ms</span>
                                      {data.errors > 0 && <span style={{ color: '#f87171' }}>err={data.errors}</span>}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Best path combinations */}
                {benchResult.paths && Object.keys(benchResult.paths).length > 0 && (
                  <div className="pt-3 mt-1" style={{ borderTop: '1px solid var(--color-border)' }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Zap className="w-3 h-3" style={{ color: '#f59e0b' }} />
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#f59e0b' }}>
                        Best Combinations
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {Object.entries(benchResult.paths)
                        .sort(([, a], [, b]) => (a as PathOption).totalAvg - (b as PathOption).totalAvg)
                        .slice(0, 5)
                        .map(([pathKey, path], idx) => {
                          const p = path as PathOption;
                          const isRecommended = benchResult.recommendation?.path === pathKey;
                          const maxTotal = Math.max(
                            ...Object.values(benchResult.paths).map(v => (v as PathOption).totalAvg), 1
                          );
                          const barPct = Math.max(12, (p.totalAvg / maxTotal) * 100);
                          return (
                            <div key={pathKey}
                              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-all"
                              style={{
                                borderColor: isRecommended
                                  ? 'color-mix(in srgb, #10b981 40%, transparent)'
                                  : 'color-mix(in srgb, var(--color-border) 50%, transparent)',
                                background: isRecommended
                                  ? 'color-mix(in srgb, #10b981 5%, var(--color-surface))'
                                  : 'var(--color-surface)',
                              }}>
                              <span className="text-[10px] font-bold w-4 flex-shrink-0"
                                style={{ color: idx === 0 ? '#10b981' : 'var(--color-text-muted)' }}>
                                #{idx + 1}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="text-[10px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                                  {p.description || pathKey}
                                </div>
                                <div className="h-1.5 rounded-full overflow-hidden mt-1"
                                  style={{ background: 'color-mix(in srgb, var(--color-text) 5%, transparent)' }}>
                                  <div className="h-full rounded-full transition-all duration-500"
                                    style={{
                                      width: `${barPct}%`,
                                      background: idx === 0 ? '#10b981' : 'color-mix(in srgb, var(--color-text) 20%, transparent)',
                                    }} />
                                </div>
                              </div>
                              <span className="text-[11px] font-bold font-mono flex-shrink-0"
                                style={{ color: idx === 0 ? '#10b981' : 'var(--color-text-secondary)' }}>
                                {p.totalAvg < 1000 ? `${p.totalAvg}ms` : `${(p.totalAvg / 1000).toFixed(1)}s`}
                              </span>
                              {isRecommended && (
                                <Trophy className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#10b981' }} />
                              )}
                            </div>
                          );
                        })}
                    </div>
                    {benchResult.recommendation?.reason && (
                      <div className="text-[10px] mt-2 px-2.5 py-1.5 rounded-lg"
                        style={{ background: 'color-mix(in srgb, #10b981 5%, transparent)', color: '#10b981' }}>
                        {benchResult.recommendation.reason}
                      </div>
                    )}
                  </div>
                )}

                {/* Advanced: Recommended routing path */}
                {benchAdvanced && benchResult.recommendation && (
                  <div className="pt-3 mt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Trophy className="w-3 h-3" style={{ color: '#10b981' }} />
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#10b981' }}>
                        Recommended Path
                      </span>
                      <span className="text-lg font-bold font-mono ml-auto" style={{ color: '#10b981' }}>
                        {benchResult.recommendation.estimatedTotalMs}ms
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {(['stt', 'llm', 'tts'] as const).map((stage, i) => {
                        const p = benchResult.recommendation!.routing[stage];
                        if (!p) return null;
                        const pi = PROVIDER_ICON[p];
                        const provColor = pi?.color ?? pMeta(p).color;
                        return (
                          <React.Fragment key={stage}>
                            {i > 0 && <ArrowRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
                            <div className="flex items-center gap-1 px-2 py-1 rounded-lg"
                              style={{ background: `color-mix(in srgb, ${provColor} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${provColor} 25%, transparent)` }}>
                              <span className="text-[9px] font-bold uppercase" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                              <span className="text-[10px] font-semibold" style={{ color: provColor }}>{pMeta(p).label}</span>
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Advanced: Pipeline Progression */}
                {benchAdvanced && benchResult.progression && (
                  <div className="pt-3 mt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Activity className="w-3 h-3" style={{ color: '#8b5cf6' }} />
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#8b5cf6' }}>
                        Pipeline Progression
                      </span>
                      <span className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                        {benchResult.progression.warmupIterations.length} warmup + {benchResult.progression.measuredIterations.length} measured
                      </span>
                    </div>

                    {/* Legend */}
                    <div className="flex gap-3 text-[9px] mb-2" style={{ color: 'var(--color-text-muted)' }}>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded" style={{ background: '#fbbf24' }} /> STT</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded" style={{ background: '#a78bfa' }} /> LLM</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded" style={{ background: '#34d399' }} /> TTS</span>
                    </div>

                    {/* Iteration bars */}
                    {(() => {
                      const all = [...benchResult.progression!.warmupIterations, ...benchResult.progression!.measuredIterations];
                      const maxMs = Math.max(...all.map(it => it.totalMs), 1);
                      return (
                        <div className="space-y-0.5">
                          {benchResult.progression!.warmupIterations.length > 0 && (
                            <div className="text-[9px] mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Warmup (discarded)</div>
                          )}
                          {benchResult.progression!.warmupIterations.map((it, i) => (
                            <div key={`w${i}`} style={{ opacity: 0.5 }}><BenchProgressionRow it={it} maxMs={maxMs} /></div>
                          ))}
                          {benchResult.progression!.warmupIterations.length > 0 && (
                            <div className="border-b my-1.5" style={{ borderColor: 'var(--color-border)' }} />
                          )}
                          <div className="text-[9px] mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Measured</div>
                          {benchResult.progression!.measuredIterations.map((it, i) => (
                            <BenchProgressionRow key={`m${i}`} it={it} maxMs={maxMs} />
                          ))}
                        </div>
                      );
                    })()}

                    {/* Analysis cards */}
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <div className="p-2 rounded-lg" style={{ background: 'var(--color-surface)' }}>
                        <div className="flex items-center gap-1 mb-1">
                          <TrendingDown className="w-3 h-3" style={{ color: '#34d399' }} />
                          <span className="text-[9px] font-medium" style={{ color: 'var(--color-text-muted)' }}>Cold Start</span>
                        </div>
                        <div className="text-sm font-bold font-mono"
                          style={{ color: benchResult.progression!.coldStartPenalty.penaltyMs > 200 ? '#fbbf24' : '#34d399' }}>
                          +{benchResult.progression!.coldStartPenalty.penaltyMs}ms
                        </div>
                        <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                          {benchResult.progression!.coldStartPenalty.firstCallMs}ms first, {benchResult.progression!.coldStartPenalty.warmAvgMs}ms warm
                        </div>
                      </div>

                      <div className="p-2 rounded-lg" style={{ background: 'var(--color-surface)' }}>
                        <div className="flex items-center gap-1 mb-1">
                          <Activity className="w-3 h-3" style={{ color: '#60a5fa' }} />
                          <span className="text-[9px] font-medium" style={{ color: 'var(--color-text-muted)' }}>Trend</span>
                        </div>
                        <div className="text-sm font-bold font-mono"
                          style={{ color: benchResult.progression!.trend.improvementPct > 0 ? '#34d399' : '#f87171' }}>
                          {benchResult.progression!.trend.improvementPct > 0 ? '+' : ''}{benchResult.progression!.trend.improvementPct}%
                        </div>
                        <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                          1st half {benchResult.progression!.trend.firstHalfAvg}ms, 2nd {benchResult.progression!.trend.secondHalfAvg}ms
                        </div>
                      </div>

                      <div className="p-2 rounded-lg" style={{ background: 'var(--color-surface)' }}>
                        <div className="text-[9px] font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Per-Stage</div>
                        {Object.entries(benchResult.progression!.perStageTrend).map(([stage, t]) => (
                          <div key={stage} className="flex items-center gap-1 text-[9px] font-mono">
                            <span className="w-6" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                            <span>{(t as any).first}ms</span>
                            <span style={{ color: (t as any).delta < 0 ? '#34d399' : (t as any).delta > 0 ? '#f87171' : 'var(--color-text-muted)' }}>
                              {(t as any).delta < 0 ? '\u2193' : (t as any).delta > 0 ? '\u2191' : '\u2192'} {Math.abs((t as any).delta)}ms
                            </span>
                            <span>{(t as any).last}ms</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Service chip hover tooltip — portal renders after hydration (mounted gate) */}
      {tooltipMounted && hoveredChip && (() => {
        const stage = stages.find(s => s.key === hoveredChip.stageKey);
        if (!stage) return null;
        const entry = stage.chain[hoveredChip.entryIdx];
        if (!entry) return null;
        const ts = testStages.find(s => s.key === hoveredChip.stageKey);
        const routing = gpu?.pipelineRouting?.[hoveredChip.stageKey as 'stt' | 'llm' | 'tts'];
        const warmth = gpu?.modelWarmth?.[hoveredChip.stageKey];
        const isGpuEntry = entry.provider === 'gpu';
        const svc = isGpuEntry
          ? (services.find(s => s.kind === 'gpu-pod' && s.id === entry.model) ?? services.find(s => s.kind === 'gpu-pod'))
          : null;
        const pi = PROVIDER_ICON[entry.provider];
        const entryColor = pi?.color ?? pMeta(entry.provider).color;
        const mLabel = modelLabel(hoveredChip.stageKey, entry);
        const isUsed = ts?.state === 'done' && ts.provider && (
          ts.provider === entry.provider ||
          ts.provider.startsWith(entry.provider + '/') ||
          (isGpuEntry && ts.provider === 'gpu')
        );

        if (!chipRect) return null;
        const TOOLTIP_W = 300;
        const TOOLTIP_H_EST = 380;
        const GAP = 8;
        // Center tooltip over the chip horizontally
        const tipX = Math.max(8, Math.min(chipRect.left + chipRect.width / 2 - TOOLTIP_W / 2, window.innerWidth - TOOLTIP_W - 8));
        // Show above the chip if there's room, otherwise below
        const renderBelow = chipRect.top < TOOLTIP_H_EST + GAP;
        const tipY = renderBelow ? chipRect.bottom + GAP : chipRect.top - GAP;

        const mi = isGpuEntry ? gpu?.machineInfo : undefined;
        const isActive = isGpuEntry && (routing === 'gpu' || routing === 'local');

        return createPortal(
          <div className="fixed z-[9999]"
            style={{ left: tipX, top: tipY, transform: renderBelow ? 'none' : 'translateY(-100%)', width: TOOLTIP_W }}
            onMouseEnter={cancelHideTooltip}
            onMouseLeave={scheduleHideTooltip}>
            {/* Transparent bridge: fills gap between chip and tooltip so mouse doesn't leave hover area */}
            <div className="absolute w-full" style={{
              height: GAP + 4,
              top: renderBelow ? -(GAP + 4) : '100%',
              left: 0,
            }} onMouseEnter={cancelHideTooltip} />
            <div className="rounded-xl border shadow-2xl text-xs overflow-hidden"
              style={{
                background: 'var(--color-surface-elevated)',
                borderColor: 'var(--color-border)',
                boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
              }}>

              {/* Header bar */}
              <div className="flex items-center gap-2 px-3 py-2.5 border-b"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
                {pi?.icon && <pi.icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: entryColor }} />}
                <span className="font-bold text-[11px] truncate" style={{ color: entryColor }}>
                  {entryLabel(entry)}
                </span>
                <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded"
                    style={{ background: `color-mix(in srgb, ${stage.color} 15%, transparent)`, color: stage.color }}>
                    {stage.label}
                  </span>
                  {hoveredChip.entryIdx > 0 && (
                    <span className="text-[8px] font-semibold uppercase px-1 py-0.5 rounded"
                      style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
                      fallback
                    </span>
                  )}
                  {isGpuEntry && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                      style={{
                        background: isActive ? 'color-mix(in srgb, #10b981 15%, transparent)' : 'color-mix(in srgb, #94a3b8 10%, transparent)',
                        color: isActive ? '#10b981' : '#94a3b8',
                      }}>
                      {isActive ? '● live' : '○ idle'}
                    </span>
                  )}
                </div>
              </div>

              <div className="p-3 space-y-3">

                {/* Model + docker */}
                {(mLabel || svc?.dockerImage) && (
                  <div className="space-y-1">
                    {mLabel && (
                      <div className="flex items-center gap-1.5">
                        <Brain className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                        <span style={{ color: 'var(--color-text)' }}>{mLabel}</span>
                      </div>
                    )}
                    {svc?.dockerImage && (
                      <div className="flex items-center gap-1.5">
                        <Package className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                        <span className="font-mono text-[9px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                          {svc.dockerImage.split('/').pop()}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* ── GPU machine block — show when live pod data OR configured GPU types ── */}
                {isGpuEntry && ((gpu && (gpu.gpuType || gpu.podId || gpu.provider)) || (svc?.gpuTypes && svc.gpuTypes.length > 0)) && (
                  <div className="space-y-2.5">

                    {/* GPU model */}
                    {(gpu?.gpuType || (svc?.gpuTypes && svc.gpuTypes.length > 0)) && (
                      <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
                        style={{ background: 'color-mix(in srgb, var(--color-text) 5%, transparent)', border: '1px solid var(--color-border)' }}>
                        <Cpu className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }} />
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-[11px] truncate" style={{ color: 'var(--color-text)' }}>
                            {gpu?.gpuType || svc?.gpuTypes?.[0] || '—'}
                          </div>
                          {mi?.gpuVramGb
                            ? <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>{mi.gpuVramGb}GB VRAM{mi.numGpus && mi.numGpus > 1 ? ` × ${mi.numGpus}` : ''}</div>
                            : !gpu?.gpuType && svc?.gpuTypes && svc.gpuTypes.length > 1 && (
                              <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }} title={svc.gpuTypes.slice(1).join(', ')}>
                                fallbacks: {svc.gpuTypes.slice(1).join(', ')}
                              </div>
                            )
                          }
                        </div>
                        {mi?.gpuVramGb && (
                          <span className="text-[9px] font-mono font-bold flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
                            {mi.gpuVramGb}GB VRAM
                          </span>
                        )}
                      </div>
                    )}

                    {/* Machine ID + provider */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[9px]">
                      {mi?.instanceId && (
                        <div className="col-span-2">
                          <div style={{ color: 'var(--color-text-muted)' }}>Machine ID</div>
                          <div className="font-mono truncate font-medium" style={{ color: 'var(--color-text)' }}>{mi.instanceId}</div>
                        </div>
                      )}
                      {gpu?.provider && (
                        <div>
                          <div style={{ color: 'var(--color-text-muted)' }}>Provider</div>
                          <div className="font-medium capitalize" style={{ color: 'var(--color-text)' }}>{gpu?.provider}</div>
                        </div>
                      )}
                      {gpu?.costPerHr != null && gpu.costPerHr > 0 && (
                        <div>
                          <div style={{ color: 'var(--color-text-muted)' }}>Cost</div>
                          <div className="font-mono font-medium" style={{ color: 'var(--color-text)' }}>${gpu?.costPerHr.toFixed(3)}/hr</div>
                        </div>
                      )}
                      {gpu?.elapsedSec != null && gpu.elapsedSec > 0 && (
                        <div>
                          <div style={{ color: 'var(--color-text-muted)' }}>Uptime</div>
                          <div className="font-mono font-medium" style={{ color: 'var(--color-text)' }}>
                            {gpu?.elapsedSec < 3600 ? `${Math.floor(gpu.elapsedSec / 60)}m ${gpu.elapsedSec % 60}s` : `${(gpu.elapsedSec / 3600).toFixed(1)}h`}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Hardware specs grid */}
                    {(mi?.ramGb || mi?.diskGb || mi?.cpuCores || mi?.inetDownMbps) && (
                      <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--color-border)' }}>
                        <div className="px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wider border-b"
                          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
                          Hardware
                        </div>
                        <div className="grid grid-cols-2 divide-x divide-y" style={{ borderColor: 'var(--color-border)' }}>
                          {mi?.ramGb && (
                            <div className="px-2.5 py-1.5">
                              <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>RAM</div>
                              <div className="font-mono font-bold text-[11px]" style={{ color: 'var(--color-text)' }}>{Math.round(mi.ramGb)}GB</div>
                            </div>
                          )}
                          {mi?.diskGb && (
                            <div className="px-2.5 py-1.5">
                              <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Disk</div>
                              <div className="font-mono font-bold text-[11px]" style={{ color: 'var(--color-text)' }}>{Math.round(mi.diskGb)}GB</div>
                            </div>
                          )}
                          {mi?.cpuCores && (
                            <div className="px-2.5 py-1.5">
                              <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>CPU</div>
                              <div className="font-mono font-bold text-[11px]" style={{ color: 'var(--color-text)' }}>{mi.cpuCores}c</div>
                            </div>
                          )}
                          {mi?.inetDownMbps && (
                            <div className="px-2.5 py-1.5">
                              <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Network</div>
                              <div className="font-mono font-bold text-[11px]" style={{ color: 'var(--color-text)' }}>{Math.round(mi.inetDownMbps)}↓</div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Location */}
                    {(gpu?.ipLocation || gpu?.region) && (
                      <div className="flex items-center gap-2">
                        <span className="text-base leading-none">{gpu?.ipLocation?.flag ?? '🌍'}</span>
                        <div className="flex-1 min-w-0">
                          <div style={{ color: 'var(--color-text)' }}>
                            {gpu?.ipLocation ? `${gpu.ipLocation.city}, ${gpu.ipLocation.country}` : gpu?.region}
                          </div>
                          {gpu?.region && (
                            <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>{gpu?.region}</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Model warmth */}
                {isGpuEntry && warmth && (
                  <div className="pt-2 border-t flex items-center gap-4" style={{ borderColor: 'var(--color-border)' }}>
                    <div>
                      <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Requests</div>
                      <div className="font-bold font-mono" style={{ color: entryColor }}>{warmth.requests}</div>
                    </div>
                    <div>
                      <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Avg latency</div>
                      <div className="font-bold font-mono" style={{ color: entryColor }}>
                        {warmth.avgLatencyMs < 1000 ? `${Math.round(warmth.avgLatencyMs)}ms` : `${(warmth.avgLatencyMs / 1000).toFixed(1)}s`}
                      </div>
                    </div>
                  </div>
                )}

                {/* Last request (this service was used in test) */}
                {isUsed && ts?.latencyMs != null && (
                  <div className="pt-2 border-t flex items-center gap-4" style={{ borderColor: 'var(--color-border)' }}>
                    <div>
                      <div className="text-[9px]" style={{ color: '#10b981' }}>Last request ✓</div>
                      <div className="font-bold font-mono" style={{ color: '#10b981' }}>
                        {ts.latencyMs < 1000 ? `${ts.latencyMs}ms` : `${(ts.latencyMs / 1000).toFixed(1)}s`}
                      </div>
                    </div>
                    {ts.ttfacMs != null && hoveredChip.stageKey === 'tts' && (
                      <div>
                        <div className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>TTFAC</div>
                        <div className="font-bold font-mono" style={{ color: 'var(--color-text-secondary)' }}>{ts.ttfacMs}ms</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        , document.body);
      })()}

      {/* Context menu portal */}
      {tooltipMounted && menuChip && menuRect && onToggleEntry && (() => {
        const menuStage = stages.find(s => s.key === menuChip.stageKey);
        const menuEntry = menuStage?.chain[menuChip.entryIdx];
        const isMenuEntryDisabled = menuEntry?.enabled === false;
        const menuColor = STAGE_ACCENT[menuChip.stageKey]?.color ?? '#8b949e';
        return createPortal(
          <div
            style={{
              position: 'fixed',
              top: menuRect.bottom + 4,
              left: Math.min(menuRect.left, window.innerWidth - 180),
              zIndex: 10000,
              minWidth: 160,
              background: 'var(--color-surface-elevated)',
              borderColor: 'var(--color-border)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
            className="rounded-lg border py-1 text-xs overflow-hidden"
            onMouseDown={e => e.stopPropagation()}>
            <div className="px-3 py-1.5 border-b"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
              <span className="text-[10px] font-semibold" style={{ color: menuColor }}>
                {menuEntry ? pMeta(menuEntry.provider).label : 'Service'}
              </span>
            </div>
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer"
              style={{ color: isMenuEntryDisabled ? '#10b981' : 'var(--color-text)', background: 'transparent' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => { onToggleEntry(menuChip.stageKey, menuChip.entryIdx); setMenuChip(null); }}>
              {isMenuEntryDisabled
                ? <Eye className="w-3.5 h-3.5" style={{ color: '#10b981' }} />
                : <EyeOff className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />}
              {isMenuEntryDisabled ? 'Enable provider' : 'Disable provider'}
            </button>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}

interface ServiceCardProps {
  service: ProfileService;
  onEdit: () => void;
  onDelete: () => void;
}

interface RaceResult {
  raceCount: number;
  winnerMs: number;
  gpuType?: string;
  provider?: string;
  completedAt: number;
}

function fmtBootTime(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function ServiceCard({ service, onEdit, onDelete }: ServiceCardProps) {
  const isGpu = service.kind === 'gpu-pod';
  const provIcon = !isGpu && service.cloudProvider ? PROVIDER_ICON[service.cloudProvider] : null;
  const color = isGpu ? '#a78bfa' : (provIcon?.color ?? '#7ba896');
  const ServiceIcon = isGpu ? Server : (provIcon?.icon ?? Package);
  const { gpu, refresh } = useGpuStatus(isGpu, 3000);

  const [deploying, setDeploying] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [raceCount, setRaceCount] = useState(1);
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(15);
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const [deployProvider, setDeployProvider] = useState<string>('auto');
  const [overrideImage, setOverrideImage] = useState<string | null>(null);
  const [deployRegion, setDeployRegion] = useState<string>('auto');
  const [spotInstance, setSpotInstance] = useState(false);
  const [autoBenchmark, setAutoBenchmark] = useState(false);
  const [minVramGb, setMinVramGb] = useState(0);
  const [diskGb, setDiskGb] = useState(20);

  // Race tracking
  const [raceStartMs, setRaceStartMs] = useState<number | null>(null);
  const [raceElapsedMs, setRaceElapsedMs] = useState(0);
  const [raceResult, setRaceResult] = useState<RaceResult | null>(null);
  const raceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Match this card's service against the running GPU — compare by dockerImage to avoid all cards activating
  const isThisService = !gpu?.dockerImage || gpu.dockerImage === service.dockerImage ||
    gpu.dockerImage.split('/').pop()?.replace(/:.*$/, '') === (service.dockerImage ?? '').split('/').pop()?.replace(/:.*$/, '');
  const gpuRunning = gpu?.status === 'ready' || gpu?.status === 'creating' || gpu?.status === 'booting' || gpu?.status === 'installing';
  const isActive = isThisService && gpuRunning;
  const isBooting = isThisService && (gpu?.status === 'creating' || gpu?.status === 'booting' || gpu?.status === 'installing');
  const isReady = isThisService && gpu?.status === 'ready';
  const isError = isThisService && gpu?.status === 'error';
  const isOtherActive = !isThisService && gpuRunning; // another service is running on the GPU

  // Load idle timeout from config on mount
  useEffect(() => {
    if (!isGpu) return;
    getProviderConfig().then((cfg: any) => {
      if (typeof cfg.idleTimeoutMin === 'number') setIdleTimeoutMin(cfg.idleTimeoutMin);
    }).catch(() => {});
  }, [isGpu]);

  // Race timer: tick every second while a race deploy is in progress
  useEffect(() => {
    if (raceStartMs !== null && raceCount > 1 && !isReady && !isError) {
      raceTimerRef.current = setInterval(() => {
        setRaceElapsedMs(Date.now() - raceStartMs);
      }, 1000);
    } else {
      if (raceTimerRef.current) clearInterval(raceTimerRef.current);
    }
    return () => { if (raceTimerRef.current) clearInterval(raceTimerRef.current); };
  }, [raceStartMs, raceCount, isReady, isError]);

  // Capture race result when GPU becomes ready
  useEffect(() => {
    if (isReady && raceStartMs !== null && raceCount > 1 && !raceResult) {
      const ms = Date.now() - raceStartMs;
      setRaceResult({
        raceCount,
        winnerMs: ms,
        gpuType: gpu?.gpuType ?? undefined,
        provider: gpu?.provider ?? undefined,
        completedAt: Date.now(),
      });
      setRaceStartMs(null);
    }
  }, [isReady, raceStartMs, raceCount, raceResult, gpu?.gpuType, gpu?.provider]);

  // Clear race state when not active
  useEffect(() => {
    if (!isActive && !isBooting) {
      setRaceStartMs(null);
      setRaceElapsedMs(0);
    }
  }, [isActive, isBooting]);

  // Auto-benchmark when GPU becomes ready
  const autoBenchmarkTriggered = useRef(false);
  useEffect(() => {
    if (isReady && autoBenchmark && !autoBenchmarkTriggered.current) {
      autoBenchmarkTriggered.current = true;
      benchmarkPaths({}).catch(() => {});
    }
    if (!isReady) {
      autoBenchmarkTriggered.current = false;
    }
  }, [isReady, autoBenchmark]);

  const handleDeploy = async () => {
    setDeploying(true);
    setDeployError(null);
    setRaceResult(null);
    try {
      if (timeoutDirty) {
        await patchProviderConfig({ idleTimeoutMin } as any);
        setTimeoutDirty(false);
      }
      const effectiveImage = overrideImage || service.dockerImage || '';
      const effectiveProvider = deployProvider === 'auto' ? (service.gpuCloudProvider || undefined) : deployProvider;
      const effectiveRegion = deployRegion === 'auto' ? undefined : deployRegion;
      await deployGpu({
        dockerImage: effectiveImage,
        gpuTypes: service.gpuTypes || [],
        provider: effectiveProvider,
        raceCount: raceCount > 1 ? raceCount : undefined,
        interruptible: spotInstance || undefined,
        region: effectiveRegion,
        minVramGb: minVramGb > 0 ? minVramGb : undefined,
        diskGb,
      });
      if (raceCount > 1) setRaceStartMs(Date.now());
      refresh();
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  };

  const handleTerminate = async () => {
    setTerminating(true);
    setDeployError(null);
    setRaceStartMs(null);
    setRaceResult(null);
    try {
      await terminateGpu();
      refresh();
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : 'Terminate failed');
    } finally {
      setTerminating(false);
    }
  };

  return (
    <div className="rounded-xl border transition-all"
      style={{
        borderColor: isReady ? 'color-mix(in srgb, #10b981 40%, var(--color-border))' : 'var(--color-border)',
        background: 'var(--color-surface-elevated)',
      }}>
      <div className="group flex items-start gap-3 p-3">
        <IconBox icon={ServiceIcon} color={color} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{service.name}</span>
            <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded flex-shrink-0"
              style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, color }}>
              {service.kind}
            </span>
          </div>
          {isGpu && (
            <>
              {service.dockerImage && (
                <div className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {service.dockerImage}
                </div>
              )}
              {(service.sttModel || service.llmModel || service.ttsModel) && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {service.sttModel && (() => {
                    const label = (PIPELINE_CATALOG.stt.models as Record<string, { id: string; label: string }[]>).gpu?.find(m => m.id === service.sttModel)?.label ?? service.sttModel;
                    return <span key="stt" className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'color-mix(in srgb, #38bdf8 12%, transparent)', color: '#38bdf8' }}>STT · {label}</span>;
                  })()}
                  {service.llmModel && (() => {
                    const label = (PIPELINE_CATALOG.llm.models as Record<string, { id: string; label: string }[]>).gpu?.find(m => m.id === service.llmModel)?.label ?? service.llmModel;
                    return <span key="llm" className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#a78bfa' }}>LLM · {label}</span>;
                  })()}
                  {service.ttsModel && (() => {
                    const label = (PIPELINE_CATALOG.tts.models as Record<string, { id: string; label: string }[]>).gpu?.find(m => m.id === service.ttsModel)?.label ?? service.ttsModel;
                    return <span key="tts" className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'color-mix(in srgb, #fbbf24 12%, transparent)', color: '#fbbf24' }}>TTS · {label}</span>;
                  })()}
                </div>
              )}
              {service.gpuTypes && service.gpuTypes.length > 0 && (
                <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>
                  {service.gpuTypes.map(g => GPU_TYPES.find(t => t.id === g)?.label || g).join(', ')}
                </div>
              )}
            </>
          )}
          {!isGpu && service.cloudProvider && (
            <div className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {service.cloudProvider}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button type="button" onClick={onEdit}
            className="p-1.5 rounded hover:bg-white/5 cursor-pointer">
            <Pencil className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          </button>
          <button type="button" onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-500/10 cursor-pointer">
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
          </button>
        </div>
      </div>

      {/* GPU Deploy controls */}
      {isGpu && (
        <div className="px-3 pb-3 pt-0 space-y-2">
          {isActive ? (
            <div className="rounded-lg p-2.5 space-y-2"
              style={{
                background: isReady
                  ? 'color-mix(in srgb, #10b981 6%, transparent)'
                  : isError
                    ? 'color-mix(in srgb, #ef4444 6%, transparent)'
                    : 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)',
              }}>
              {/* Status row */}
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  isReady ? 'bg-emerald-500' : isError ? 'bg-red-500' : 'bg-amber-500 animate-pulse'
                }`} />
                <span className="text-[11px] font-semibold" style={{
                  color: isReady ? '#34d399' : isError ? '#ef4444' : '#fbbf24',
                }}>
                  {isReady ? 'Running' : isError ? 'Failed' : gpu?.status || 'Starting...'}
                </span>
                {gpu?.gpuType && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                    style={{ background: 'color-mix(in srgb, #10b981 10%, transparent)', color: '#10b981' }}>
                    {gpu.gpuType}
                  </span>
                )}
                {gpu?.provider && (
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{gpu.provider}</span>
                )}
                <div className="flex-1" />
                <Button variant={isBooting ? 'danger' : 'outline'} size="sm" onClick={handleTerminate} isLoading={terminating} loadingText="...">
                  <Square className="w-3 h-3" /> {isBooting ? 'Cancel' : 'Stop'}
                </Button>
              </div>

              {/* Progress bar during boot */}
              {isBooting && raceCount <= 1 && (
                <div className="w-full rounded-full h-1" style={{ background: 'var(--color-border)' }}>
                  <div className="h-1 rounded-full transition-all duration-1000 animate-pulse"
                    style={{ background: '#10b981', width: `${Math.min(90, Math.max(10, (gpu?.elapsedSec ?? 0) * 0.5))}%` }} />
                </div>
              )}

              {/* Race slots during parallel boot */}
              {isBooting && raceCount > 1 && (
                <div className="space-y-1.5">
                  <p className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: '#a78bfa' }}>
                    Race in progress — {raceCount} instances competing
                  </p>
                  {Array.from({ length: raceCount }).map((_, i) => {
                    const slotElapsed = raceElapsedMs > 0 ? raceElapsedMs : (gpu?.elapsedSec ?? 0) * 1000;
                    // Simulate slight stagger: each slot varies ±3% for visual distinction
                    const stagger = 1 + (i % 3 === 0 ? -0.03 : i % 3 === 1 ? 0.02 : 0.01);
                    const pct = Math.min(88, Math.max(5, (slotElapsed / 1000) * 0.5 * stagger));
                    return (
                      <div key={i} className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-mono w-10 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                            slot {i + 1}
                          </span>
                          <div className="flex-1 rounded-full h-1.5" style={{ background: 'var(--color-border)' }}>
                            <div className="h-1.5 rounded-full transition-all duration-1000"
                              style={{ background: `color-mix(in srgb, #8b5cf6 ${60 + i * 10}%, #06b6d4)`, width: `${pct}%` }} />
                          </div>
                          <span className="text-[9px] font-mono w-8 text-right flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                            {fmtBootTime(slotElapsed)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                    First to respond wins — others are terminated automatically.
                  </p>
                </div>
              )}

              {/* Details */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {(gpu?.elapsedSec ?? 0) > 0 && (
                  <span>Uptime: <span className="font-medium font-mono" style={{ color: 'var(--color-text)' }}>
                    {Math.floor(gpu!.elapsedSec / 60)}m {Math.floor(gpu!.elapsedSec % 60)}s
                  </span></span>
                )}
                {(gpu?.costPerHr ?? 0) > 0 && (
                  <span>Cost: <span className="font-medium font-mono" style={{ color: 'var(--color-text)' }}>
                    ${(gpu!.costPerHr ?? 0).toFixed(3)}/hr
                  </span></span>
                )}
                {gpu?.podId && (
                  <span>ID: <span className="font-mono" style={{ color: 'var(--color-text)' }}>{gpu.podId.slice(0, 12)}</span></span>
                )}
                {gpu?.message && !isReady && (
                  <span className="font-medium" style={{ color: isError ? '#ef4444' : '#fbbf24' }}>{gpu.message}</span>
                )}
              </div>

              {/* Pipeline routing when ready */}
              {isReady && gpu?.pipelineRouting && (
                <div className="flex gap-3 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                  {(['stt', 'llm', 'tts'] as const).map(s => (
                    <span key={s}>{s.toUpperCase()}: <span style={{ color: gpu.pipelineRouting![s] === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting![s]}</span></span>
                  ))}
                </div>
              )}

              {/* Race result banner */}
              {isReady && raceResult && (
                <div className="rounded-lg px-2.5 py-2 flex items-center gap-2"
                  style={{ background: 'color-mix(in srgb, #8b5cf6 8%, transparent)', border: '1px solid color-mix(in srgb, #8b5cf6 25%, transparent)' }}>
                  <Trophy className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#a78bfa' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-semibold" style={{ color: '#c4b5fd' }}>
                      Race complete — winner in <span className="font-mono">{fmtBootTime(raceResult.winnerMs)}</span>
                    </p>
                    <p className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                      {raceResult.raceCount} instances launched · {raceResult.raceCount - 1} terminated
                      {raceResult.gpuType ? ` · ${raceResult.gpuType}` : ''}
                    </p>
                  </div>
                  <button onClick={() => setRaceResult(null)} className="p-0.5 rounded hover:bg-white/5 cursor-pointer flex-shrink-0">
                    <XIcon className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                  </button>
                </div>
              )}

              {/* Error recovery */}
              {isError && (
                <Button size="sm" onClick={handleDeploy} isLoading={deploying} loadingText="Deploying..."
                  disabled={!service.dockerImage || !service.gpuTypes?.length}>
                  <Cpu className="w-3 h-3" /> Retry Deploy
                </Button>
              )}
            </div>
          ) : (
            <>
            {/* Another GPU is running — small amber note above deploy section */}
            {isOtherActive && (
              <div className="rounded-lg px-2.5 py-1.5 flex items-center gap-2"
                style={{ background: 'color-mix(in srgb, #f59e0b 8%, transparent)', border: '1px solid color-mix(in srgb, #f59e0b 25%, transparent)' }}>
                <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#f59e0b' }} />
                <span className="text-[10px] truncate" style={{ color: '#fbbf24' }}>
                  Running:{' '}
                  <span className="font-mono font-semibold">
                    {gpu?.dockerImage?.split('/').pop() ?? 'another service'}
                  </span>
                  {gpu?.gpuType && <span className="font-normal opacity-70"> · {gpu.gpuType}</span>}
                  <span className="opacity-60"> — deploying will terminate it</span>
                </span>
              </div>
            )}
            <div className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 3%, transparent)' }}>

              {/* ── Header ── */}
              <div className="flex items-center gap-1.5 px-3 py-2 border-b"
                style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)' }}>
                <Settings2 className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Deploy Settings</span>
              </div>

              {/* ── Target: Image + Provider + Region ── */}
              <div className="p-3 space-y-2.5">
                {/* Image */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium w-14 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>Image</span>
                  <div className="flex-1">
                    <DropdownList
                      options={DEFAULT_DOCKER_IMAGES.map(img => ({
                        key: img.url,
                        label: img.label,
                        subtitle: img.description,
                      }))}
                      value={overrideImage || service.dockerImage || ''}
                      onChange={key => setOverrideImage(key === service.dockerImage ? null : key)}
                      accent="#a78bfa"
                      size="sm"
                    />
                  </div>
                </div>

                {/* Provider + Region on same row */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Provider</p>
                    <div className="flex gap-1 flex-wrap">
                      {(['auto', ...GPU_PROVIDERS.map(p => p.id)] as const).map(pid => {
                        const prov = GPU_PROVIDERS.find(p => p.id === pid);
                        const label = pid === 'auto' ? 'Auto' : (prov?.name ?? pid);
                        const sel = deployProvider === pid;
                        return (
                          <button key={pid} onClick={() => setDeployProvider(pid)}
                            className="px-2 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer"
                            style={{
                              background: sel ? '#06b6d4' : 'var(--color-surface)',
                              color: sel ? '#fff' : 'var(--color-text-muted)',
                              border: `1px solid ${sel ? '#06b6d4' : 'var(--color-border)'}`,
                            }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Region</p>
                    <div className="flex gap-1 flex-wrap">
                      {(['auto', 'US', 'EU', 'Asia'] as const).map(r => {
                        const sel = deployRegion === r;
                        return (
                          <button key={r} onClick={() => setDeployRegion(r)}
                            className="px-2 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer"
                            style={{
                              background: sel ? '#3b82f6' : 'var(--color-surface)',
                              color: sel ? '#fff' : 'var(--color-text-muted)',
                              border: `1px solid ${sel ? '#3b82f6' : 'var(--color-border)'}`,
                            }}>
                            {r === 'auto' ? 'Auto' : r}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Min VRAM */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium w-14 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>Min VRAM</span>
                  <div className="flex gap-1 flex-wrap">
                    {[0, 8, 16, 24, 40, 80].map(gb => {
                      const sel = minVramGb === gb;
                      return (
                        <button key={gb} onClick={() => setMinVramGb(gb)}
                          className="px-2 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer"
                          style={{
                            background: sel ? 'color-mix(in srgb, #10b981 15%, transparent)' : 'var(--color-surface)',
                            color: sel ? '#34d399' : 'var(--color-text-muted)',
                            border: `1px solid ${sel ? 'color-mix(in srgb, #10b981 40%, transparent)' : 'var(--color-border)'}`,
                          }}>
                          {gb === 0 ? 'Any' : `${gb}GB`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

              {/* ── 3-column: Parallel | Auto-stop | Disk ── */}
              <div className="grid grid-cols-3 divide-x" style={{ borderColor: 'var(--color-border)' } as React.CSSProperties}>
                {/* Parallel launch */}
                <div className="p-2.5">
                  <div className="flex items-center gap-1 mb-1.5">
                    <Zap className="w-3 h-3 flex-shrink-0" style={{ color: '#8b5cf6' }} />
                    <p className="text-[10px] font-semibold truncate" style={{ color: 'var(--color-text)' }}>Parallel</p>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {[1, 2, 3, 5].map(n => (
                      <button key={n} onClick={() => setRaceCount(n)}
                        className="px-2 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer"
                        style={{
                          background: raceCount === n ? '#8b5cf6' : 'var(--color-surface)',
                          color: raceCount === n ? '#fff' : 'var(--color-text-muted)',
                          border: `1px solid ${raceCount === n ? '#8b5cf6' : 'var(--color-border)'}`,
                        }}>
                        {n === 1 ? '1' : `×${n}`}
                      </button>
                    ))}
                  </div>
                  {raceCount === 1 ? (
                    <p className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Standard deploy.</p>
                  ) : (
                    <p className="text-[9px]" style={{ color: '#a78bfa' }}>{raceCount} instances — first wins.</p>
                  )}
                  {raceResult && raceCount === raceResult.raceCount && (
                    <div className="mt-1 flex items-center gap-1 text-[9px]">
                      <Trophy className="w-3 h-3 flex-shrink-0" style={{ color: '#a78bfa' }} />
                      <span className="font-mono font-semibold" style={{ color: '#c4b5fd' }}>{fmtBootTime(raceResult.winnerMs)}</span>
                    </div>
                  )}
                </div>

                {/* Auto-stop */}
                <div className="p-2.5 border-l" style={{ borderColor: 'var(--color-border)' }}>
                  <div className="flex items-center gap-1 mb-1.5">
                    <Timer className="w-3 h-3 flex-shrink-0" style={{ color: '#f59e0b' }} />
                    <p className="text-[10px] font-semibold truncate" style={{ color: 'var(--color-text)' }}>Auto-stop</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[5, 15, 30, 60, 0].map(min => (
                      <button key={min} onClick={() => { setIdleTimeoutMin(min); setTimeoutDirty(true); }}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer"
                        style={{
                          background: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 12%, transparent)' : 'transparent',
                          color: idleTimeoutMin === min ? '#fbbf24' : 'var(--color-text-muted)',
                          border: `1px solid ${idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 35%, transparent)' : 'var(--color-border)'}`,
                        }}>
                        {min === 0 ? 'Never' : `${min}m`}
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                    {idleTimeoutMin === 0 ? 'Manual stop only.' : `Idle ${idleTimeoutMin}m → stop.`}
                  </p>
                </div>

                {/* Disk */}
                <div className="p-2.5 border-l" style={{ borderColor: 'var(--color-border)' }}>
                  <div className="flex items-center gap-1 mb-1.5">
                    <Server className="w-3 h-3 flex-shrink-0" style={{ color: '#60a5fa' }} />
                    <p className="text-[10px] font-semibold truncate" style={{ color: 'var(--color-text)' }}>Disk</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[10, 20, 50, 100].map(gb => (
                      <button key={gb} onClick={() => setDiskGb(gb)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer"
                        style={{
                          background: diskGb === gb ? 'color-mix(in srgb, #60a5fa 12%, transparent)' : 'transparent',
                          color: diskGb === gb ? '#93c5fd' : 'var(--color-text-muted)',
                          border: `1px solid ${diskGb === gb ? 'color-mix(in srgb, #60a5fa 35%, transparent)' : 'var(--color-border)'}`,
                        }}>
                        {gb}GB
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] mt-1" style={{ color: 'var(--color-text-muted)' }}>Container disk.</p>
                </div>
              </div>

              <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

              {/* ── Toggles + footer ── */}
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Toggle checked={spotInstance} onChange={setSpotInstance} size="sm" />
                    <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Spot</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Toggle checked={autoBenchmark} onChange={setAutoBenchmark} size="sm" />
                    <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Benchmark on ready</span>
                  </label>
                  <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    <Clock className="w-3 h-3" /> ~2–5 min
                  </span>
                  {spotInstance && (
                    <span className="flex items-center gap-1 text-[10px]" style={{ color: '#fbbf24' }}>
                      <AlertTriangle className="w-3 h-3" /> Preemptible
                    </span>
                  )}
                </div>
                <Button variant="primary" size="sm" onClick={handleDeploy} isLoading={deploying} loadingText="Deploying..."
                  disabled={!service.dockerImage || !service.gpuTypes?.length}>
                  <Play className="w-3 h-3" /> {raceCount > 1 ? `Race ×${raceCount}` : 'Deploy'}
                </Button>
              </div>
            </div>
            </>
          )}
          {deployError && (
            <p className="text-[10px]" style={{ color: '#ef4444' }}>{deployError}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add/Edit Service inline form ──

type ServiceKind = 'cloud' | 'gpu-pod';

interface ServiceFormProps {
  initial?: ProfileService;
  onSave: (s: ProfileService) => void;
  onCancel: () => void;
}

function ServiceForm({ initial, onSave, onCancel }: ServiceFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState<ServiceKind>(initial?.kind || 'gpu-pod');
  const [cloudProvider, setCloudProvider] = useState(initial?.cloudProvider || 'groq');

  // Docker image: either a known preset or custom URL
  const initDockerUrl = initial?.dockerImage || DEFAULT_DOCKER_IMAGES[0].url;
  const isKnownUrl = (url: string) => DEFAULT_DOCKER_IMAGES.some(img => img.url === url);
  const [dockerImage, setDockerImage] = useState(initDockerUrl);
  const [customDockerUrl, setCustomDockerUrl] = useState(isKnownUrl(initDockerUrl) ? '' : initDockerUrl);
  const [useCustom, setUseCustom] = useState(!isKnownUrl(initDockerUrl));

  const [gpuTypes, setGpuTypes] = useState<string[]>(initial?.gpuTypes || []);
  const [gpuCloudProvider, setGpuCloudProvider] = useState(initial?.gpuCloudProvider || GPU_PROVIDERS[0].id);

  // Auto-fill models from known Docker image (works for both new and edit)
  const knownImg = DEFAULT_DOCKER_IMAGES.find(img => img.url === dockerImage);
  const [sttModel, setSttModel] = useState(initial?.sttModel || knownImg?.sttModel || '');
  const [llmModel, setLlmModel] = useState(initial?.llmModel || knownImg?.llmModel || '');
  const [ttsModel, setTtsModel] = useState(initial?.ttsModel || knownImg?.ttsModel || '');

  // Docker inspect
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<DockerManifest | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleInspect = async () => {
    if (!dockerImage.trim()) return;
    setInspecting(true);
    setInspectError(null);
    setInspectResult(null);
    try {
      const result = await inspectDockerImage(dockerImage.trim());
      if (!mountedRef.current) return;
      setInspectResult(result);
      if (result.sttModel) setSttModel(result.sttModel);
      if (result.llmModel) setLlmModel(result.llmModel);
      if (result.ttsModel) setTtsModel(result.ttsModel);
    } catch (err) {
      if (!mountedRef.current) return;
      setInspectError(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      if (mountedRef.current) setInspecting(false);
    }
  };

  // Live GPU catalog from provider
  const [liveGpus, setLiveGpus] = useState<GpuTypeInfo[]>([]);
  const [gpuLoading, setGpuLoading] = useState(false);

  useEffect(() => {
    setGpuLoading(true);
    setLiveGpus([]);
    getGpuTypes(gpuCloudProvider)
      .then(data => setLiveGpus(data.gpuTypes))
      .catch(() => {
        // fall back to static list
        const ids = GPU_TYPES_BY_PROVIDER[gpuCloudProvider] ?? GPU_TYPES.map(g => g.id);
        setLiveGpus(ids.map(id => {
          const meta = GPU_TYPES.find(g => g.id === id);
          return { name: id, shortName: meta?.label ?? id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, ''), vram: parseInt(meta?.vram ?? '0') };
        }));
      })
      .finally(() => setGpuLoading(false));
  }, [gpuCloudProvider]);

  const toggleGpu = (id: string) =>
    setGpuTypes(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);


  const handleSave = () => {
    if (!name.trim()) return;
    const s: ProfileService = {
      id: initial?.id || uid(),
      name: name.trim(),
      kind,
      ...(kind === 'cloud'
        ? { cloudProvider }
        : {
            dockerImage, gpuTypes, gpuCloudProvider,
            ...(sttModel ? { sttModel } : {}),
            ...(llmModel ? { llmModel } : {}),
            ...(ttsModel ? { ttsModel } : {}),
          }),
    };
    onSave(s);
  };

  return (
    <div className="rounded-xl border border-dashed overflow-hidden"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 3%, transparent)' }}>
        <IconBox icon={Server} color="#a78bfa" size="sm" />
        <span className="text-sm font-semibold">{initial ? 'Edit Service' : 'New Service'}</span>
      </div>

      <div className="p-4 space-y-4">

        {/* ── Identity section ── */}
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Identity</p>
          <FormInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="GPU Pod A" />
          {/* Kind toggle */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Type</label>
            <div className="flex gap-2">
              {(['gpu-pod', 'cloud'] as const).map(k => {
                const sel = kind === k;
                const KIcon = k === 'gpu-pod' ? Cpu : Cloud;
                return (
                  <button key={k} type="button" onClick={() => setKind(k)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
                    style={{
                      background: sel ? 'color-mix(in srgb, #a78bfa 12%, transparent)' : 'var(--color-surface-elevated)',
                      borderColor: sel ? '#a78bfa' : 'var(--color-border)',
                      color: sel ? '#c4b5fd' : 'var(--color-text-muted)',
                    }}>
                    <KIcon className="w-3.5 h-3.5" />
                    {k === 'gpu-pod' ? 'GPU Pod' : 'Cloud API'}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {kind === 'cloud' ? (
          /* ── Cloud provider buttons ── */
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Cloud Provider</p>
            <div className="flex flex-wrap gap-2">
              {(['groq', 'openai', 'deepgram', 'fireworks', 'modal', 'tensordock'] as const).map(pid => {
                const provIcon = PROVIDER_ICON[pid];
                const ProvIcon = provIcon?.icon ?? Package;
                const provColor = provIcon?.color ?? '#7ba896';
                const sel = cloudProvider === pid;
                return (
                  <button key={pid} type="button" onClick={() => setCloudProvider(pid)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer capitalize"
                    style={{
                      background: sel ? `color-mix(in srgb, ${provColor} 12%, transparent)` : 'var(--color-surface-elevated)',
                      borderColor: sel ? provColor : 'var(--color-border)',
                      color: sel ? provColor : 'var(--color-text-muted)',
                    }}>
                    <ProvIcon className="w-3.5 h-3.5" />
                    {pid}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* ── Docker Image section ── */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Docker Image</p>
              {!useCustom ? (
                <>
                  <DropdownList
                    options={DEFAULT_DOCKER_IMAGES.map(img => ({
                      key: img.url,
                      label: img.label,
                      subtitle: img.description,
                    }))}
                    value={dockerImage}
                    onChange={key => {
                      const img = DEFAULT_DOCKER_IMAGES.find(i => i.url === key);
                      setDockerImage(key);
                      setInspectResult(null);
                      setInspectError(null);
                      if (img) {
                        setSttModel(img.sttModel || '');
                        setLlmModel(img.llmModel || '');
                        setTtsModel(img.ttsModel || '');
                        if (!name || DEFAULT_DOCKER_IMAGES.some(i => `Babelcast ${i.label}` === name)) {
                          setName(`Babelcast ${img.label}`);
                        }
                      }
                    }}
                    accent="#a78bfa"
                    size="sm"
                    placeholder="Select Docker image..."
                  />
                  <button
                    type="button"
                    onClick={() => { setUseCustom(true); setCustomDockerUrl(dockerImage); }}
                    className="text-[10px] font-medium transition-colors cursor-pointer mt-1.5"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Use a custom Docker image URL"
                  >
                    + Custom image URL
                  </button>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      className="flex-1 text-xs rounded-lg border px-3 py-2 outline-none focus:ring-1"
                      style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                      value={customDockerUrl}
                      onChange={e => {
                        const url = e.target.value;
                        setCustomDockerUrl(url);
                        setDockerImage(url);
                        setInspectResult(null);
                        setInspectError(null);
                      }}
                      placeholder="namespace/image:tag"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleInspect}
                      disabled={inspecting || !customDockerUrl.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text-secondary)' }}
                      title="Read service capabilities from Docker Hub labels"
                    >
                      {inspecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                      Inspect
                    </button>
                    <button
                      type="button"
                      onClick={() => { setUseCustom(false); setDockerImage(DEFAULT_DOCKER_IMAGES[0].url); }}
                      className="px-2 py-2 rounded-lg border text-xs transition-colors cursor-pointer"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}
                      title="Back to presets"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {/* Inspect result */}
                  {inspectResult && (
                    <div className="p-2 rounded-lg border text-[11px] space-y-0.5"
                      style={{ borderColor: 'color-mix(in srgb, #10b981 30%, var(--color-border))', background: 'color-mix(in srgb, #10b981 4%, var(--color-surface-elevated))' }}>
                      <div className="font-semibold" style={{ color: '#34d399' }}>
                        Services: {inspectResult.services.length > 0 ? inspectResult.services.join(', ') : '—'}
                        {inspectResult.protocol !== 'rest' && <span className="ml-2" style={{ color: 'var(--color-text-muted)' }}>({inspectResult.protocol})</span>}
                      </div>
                      {[inspectResult.sttModel, inspectResult.llmModel, inspectResult.ttsModel].some(Boolean) && (
                        <div style={{ color: 'var(--color-text-muted)' }}>Models auto-filled ↓</div>
                      )}
                    </div>
                  )}
                  {inspectError && (
                    <div className="p-2 rounded-lg border text-[11px] flex items-center gap-1.5"
                      style={{ borderColor: 'color-mix(in srgb, #f87171 30%, var(--color-border))', color: '#f87171', background: 'color-mix(in srgb, #f87171 4%, var(--color-surface-elevated))' }}>
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      {inspectResult === null && 'No babelcast labels found — '}
                      {inspectError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Models section ── */}
            <div className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'var(--color-border)' }}>
              <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Models provided by this pod</p>
              </div>
              <div className="p-3 space-y-2.5">
                {(['stt', 'llm', 'tts'] as const).map(stage => {
                  const stageModels = (PIPELINE_CATALOG[stage].models as Record<string, { id: string; label: string }[]>).gpu ?? [];
                  const currentVal = stage === 'stt' ? sttModel : stage === 'llm' ? llmModel : ttsModel;
                  const setter = stage === 'stt' ? setSttModel : stage === 'llm' ? setLlmModel : setTtsModel;
                  const hasUnknown = currentVal && !stageModels.find(m => m.id === currentVal);
                  const stageColor = stage === 'stt' ? '#38bdf8' : stage === 'llm' ? '#a78bfa' : '#fbbf24';
                  const StageIcon = stage === 'stt' ? Mic : stage === 'llm' ? Bot : Volume2;
                  return (
                    <div key={stage} className="flex items-center gap-2.5">
                      <div className="flex items-center gap-1.5 w-12 flex-shrink-0">
                        <StageIcon className="w-3 h-3 flex-shrink-0" style={{ color: stageColor }} />
                        <span className="text-[10px] font-semibold uppercase" style={{ color: stageColor }}>{stage}</span>
                      </div>
                      <select
                        className="flex-1 text-xs rounded-lg border px-2 py-1.5 outline-none focus:ring-1 cursor-pointer"
                        style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                        value={currentVal}
                        onChange={e => setter(e.target.value)}
                      >
                        <option value="">— none —</option>
                        {hasUnknown && <option value={currentVal}>{currentVal} (current)</option>}
                        {stageModels.map(m => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Infrastructure section ── */}
            <div className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'var(--color-border)' }}>
              <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Infrastructure</p>
              </div>
              <div className="p-3 space-y-3">
                {/* GPU Cloud Provider as icon buttons */}
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>GPU Cloud Provider</label>
                  <div className="flex gap-2 flex-wrap">
                    {GPU_PROVIDERS.map(p => {
                      const provIcon = PROVIDER_ICON[p.id];
                      const PIcon = provIcon?.icon ?? Cpu;
                      const pColor = provIcon?.color ?? p.color;
                      const sel = gpuCloudProvider === p.id;
                      return (
                        <button key={p.id} type="button"
                          onClick={() => { setGpuCloudProvider(p.id); setGpuTypes([]); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
                          style={{
                            background: sel ? `color-mix(in srgb, ${pColor} 12%, transparent)` : 'var(--color-surface-elevated)',
                            borderColor: sel ? pColor : 'var(--color-border)',
                            color: sel ? pColor : 'var(--color-text-muted)',
                          }}>
                          <PIcon className="w-3.5 h-3.5" />
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* GPU type selection */}
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                    GPU Types
                    {gpuTypes.length > 0 && (
                      <span className="ml-2 px-1.5 py-0.5 rounded-md text-[10px] font-bold"
                        style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#c4b5fd' }}>
                        {gpuTypes.length} selected
                      </span>
                    )}
                  </label>

                  {/* Selected chips (priority order) */}
                  {gpuTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {gpuTypes.map((id, idx) => {
                        const info = liveGpus.find(g => g.name === id);
                        const label = info?.shortName ?? id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, '');
                        return (
                          <span key={id}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
                            style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#c4b5fd', border: '1px solid color-mix(in srgb, #a78bfa 30%, transparent)' }}>
                            <span className="text-[9px] font-bold opacity-60">#{idx + 1}</span>
                            {label}
                            <button type="button" onClick={() => toggleGpu(id)} className="ml-0.5 hover:opacity-70 cursor-pointer">×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Add GPU via DropdownList */}
                  <DropdownList
                    options={liveGpus
                      .filter(g => !gpuTypes.includes(g.name))
                      .map(g => {
                        const vramGb = g.vramGb ?? (g.vram > 0 ? g.vram : null);
                        return {
                          key: g.name,
                          label: g.shortName,
                          subtitle: [vramGb ? `${vramGb}GB` : null, g.minPricePerHr != null ? `$${g.minPricePerHr.toFixed(2)}/hr` : null].filter(Boolean).join(' · ') || undefined,
                        };
                      })}
                    value=""
                    onChange={key => toggleGpu(key)}
                    accent="#a78bfa"
                    size="sm"
                    placeholder={gpuLoading ? 'Loading GPUs...' : gpuTypes.length > 0 ? 'Add another GPU type...' : 'Select GPU type...'}
                  />
                </div>
              </div>{/* end Infrastructure inner */}
            </div>{/* end Infrastructure card */}
          </>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 justify-end pt-1">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!name.trim()}>
            <Check className="w-3.5 h-3.5" /> {initial ? 'Update' : 'Add'}
          </Button>
        </div>
      </div>{/* end form body */}
    </div>
  );
}

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

// ── Main ProfilesSection ──

/** Parse sub-route from URL: /config/profiles/edit/{id} or /config/profiles/new */
function getProfileSubRoute(): { view: 'list' | 'detail'; profileId: string | null } {
  if (typeof window === 'undefined') return { view: 'list', profileId: null };
  const path = window.location.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (path === 'config/profiles/new') return { view: 'detail', profileId: null };
  const m = path.match(/^config\/profiles\/edit\/(.+)$/);
  if (m) return { view: 'detail', profileId: m[1] };
  return { view: 'list', profileId: null };
}

export function ProfilesSection() {
  const initRoute = getProfileSubRoute();
  const [view, setViewRaw] = useState<'list' | 'detail'>(initRoute.view);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(initRoute.profileId);

  /** Navigate view with URL update */
  const setView = useCallback((v: 'list' | 'detail', profileId?: string | null) => {
    setViewRaw(v);
    if (v === 'list') {
      window.history.pushState(null, '', '/config/profiles');
    } else if (profileId) {
      window.history.pushState(null, '', `/config/profiles/edit/${profileId}`);
    } else {
      window.history.pushState(null, '', '/config/profiles/new');
    }
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const onPop = () => {
      const r = getProfileSubRoute();
      setViewRaw(r.view);
      if (r.view === 'detail' && r.profileId) {
        setEditingProfileId(r.profileId);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Detail state
  const [stages, setStages] = useState<ProfileStage[]>(() => DEFAULT_STAGES.map(s => ({ ...s, id: uid() })));
  const [latency, setLatency] = useState<Latency>('realtime');
  const [services, setServices] = useState<ProfileService[]>(() =>
    DEFAULT_DOCKER_IMAGES.map(img => ({
      id: uid(),
      name: `Babelcast ${img.label}`,
      kind: 'gpu-pod' as const,
      dockerImage: img.url,
      gpuTypes: [],
      gpuCloudProvider: 'vast',
      ...(img.sttModel ? { sttModel: img.sttModel } : {}),
      ...(img.llmModel ? { llmModel: img.llmModel } : {}),
      ...(img.ttsModel ? { ttsModel: img.ttsModel } : {}),
    }))
  );

  // Convenience getters for backward compat (used by save/flow diagram)
  const sttStage = stages.find(s => s.key === 'stt' && s.enabled);
  const llmStage = stages.find(s => s.key === 'llm' && s.enabled);
  const ttsStage = stages.find(s => s.key === 'tts' && s.enabled);
  const sttChain = sttStage?.chain || [];
  const llmChain = llmStage?.chain || DEFAULT_LLM;
  const ttsChain = ttsStage?.chain || [];
  const sttEnabled = !!sttStage;
  const ttsEnabled = !!ttsStage;

  /** Migrate old gpuDeploy/gpuImage/gpuTypes top-level fields into ProfileService entries,
   *  and auto-derive cloud API service entries from chain providers. */
  const migrateServices = (p: ProviderProfile & Record<string, unknown>): ProfileService[] => {
    const hasExplicitServices = Array.isArray(p.services);
    const existing: ProfileService[] = hasExplicitServices ? (p.services as ProfileService[]) : [];
    const result: ProfileService[] = [...existing];

    // Migrate GPU pods from legacy gpuDeploy field, OR auto-generate for profiles
    // that have NO services array at all (old format). If the profile has an explicit
    // services array (even empty), respect the user's choice — don't re-inject defaults.
    if (!hasExplicitServices && !result.some(s => s.kind === 'gpu-pod')) {
      const gpuDeploy = p.gpuDeploy as { dockerImage?: string; gpuTypes?: string[] } | undefined;
      const gpuTypes: string[] = gpuDeploy?.gpuTypes ?? (p.gpuTypes as string[] | undefined) ?? [];
      const gpuCloudProvider: string = (p.gpuProvider as string | undefined) ?? 'vast';
      for (const img of DEFAULT_DOCKER_IMAGES) {
        result.push({
          id: uid(),
          name: `Babelcast ${img.label}`,
          kind: 'gpu-pod',
          dockerImage: img.url,
          gpuTypes,
          gpuCloudProvider,
          ...(img.sttModel ? { sttModel: img.sttModel } : {}),
          ...(img.llmModel ? { llmModel: img.llmModel } : {}),
          ...(img.ttsModel ? { ttsModel: img.ttsModel } : {}),
        });
      }
    }

    // Auto-derive cloud API services from chain entries (only for legacy profiles
    // without an explicit services array — don't inject services the user removed)
    if (!hasExplicitServices) {
      const allChains: PipelineChainEntry[] = [
        ...((p.stt as PipelineChainEntry[] | undefined) ?? []),
        ...((p.llm as PipelineChainEntry[] | undefined) ?? []),
        ...((p.tts as PipelineChainEntry[] | undefined) ?? []),
      ];
      for (const entry of allChains) {
        if (entry.provider === 'gpu') continue;
        if (!result.some(s => s.kind === 'cloud' && s.cloudProvider === entry.provider)) {
          const meta = pMeta(entry.provider);
          result.push({ id: uid(), name: meta.label, kind: 'cloud', cloudProvider: entry.provider });
        }
      }
    }

    return result;
  };

  // Service form state
  const [showAddService, setShowAddService] = useState(false);
  const [editingService, setEditingService] = useState<ProfileService | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'pipeline' | 'services'>('pipeline');

  /** Load a profile into stages state */
  const loadProfile = useCallback((p: ProviderProfile) => {
    setStages(profileToStages(p));
    setLatency(p.latency ?? 'realtime');
    const svc = migrateServices(p as ProviderProfile & Record<string, unknown>);
    console.log('[profiles] loadProfile services:', svc.length, svc.map(s => `${s.kind}:${s.name}`));
    setServices(svc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getProviderConfig()
      .then((cfg: any) => {
        if (cfg.profiles?.length) setProfiles(cfg.profiles);
        if (cfg.activeProfileId) setActiveProfileId(cfg.activeProfileId);
        // Load default stages from active pipeline config
        const defaultStages: ProfileStage[] = [];
        if (cfg.pipelineStt?.length) defaultStages.push({ id: uid(), key: 'stt', label: 'STT', chain: cfg.pipelineStt, enabled: true });
        defaultStages.push({ id: uid(), key: 'llm', label: 'LLM', chain: cfg.pipelineLlm?.length ? cfg.pipelineLlm : DEFAULT_LLM, enabled: true });
        if (cfg.pipelineTts?.length) defaultStages.push({ id: uid(), key: 'tts', label: 'TTS', chain: cfg.pipelineTts, enabled: true });
        if (defaultStages.length > 0) setStages(defaultStages);
        // If URL points to a specific profile, open it
        const route = getProfileSubRoute();
        if (route.view === 'detail' && route.profileId && cfg.profiles?.length) {
          const p = (cfg.profiles as ProviderProfile[]).find((x: ProviderProfile) => x.id === route.profileId);
          if (p) {
            setEditingProfileId(p.id);
            loadProfile(p);
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setStages(DEFAULT_STAGES.map(s => ({ ...s, id: uid() })));
    setLatency('realtime');
    setServices([]);
    setEditingProfileId(null);
    setView('detail', null);
  };

  const onApplyProfile = useCallback((profile: ProviderProfile) => {
    setEditingProfileId(profile.id);
    loadProfile(profile);
    setView('detail', profile.id);
  }, [setView, loadProfile]);

  const createCurrentProfile = useCallback((name: string): ProviderProfile => {
    const fields = stagesToProfileFields(stages);
    return {
      id: uid(),
      name,
      latency,
      ...fields,
      services: [...services],
    };
  }, [latency, stages, services]);

  const handleSaveAndApply = async () => {
    // Validate: profile name must not be empty
    const currentName = editingProfileId
      ? profiles.find(p => p.id === editingProfileId)?.name
      : 'New Profile';
    if (!currentName?.trim()) {
      setSaveError('Profile name cannot be empty.');
      return;
    }
    // Validate: LLM chain must have at least one entry
    const llmStageForValidation = stages.find(s => s.key === 'llm' && s.enabled);
    if (!llmStageForValidation?.chain.length) {
      setSaveError('LLM stage must have at least one provider.');
      return;
    }

    setSaving(true);
    setSaveError(null);

    // Snapshot current state for rollback
    const prevProfiles = profiles;
    const prevActiveId = activeProfileId;
    const prevEditingId = editingProfileId;

    try {
      let updatedProfiles: ProviderProfile[];
      let newActiveId: string;

      if (editingProfileId) {
        const fields = stagesToProfileFields(stages);
        updatedProfiles = profiles.map(p => {
          if (p.id !== editingProfileId) return p;
          return { ...p, name: p.name.trim(), latency, ...fields, services };
        });
        newActiveId = editingProfileId;
      } else {
        const p = createCurrentProfile(currentName.trim());
        updatedProfiles = [...profiles, p];
        newActiveId = p.id;
      }

      // Optimistic update
      setProfiles(updatedProfiles);
      setActiveProfileId(newActiveId);
      setEditingProfileId(newActiveId);

      const patch: Record<string, any> = {
        profiles: updatedProfiles,
        activeProfileId: newActiveId,
        pipelineStt: sttEnabled ? sttChain : [],
        pipelineLlm: llmChain,
        pipelineTts: ttsEnabled ? ttsChain : [],
      };

      const gpuService = services.find(s => s.kind === 'gpu-pod');
      if (gpuService) {
        patch.gpuImage = gpuService.dockerImage;
        patch.gpuTypes = gpuService.gpuTypes;
        patch.gpuProvider = gpuService.gpuCloudProvider || '';
      }

      await patchProviderConfig(patch as any);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      // Rollback optimistic state
      setProfiles(prevProfiles);
      setActiveProfileId(prevActiveId);
      setEditingProfileId(prevEditingId);
      setSaveError(err instanceof Error ? err.message : 'Failed to save profile. Check gateway connection.');
    } finally { setSaving(false); }
  };

  const editingProfile = editingProfileId ? profiles.find(p => p.id === editingProfileId) : null;

  if (view === 'list') {
    return (
      <div className="p-6 space-y-5 pb-20">
        <SectionHeader
          title="Profiles"
          subtitle="Manage pipeline profiles"
        />

        <ProfilesPanel
          profiles={profiles} setProfiles={setProfiles}
          activeProfileId={activeProfileId} setActiveProfileId={setActiveProfileId}
          onApplyProfile={onApplyProfile} createCurrentProfile={createCurrentProfile}
        />

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={openNew}>
            <Mic className="w-4 h-4" /> New Profile
          </Button>
        </div>

      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: Back + editable name + Save */}
      <div className="flex items-center gap-3 px-6 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}>
        <button
          onClick={() => setView('list', null)}
          className="flex items-center gap-1 text-sm font-medium cursor-pointer transition-opacity hover:opacity-70 flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ChevronLeft className="w-4 h-4" /> Profiles
        </button>
        <span style={{ color: 'var(--color-border)' }}>/</span>
        <input
          type="text"
          value={editingProfile?.name || ''}
          onChange={e => {
            if (!editingProfileId) return;
            setProfiles(prev => prev.map(p => p.id === editingProfileId ? { ...p, name: e.target.value } : p));
          }}
          placeholder="Profile name..."
          className="flex-1 min-w-0 text-sm font-semibold bg-transparent border-none outline-none"
          style={{ color: 'var(--color-text)' }}
        />
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="primary" onClick={handleSaveAndApply} isLoading={saving} loadingText="Saving...">
            <Check className="w-4 h-4" /> Save & Apply
          </Button>
          {saved && (
            <span className="text-xs text-emerald-400 flex items-center gap-1">
              <Check className="w-3 h-3" /> Saved
            </span>
          )}
        </div>
      </div>

      {/* Save error banner */}
      {saveError && (
        <div className="px-6 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
          <AlertBanner variant="error">
            {saveError}
          </AlertBanner>
        </div>
      )}

      {/* Flow diagram (always visible) */}
      <div className="px-6 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <ProfileFlowDiagram
          sttChain={sttChain} llmChain={llmChain} ttsChain={ttsChain}
          sttEnabled={sttEnabled} ttsEnabled={ttsEnabled}
          services={services} latency={latency}
          name={editingProfile?.name}
          onToggleEntry={(stageKey, entryIdx) => {
            setStages(prev => prev.map(s => {
              if (s.key !== stageKey) return s;
              return {
                ...s,
                chain: s.chain.map((e, i) =>
                  i === entryIdx ? { ...e, enabled: e.enabled === false ? undefined : false } : e
                ),
              };
            }));
          }}
          onToggleStage={(stageKey) => {
            setStages(prev => prev.map(s => s.key === stageKey ? { ...s, enabled: !s.enabled } : s));
          }}
        />
      </div>

      {/* Tabs */}
      {(() => {
        const gpuCount = services.filter(s => s.kind === 'gpu-pod').length;
        const cloudCount = services.filter(s => s.kind === 'cloud').length;
        const tabDefs = [
          { id: 'pipeline' as const, label: 'Pipeline', icon: Mic, color: '#38bdf8', badge: `${stages.length} stages` },
          { id: 'services' as const, label: 'Services', icon: Server, color: '#a78bfa', badge: gpuCount > 0 ? `${gpuCount} GPU · ${cloudCount} cloud` : `${services.length} services` },
        ];
        return (
          <div className="flex items-stretch border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
            {tabDefs.map(tab => {
              const active = detailTab === tab.id;
              const TabIcon = tab.icon;
              return (
                <button key={tab.id} onClick={() => setDetailTab(tab.id)}
                  className="flex-1 flex items-center justify-center gap-2.5 px-4 py-3 text-xs font-semibold transition-all cursor-pointer border-b-2 -mb-px"
                  style={{
                    color: active ? tab.color : 'var(--color-text-muted)',
                    borderBottomColor: active ? tab.color : 'transparent',
                    background: active ? `color-mix(in srgb, ${tab.color} 4%, transparent)` : 'transparent',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = active ? `color-mix(in srgb, ${tab.color} 4%, transparent)` : 'transparent'; }}
                >
                  <TabIcon className="w-4 h-4" />
                  <span>{tab.label}</span>
                  <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                    style={{
                      background: active ? `color-mix(in srgb, ${tab.color} 12%, transparent)` : 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)',
                      color: active ? tab.color : 'var(--color-text-muted)',
                    }}>
                    {tab.badge}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* Tab content (scrollable) */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* ── Pipeline tab ── */}
        {detailTab === 'pipeline' && (
          <StageList stages={stages} setStages={setStages} services={services} />
        )}

        {/* ── Services tab ── */}
        {detailTab === 'services' && (
          <>
            {/* Latency target */}
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl border"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
              <span className="text-xs font-semibold flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>Latency</span>
              <LatencySelector value={latency} onChange={setLatency} />
            </div>

            {services.map(svc => (
              <div key={svc.id}>
                <ServiceCard
                  service={svc}
                  onEdit={() => {
                    if (editingService?.id === svc.id) { setEditingService(null); setShowAddService(false); }
                    else { setEditingService(svc); setShowAddService(true); }
                  }}
                  onDelete={() => setServices(prev => prev.filter(s => s.id !== svc.id))}
                />
                {/* Inline edit form below this card */}
                {showAddService && editingService?.id === svc.id && (
                  <div className="mt-1">
                    <ServiceForm
                      initial={editingService}
                      onSave={s => {
                        setServices(prev => prev.map(x => x.id === s.id ? s : x));
                        setShowAddService(false);
                        setEditingService(null);
                      }}
                      onCancel={() => { setShowAddService(false); setEditingService(null); }}
                    />
                  </div>
                )}
              </div>
            ))}
            {services.length === 0 && !showAddService && (
              <p className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
                No services defined. Add a GPU pod or cloud API service.
              </p>
            )}
            {/* Add new service form (not editing existing) */}
            {showAddService && !editingService ? (
              <ServiceForm
                onSave={s => {
                  setServices(prev => [...prev, s]);
                  setShowAddService(false);
                }}
                onCancel={() => { setShowAddService(false); }}
              />
            ) : !showAddService && (
              <div className="space-y-2">
                {/* Quick-add cloud API services */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Quick add cloud API</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(['groq', 'openai', 'deepgram', 'fireworks', 'modal'] as const).map(pid => {
                      const provIcon = PROVIDER_ICON[pid];
                      const PIcon = provIcon?.icon ?? Cloud;
                      const pColor = provIcon?.color ?? '#7ba896';
                      const alreadyAdded = services.some(s => s.kind === 'cloud' && s.cloudProvider === pid);
                      return (
                        <button key={pid} type="button"
                          disabled={alreadyAdded}
                          onClick={() => {
                            const providerName = pid.charAt(0).toUpperCase() + pid.slice(1);
                            setServices(prev => [...prev, { id: uid(), name: providerName, kind: 'cloud', cloudProvider: pid }]);
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer capitalize disabled:cursor-default"
                          style={{
                            background: alreadyAdded ? `color-mix(in srgb, ${pColor} 8%, transparent)` : 'var(--color-surface-elevated)',
                            borderColor: alreadyAdded ? pColor : 'var(--color-border)',
                            color: alreadyAdded ? pColor : 'var(--color-text-muted)',
                            opacity: alreadyAdded ? 0.7 : 1,
                          }}>
                          <PIcon className="w-3.5 h-3.5" />
                          {pid}
                          {alreadyAdded && <Check className="w-3 h-3 ml-0.5" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Add GPU pod */}
                <button
                  type="button"
                  onClick={() => { setEditingService(null); setShowAddService(true); }}
                  className="flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-xl border border-dashed text-xs font-medium cursor-pointer transition-all hover:border-[var(--color-text-muted)]"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  <Cpu className="w-3.5 h-3.5" /> Add GPU Pod
                </button>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
