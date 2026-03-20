'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  speechPipeline, benchmarkPaths, type SpeechTransport, type BenchmarkPathsResponse, type PathOption, type StageBenchResult, type ProviderBenchResult, type PipelineIteration,
} from '@/lib/gateway';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import {
  Button, Toggle,
} from '@/components/ui';
import {
  Mic, Check,
  Package, Bot, Volume2, Clock, Gauge, Timer, Loader2, Plus,
  Play, Square, Cpu, X as XIcon, BarChart3, Trophy, Activity,
  TrendingDown, ArrowRight, ChevronDown, Settings2, MoreVertical, Eye, EyeOff, Upload, Zap, Brain,
} from 'lucide-react';
import {
  PIPELINE_CATALOG,
  type PipelineChainEntry, type ProfileService, type Latency,
} from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import {
  STAGE_ACCENT, LATENCY_OPTIONS, pMeta,
  type TestStageStatus, type TestResult, type TestTransport, type TransportLatency, type FlowStage,
} from './constants';

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
  onToggleEntry, onToggleStage, onAddService,
}: {
  sttChain: PipelineChainEntry[]; llmChain: PipelineChainEntry[]; ttsChain: PipelineChainEntry[];
  sttEnabled: boolean; ttsEnabled: boolean;
  services: ProfileService[]; latency: Latency; name?: string;
  onToggleEntry?: (stageKey: string, entryIdx: number) => void;
  onToggleStage?: (stageKey: string) => void;
  onAddService?: () => void;
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
    hideTooltipTimerRef.current = setTimeout(() => {
      // Don't hide if context menu is open — keeps action overlay visible
      if (menuChipRef.current) return;
      setHoveredChip(null);
    }, 400);
  }, []);
  const cancelHideTooltip = useCallback(() => {
    if (hideTooltipTimerRef.current) { clearTimeout(hideTooltipTimerRef.current); hideTooltipTimerRef.current = null; }
  }, []);
  // mounted gate: avoids SSR/hydration mismatch with createPortal
  const [tooltipMounted, setTooltipMounted] = useState(false);
  useEffect(() => { setTooltipMounted(true); }, []);

  // ── Service chip context menu ──
  const [menuChip, setMenuChip] = useState<{ stageKey: string; entryIdx: number } | null>(null);
  const menuChipRef = useRef(menuChip);
  useEffect(() => { menuChipRef.current = menuChip; }, [menuChip]);
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
                  const isChipHovered = (hoveredChip?.stageKey === stage.key && hoveredChip?.entryIdx === j)
                    || (menuChip?.stageKey === stage.key && menuChip?.entryIdx === j);
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
                            {/* Add service */}
                            {onAddService && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); onAddService(); }}
                                title="Add service"
                                className="w-5 h-5 rounded-full flex items-center justify-center shadow-sm"
                                style={{ background: 'color-mix(in srgb, #a78bfa 15%, var(--color-surface-elevated))', border: '1px solid rgba(167,139,250,0.4)' }}>
                                <Plus className="w-2.5 h-2.5" style={{ color: '#a78bfa' }} />
                              </button>
                            )}
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

export { BenchProgressionRow, ProfileFlowDiagram };
