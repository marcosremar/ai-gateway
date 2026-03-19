'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getRequestLog, getProviderConfig, speechPipeline } from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, FormSelect, AlertBanner, SectionHeader } from '@/components/ui';
import {
  Mic, Upload, Volume2, Zap, Check, X, Loader2,
  ChevronDown, ChevronRight, Cpu, Square, Clock,
} from 'lucide-react';
import { PROVIDER_ICON } from './FallbackChainList';
import type { PipelineChainEntry } from './provider-types';

// ── Types ──────────────────────────────────────────────────────────────────────

type StageState = 'idle' | 'active' | 'done' | 'error';

interface StageStatus {
  key: 'stt' | 'llm' | 'tts';
  label: string;
  sublabel: string;
  color: string;
  state: StageState;
  provider?: string;
  latencyMs?: number;
  startedAt?: number;
}

interface RunRecord {
  id: string;
  startedAt: number;
  finishedAt?: number;
  source: string;
  target: string;
  transcription?: string;
  translation?: string;
  audioBase64?: string;
  contentType?: string;
  totalMs?: number;
  usedGpu?: boolean;
  stages: StageStatus[];
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: 'auto', name: 'Auto-detect' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
];

const STAGE_DEFS: Pick<StageStatus, 'key' | 'label' | 'sublabel' | 'color'>[] = [
  { key: 'stt', label: 'STT', sublabel: 'Speech → Text', color: '#38bdf8' },
  { key: 'llm', label: 'LLM', sublabel: 'Translation', color: '#a78bfa' },
  { key: 'tts', label: 'TTS', sublabel: 'Text → Speech', color: '#fbbf24' },
];

const PROVIDER_LABEL: Record<string, string> = {
  gpu: 'GPU Pod', groq: 'Groq', openai: 'OpenAI', deepgram: 'Deepgram',
  fireworks: 'Fireworks', modal: 'Modal', 'modal-moss': 'Modal MOSS',
  openrouter: 'OpenRouter', elevenlabs: 'ElevenLabs',
};

function primaryProvider(chain: PipelineChainEntry[]): string | undefined {
  if (!chain.length) return undefined;
  return PROVIDER_LABEL[chain[0].provider] ?? chain[0].provider;
}

function makeStages(stt?: string, llm?: string, tts?: string): StageStatus[] {
  return [
    { ...STAGE_DEFS[0], state: 'idle', provider: stt },
    { ...STAGE_DEFS[1], state: 'idle', provider: llm },
    { ...STAGE_DEFS[2], state: 'idle', provider: tts },
  ];
}

// ── Pipeline Flow Visualization ────────────────────────────────────────────────

function PipelineFlowViz({ stages, runningMs }: { stages: StageStatus[]; runningMs: number }) {
  const activeIdx = stages.findIndex(s => s.state === 'active');

  return (
    <div className="rounded-xl border overflow-hidden"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
      <div className="px-5 pt-4 pb-5">
        <div className="flex items-stretch gap-0">

          {/* Mic input node */}
          <div className="flex-shrink-0 flex items-center pt-0.5">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
              <Mic className="w-4.5 h-4.5" style={{ color: 'var(--color-text-muted)' }} />
            </div>
          </div>

          {stages.map((stage, i) => {
            const pi = PROVIDER_ICON[stage.provider ? Object.keys(PROVIDER_LABEL).find(k => PROVIDER_LABEL[k] === stage.provider) ?? '' : ''];
            const isActive = stage.state === 'active';
            const isDone = stage.state === 'done';
            const isError = stage.state === 'error';
            const dotColor = isError ? '#ef4444' : isDone ? '#10b981' : isActive ? stage.color : 'var(--color-border)';
            const borderColor = isError
              ? 'color-mix(in srgb, #ef4444 40%, var(--color-border))'
              : isDone
                ? 'color-mix(in srgb, #10b981 30%, var(--color-border))'
                : isActive
                  ? `color-mix(in srgb, ${stage.color} 50%, var(--color-border))`
                  : 'var(--color-border)';

            return (
              <div key={stage.key} className="flex items-center flex-1 min-w-0">
                {/* Connector arrow */}
                <div className="flex items-center w-8 flex-shrink-0">
                  <div className="flex-1 h-px transition-colors duration-300"
                    style={{ background: isDone || isActive ? `color-mix(in srgb, ${stage.color} 50%, var(--color-border))` : 'var(--color-border)' }} />
                  <svg width="6" height="9" viewBox="0 0 6 9" className="flex-shrink-0">
                    <path d="M0 1 L5 4.5 L0 8"
                      stroke={isDone || isActive ? stage.color : 'var(--color-border)'}
                      strokeWidth="1.5" fill="none" strokeLinecap="round" strokeOpacity={isDone || isActive ? 0.8 : 1} />
                  </svg>
                </div>

                {/* Stage block */}
                <div className="flex-1 min-w-0 relative overflow-hidden border transition-all duration-300"
                  style={{
                    borderRadius: '10px',
                    borderColor,
                    borderTop: `3px solid ${dotColor}`,
                    background: isActive
                      ? `color-mix(in srgb, ${stage.color} 7%, var(--color-surface))`
                      : isDone
                        ? 'color-mix(in srgb, #10b981 4%, var(--color-surface))'
                        : 'var(--color-surface)',
                    padding: '10px 12px 8px',
                  }}>

                  {/* Shimmer when active */}
                  {isActive && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      <div className="absolute inset-y-0 w-1/2 opacity-10 animate-pulse"
                        style={{ background: `linear-gradient(90deg, transparent, ${stage.color}, transparent)` }} />
                    </div>
                  )}

                  {/* Header: label + status indicator */}
                  <div className="flex items-center justify-between gap-1 mb-0.5 relative">
                    <span className="text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: isError ? '#ef4444' : isDone ? '#10b981' : isActive ? stage.color : 'var(--color-text-muted)' }}>
                      {stage.label}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isActive && (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" style={{ color: stage.color }} />
                          <span className="text-[9px] font-mono tabular-nums" style={{ color: stage.color }}>
                            {(runningMs / 1000).toFixed(1)}s
                          </span>
                        </>
                      )}
                      {isDone && (
                        <>
                          <Check className="w-3 h-3" style={{ color: '#10b981' }} />
                          {stage.latencyMs != null && (
                            <span className="text-[9px] font-mono" style={{ color: '#10b981' }}>
                              {stage.latencyMs < 1000 ? `${stage.latencyMs}ms` : `${(stage.latencyMs / 1000).toFixed(1)}s`}
                            </span>
                          )}
                        </>
                      )}
                      {isError && <X className="w-3 h-3" style={{ color: '#ef4444' }} />}
                    </div>
                  </div>

                  {/* Sublabel */}
                  <div className="text-[9px] leading-tight" style={{ color: 'var(--color-text-muted)' }}>
                    {stage.sublabel}
                  </div>

                  {/* Provider chip */}
                  {stage.provider && (
                    <div className="flex items-center gap-1 mt-1.5">
                      {pi && <pi.icon className="w-2.5 h-2.5 flex-shrink-0" style={{ color: isActive || isDone ? pi.color : 'var(--color-text-muted)' }} />}
                      <span className="text-[9px] font-medium truncate"
                        style={{ color: isActive ? pi?.color ?? stage.color : isDone ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}>
                        {stage.provider}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Connector to speaker */}
          <div className="flex items-center w-8 flex-shrink-0">
            <div className="flex-1 h-px transition-colors duration-300"
              style={{ background: stages[2]?.state === 'done' ? 'color-mix(in srgb, #fbbf24 50%, var(--color-border))' : 'var(--color-border)' }} />
            <svg width="6" height="9" viewBox="0 0 6 9" className="flex-shrink-0">
              <path d="M0 1 L5 4.5 L0 8"
                stroke={stages[2]?.state === 'done' ? '#fbbf24' : 'var(--color-border)'}
                strokeWidth="1.5" fill="none" strokeLinecap="round" strokeOpacity="0.8" />
            </svg>
          </div>

          {/* Speaker output node */}
          <div className="flex-shrink-0 flex items-center pt-0.5">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300"
              style={{
                background: stages[2]?.state === 'done'
                  ? 'color-mix(in srgb, #fbbf24 8%, var(--color-surface-elevated))'
                  : 'var(--color-surface-elevated)',
                border: `1px solid ${stages[2]?.state === 'done' ? 'color-mix(in srgb, #fbbf24 35%, transparent)' : 'var(--color-border)'}`,
              }}>
              <Volume2 className="w-4 h-4" style={{ color: stages[2]?.state === 'done' ? '#fbbf24' : 'var(--color-text-muted)' }} />
            </div>
          </div>
        </div>

        {/* Active stage label */}
        {activeIdx >= 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Running <strong style={{ color: stages[activeIdx].color }}>{stages[activeIdx].label}</strong> via {stages[activeIdx].provider ?? '…'}</span>
          </div>
        )}
        {stages.every(s => s.state === 'done') && (
          <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: '#10b981' }}>
            <Check className="w-3 h-3" />
            <span>Pipeline complete</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Run History Item ───────────────────────────────────────────────────────────

function RunItem({ run, index, defaultOpen }: { run: RunRecord; index: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const hasAudio = !!run.audioBase64;
  const isError = !!run.error;
  const allDone = run.stages.every(s => s.state === 'done' || s.state === 'idle');

  const elapsed = run.finishedAt ? run.finishedAt - run.startedAt : null;
  const secsAgo = run.finishedAt ? Math.round((Date.now() - run.finishedAt) / 1000) : null;

  const toggleAudio = () => {
    if (!audioRef.current || !run.audioBase64) return;
    if (!audioUrl) {
      const binary = atob(run.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: run.contentType || 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      audioRef.current.src = url;
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play();
      setPlaying(true);
    }
  };

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onEnd = () => setPlaying(false);
    el.addEventListener('ended', onEnd);
    return () => el.removeEventListener('ended', onEnd);
  }, []);

  return (
    <div className="rounded-xl border overflow-hidden transition-all"
      style={{
        borderColor: isError
          ? 'color-mix(in srgb, #ef4444 25%, var(--color-border))'
          : allDone
            ? 'color-mix(in srgb, #10b981 20%, var(--color-border))'
            : 'var(--color-border)',
        background: 'var(--color-surface)',
      }}>

      {/* Collapsed header */}
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left cursor-pointer hover:bg-white/3 transition-colors">
        {open
          ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />}

        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}>
          #{index}
        </span>

        <span className="text-xs flex-1 min-w-0 truncate" style={{ color: 'var(--color-text)' }}>
          {run.transcription
            ? <><span style={{ color: 'var(--color-text-muted)' }}>{run.source}→{run.target}</span>  {run.transcription}</>
            : isError ? run.error : 'Processing…'
          }
        </span>

        {/* Stage latency pills */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {run.stages.map(s => s.state !== 'idle' && (
            <span key={s.key} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{
                background: s.state === 'done' ? `color-mix(in srgb, ${s.color} 10%, transparent)` : 'color-mix(in srgb, #ef4444 10%, transparent)',
                color: s.state === 'done' ? s.color : '#ef4444',
              }}>
              {s.label}{s.latencyMs != null ? ` ${s.latencyMs < 1000 ? s.latencyMs + 'ms' : (s.latencyMs / 1000).toFixed(1) + 's'}` : ''}
            </span>
          ))}
        </div>

        {elapsed != null && (
          <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {(elapsed / 1000).toFixed(2)}s
          </span>
        )}
        {run.usedGpu && <Cpu className="w-3 h-3 flex-shrink-0" style={{ color: '#f59e0b' }} />}
        {isError && <X className="w-3.5 h-3.5 flex-shrink-0 text-red-400" />}
        {!isError && allDone && <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#10b981' }} />}
      </button>

      {/* Expanded details */}
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          {/* Meta row */}
          <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            <span><strong style={{ color: 'var(--color-text)' }}>{run.source}</strong> → <strong style={{ color: 'var(--color-text)' }}>{run.target}</strong></span>
            {secsAgo != null && <span>{secsAgo < 60 ? `${secsAgo}s ago` : `${Math.round(secsAgo / 60)}m ago`}</span>}
            {run.usedGpu && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                style={{ background: 'color-mix(in srgb, #f59e0b 10%, transparent)', color: '#f59e0b' }}>
                <Cpu className="w-2.5 h-2.5" /> GPU
              </span>
            )}
            {elapsed != null && (
              <span className="flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" /> {(elapsed / 1000).toFixed(2)}s total
              </span>
            )}
          </div>

          {/* Transcription */}
          {run.transcription && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#38bdf8' }}>
                Transcription
              </div>
              <div className="text-sm px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-elevated)' }}>
                {run.transcription}
              </div>
            </div>
          )}

          {/* Translation */}
          {run.translation && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#a78bfa' }}>
                Translation
              </div>
              <div className="text-sm px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-elevated)' }}>
                {run.translation}
              </div>
            </div>
          )}

          {/* Audio playback */}
          {hasAudio && (
            <div className="flex items-center gap-3">
              <Button size="sm" variant={playing ? 'outline' : 'primary'} onClick={toggleAudio}>
                {playing ? <><Square className="w-3 h-3" /> Stop</> : <><Volume2 className="w-3 h-3" /> Play Audio</>}
              </Button>
              <audio ref={audioRef} className="hidden" />
              {!run.audioBase64 && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No audio output</span>}
            </div>
          )}

          {/* Stage timing breakdown */}
          {run.stages.some(s => s.latencyMs != null) && (
            <div className="flex flex-wrap gap-3">
              {run.stages.filter(s => s.latencyMs != null).map(s => {
                const provKey = s.provider ? Object.keys(PROVIDER_LABEL).find(k => PROVIDER_LABEL[k] === s.provider) : undefined;
                const pi = provKey ? PROVIDER_ICON[provKey] : undefined;
                return (
                  <div key={s.key} className="flex items-center gap-1.5 text-[10px]">
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
                    <span className="font-semibold" style={{ color: s.color }}>{s.label}</span>
                    <span className="font-mono" style={{ color: 'var(--color-text-muted)' }}>
                      {s.latencyMs! < 1000 ? `${s.latencyMs}ms` : `${(s.latencyMs! / 1000).toFixed(2)}s`}
                    </span>
                    {s.provider && (
                      <span className="flex items-center gap-0.5" style={{ color: 'var(--color-text-muted)' }}>
                        {pi && <pi.icon className="w-2.5 h-2.5" style={{ color: pi.color }} />}
                        {s.provider}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Error */}
          {run.error && (
            <div className="text-xs px-3 py-2 rounded-lg"
              style={{ background: 'color-mix(in srgb, #ef4444 8%, transparent)', color: '#ef4444' }}>
              {run.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function PipelineTestSection() {
  const [source, setSource] = useState('fr');
  const [target, setTarget] = useState('en');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);

  const [running, setRunning] = useState(false);
  const [runningMs, setRunningMs] = useState(0);
  const [stages, setStages] = useState<StageStatus[]>(() => makeStages());
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [runError, setRunError] = useState<string | null>(null);

  // Active profile chains (for provider labels in stage boxes)
  const [sttChain, setSttChain] = useState<PipelineChainEntry[]>([]);
  const [llmChain, setLlmChain] = useState<PipelineChainEntry[]>([]);
  const [ttsChain, setTtsChain] = useState<PipelineChainEntry[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const stagesRef = useRef<StageStatus[]>(stages);

  useEffect(() => { stagesRef.current = stages; }, [stages]);

  // Load active profile pipeline chains
  useEffect(() => {
    getProviderConfig().then((cfg: any) => {
      if (cfg.pipelineStt?.length) setSttChain(cfg.pipelineStt);
      if (cfg.pipelineLlm?.length) setLlmChain(cfg.pipelineLlm);
      if (cfg.pipelineTts?.length) setTtsChain(cfg.pipelineTts);
    }).catch(() => {});
  }, []);

  // Update idle stage provider labels whenever chains change
  useEffect(() => {
    if (!running) {
      setStages(makeStages(primaryProvider(sttChain), primaryProvider(llmChain), primaryProvider(ttsChain)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sttChain, llmChain, ttsChain]);

  const stopTimers = () => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
  };

  useEffect(() => () => stopTimers(), []);

  const runPipeline = useCallback(async () => {
    const audio = audioFile || recordedBlob;
    if (!audio) return;

    const sttProv = primaryProvider(sttChain);
    const llmProv = primaryProvider(llmChain);
    const ttsProv = primaryProvider(ttsChain);

    setRunError(null);
    setRunning(true);
    startTimeRef.current = Date.now();
    setRunningMs(0);

    // Start with STT active
    const initialStages = makeStages(sttProv, llmProv, ttsProv);
    initialStages[0] = { ...initialStages[0], state: 'active', startedAt: Date.now() };
    setStages(initialStages);

    // Elapsed counter
    elapsedTimerRef.current = setInterval(() => {
      setRunningMs(Date.now() - startTimeRef.current);
    }, 80);

    // Snapshot baseline log ID before sending
    let baselineLogId = 0;
    try {
      const { entries } = await getRequestLog(0, 1);
      if (entries.length) baselineLogId = entries[0].id; // entries come newest-first
    } catch {}

    // Poll logs to detect stage completions in real-time
    const seenStages = new Set<string>();
    pollTimerRef.current = setInterval(async () => {
      try {
        const { entries } = await getRequestLog(baselineLogId, 20);
        for (const entry of entries) {
          if (seenStages.has(entry.stage)) continue;
          seenStages.add(entry.stage);
          const idx = ['stt', 'llm', 'tts'].indexOf(entry.stage);
          if (idx === -1) continue;
          const now = Date.now();
          setStages(prev => {
            const next = prev.map((s, i) => {
              if (i === idx) return { ...s, state: 'done' as const, latencyMs: entry.latencyMs, provider: PROVIDER_LABEL[entry.provider] ?? entry.provider };
              if (i === idx + 1) return { ...s, state: 'active' as const, startedAt: now };
              return s;
            });
            stagesRef.current = next;
            return next;
          });
        }
      } catch {}
    }, 350);

    const runId = `run-${Date.now()}`;
    const runStart = Date.now();

    try {
      const result = await speechPipeline(audio, { source, target });

      // Mark any remaining idle/active stages as done
      setStages(prev => {
        const next = prev.map(s => ({
          ...s,
          state: (s.state === 'idle' || s.state === 'active') ? 'done' as const : s.state,
        }));
        stagesRef.current = next;
        return next;
      });

      const completedRun: RunRecord = {
        id: runId,
        startedAt: runStart,
        finishedAt: Date.now(),
        source,
        target,
        transcription: result.transcription,
        translation: result.response,
        audioBase64: result.audioBase64,
        contentType: result.contentType,
        totalMs: result.timing.totalMs || (Date.now() - runStart),
        usedGpu: result.timing.usedGpu,
        stages: stagesRef.current.map(s => ({ ...s })),
      };

      setHistory(prev => [completedRun, ...prev.slice(0, 9)]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Pipeline failed';
      setRunError(msg);
      setStages(prev => {
        const next = prev.map(s => ({
          ...s,
          state: s.state === 'active' ? 'error' as const : s.state,
        }));
        stagesRef.current = next;
        return next;
      });

      const failedRun: RunRecord = {
        id: runId,
        startedAt: runStart,
        finishedAt: Date.now(),
        source,
        target,
        error: msg,
        stages: stagesRef.current.map(s => ({ ...s })),
      };
      setHistory(prev => [failedRun, ...prev.slice(0, 9)]);
    } finally {
      stopTimers();
      setRunning(false);
    }
  }, [audioFile, recordedBlob, source, target, sttChain, llmChain, ttsChain]);

  // ── Mic recording ──
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recordChunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(recordChunksRef.current, { type: 'audio/webm' });
        setRecordedBlob(blob);
        setAudioFile(null);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setRunError('Microphone access denied');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const hasAudio = !!(audioFile || recordedBlob);
  const audioLabel = audioFile?.name ?? (recordedBlob ? 'Recorded audio' : null);

  return (
    <div className="p-6 space-y-5 pb-20">
      <SectionHeader
        title="Pipeline Test"
        subtitle="Send audio through the full STT → LLM → TTS pipeline and watch each stage in real-time"
      />

      {/* Input card */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Audio Input</h3>
        </CardHeader>
        <CardBody className="space-y-4">
          {/* Language selectors */}
          <div className="grid grid-cols-2 gap-3">
            <FormSelect label="Source Language" value={source} onChange={e => setSource(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <FormSelect label="Target Language" value={target} onChange={e => setTarget(e.target.value)}>
              {LANGUAGES.filter(l => l.code !== 'auto').map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
          </div>

          {/* Audio source buttons */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) { setAudioFile(f); setRecordedBlob(null); }
                e.target.value = '';
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={running}>
              <Upload className="w-3.5 h-3.5" /> Upload Audio
            </Button>

            {!recording ? (
              <Button variant="outline" size="sm" onClick={startRecording} disabled={running}>
                <Mic className="w-3.5 h-3.5" /> Record
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={stopRecording}>
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                Stop Recording
              </Button>
            )}

            {audioLabel && (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg"
                style={{ background: 'color-mix(in srgb, #10b981 8%, transparent)', color: '#10b981', border: '1px solid color-mix(in srgb, #10b981 20%, transparent)' }}>
                <Check className="w-3 h-3" /> {audioLabel}
              </span>
            )}
          </div>

          {runError && <AlertBanner variant="error">{runError}</AlertBanner>}

          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={runPipeline}
              isLoading={running}
              loadingText="Running pipeline…"
              disabled={!hasAudio || running}>
              <Zap className="w-4 h-4" /> Run Pipeline
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Live pipeline flow visualization */}
      <PipelineFlowViz stages={stages} runningMs={runningMs} />

      {/* Run history */}
      {history.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <h3 className="text-sm font-semibold">Run History</h3>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}>
              {history.length}
            </span>
          </div>
          <div className="space-y-2">
            {history.map((run, i) => (
              <RunItem key={run.id} run={run} index={history.length - i} defaultOpen={i === 0} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state when no history and no audio */}
      {history.length === 0 && !running && (
        <div className="text-center py-12" style={{ color: 'var(--color-text-muted)' }}>
          <Zap className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Upload an audio file or record from mic, then hit <strong>Run Pipeline</strong></p>
        </div>
      )}
    </div>
  );
}
