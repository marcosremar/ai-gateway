'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  getProviderConfig, patchProviderConfig, deployGpu, terminateGpu, benchmarkPaths,
} from '@/lib/gateway';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import {
  Button, IconBox, Toggle, DropdownList,
} from '@/components/ui';
import {
  Package, Server, Pencil, Clock, Timer, Loader2,
  Play, Square, Cpu, X as XIcon, Trophy, AlertTriangle,
  Settings2, Mic, Bot, Volume2, Trash2, Zap,
} from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES, GPU_TYPES, PIPELINE_CATALOG, GPU_PROVIDERS,
  type ProfileService,
} from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import { fmtBootTime } from './constants';

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
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>

              {/* ── Image row (acts as header) ── */}
              <div className="flex items-center gap-2.5 px-3 py-2.5 border-b"
                style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 3%, transparent)' }}>
                <Settings2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <div className="flex-1 min-w-0">
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

              {/* ── Body: inline rows ── */}
              <div className="px-3 py-2.5 space-y-2">
                {/* Row 1: Provider + Region */}
                <div className="grid grid-cols-[1fr,auto] gap-4 items-start">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 w-[52px]" style={{ color: 'var(--color-text-muted)' }}>Provider</span>
                    <div className="flex gap-1 flex-wrap">
                      {(['auto', ...GPU_PROVIDERS.map(p => p.id)] as const).map(pid => {
                        const prov = GPU_PROVIDERS.find(p => p.id === pid);
                        const label = pid === 'auto' ? 'Auto' : (prov?.name ?? pid);
                        const sel = deployProvider === pid;
                        return (
                          <button key={pid} onClick={() => setDeployProvider(pid)}
                            className="px-2 py-[3px] rounded-md text-[10px] font-medium transition-all cursor-pointer"
                            style={{
                              background: sel ? '#06b6d4' : 'transparent',
                              color: sel ? '#fff' : 'var(--color-text-muted)',
                              border: `1px solid ${sel ? '#06b6d4' : 'var(--color-border)'}`,
                            }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>Region</span>
                    <div className="flex gap-1">
                      {(['auto', 'US', 'EU', 'Asia'] as const).map(r => {
                        const sel = deployRegion === r;
                        return (
                          <button key={r} onClick={() => setDeployRegion(r)}
                            className="px-2 py-[3px] rounded-md text-[10px] font-medium transition-all cursor-pointer"
                            style={{
                              background: sel ? '#3b82f6' : 'transparent',
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

                {/* Row 2: Min VRAM + Disk */}
                <div className="grid grid-cols-[1fr,auto] gap-4 items-start">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 w-[52px]" style={{ color: 'var(--color-text-muted)' }}>VRAM</span>
                    <div className="flex gap-1 flex-wrap">
                      {[0, 8, 16, 24, 40, 80].map(gb => {
                        const sel = minVramGb === gb;
                        return (
                          <button key={gb} onClick={() => setMinVramGb(gb)}
                            className="px-2 py-[3px] rounded-md text-[10px] font-medium transition-all cursor-pointer"
                            style={{
                              background: sel ? 'color-mix(in srgb, #10b981 15%, transparent)' : 'transparent',
                              color: sel ? '#34d399' : 'var(--color-text-muted)',
                              border: `1px solid ${sel ? 'color-mix(in srgb, #10b981 40%, transparent)' : 'var(--color-border)'}`,
                            }}>
                            {gb === 0 ? 'Any' : `${gb}GB`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>Disk</span>
                    <div className="flex gap-1">
                      {[10, 20, 50, 100].map(gb => (
                        <button key={gb} onClick={() => setDiskGb(gb)}
                          className="px-2 py-[3px] rounded-md text-[10px] font-medium transition-all cursor-pointer"
                          style={{
                            background: diskGb === gb ? 'color-mix(in srgb, #60a5fa 12%, transparent)' : 'transparent',
                            color: diskGb === gb ? '#93c5fd' : 'var(--color-text-muted)',
                            border: `1px solid ${diskGb === gb ? 'color-mix(in srgb, #60a5fa 35%, transparent)' : 'var(--color-border)'}`,
                          }}>
                          {gb}GB
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Row 3: Parallel + Auto-stop */}
                <div className="grid grid-cols-[1fr,auto] gap-4 items-start">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 w-[52px]" style={{ color: 'var(--color-text-muted)' }}>
                      <span className="flex items-center gap-1"><Zap className="w-3 h-3" style={{ color: '#8b5cf6' }} />Race</span>
                    </span>
                    <div className="flex gap-1">
                      {[1, 2, 3, 5].map(n => (
                        <button key={n} onClick={() => setRaceCount(n)}
                          className="px-2 py-[3px] rounded-md text-[10px] font-medium transition-all cursor-pointer"
                          style={{
                            background: raceCount === n ? '#8b5cf6' : 'transparent',
                            color: raceCount === n ? '#fff' : 'var(--color-text-muted)',
                            border: `1px solid ${raceCount === n ? '#8b5cf6' : 'var(--color-border)'}`,
                          }}>
                          {n === 1 ? '1' : `×${n}`}
                        </button>
                      ))}
                    </div>
                    {raceCount > 1 && (
                      <span className="text-[9px]" style={{ color: '#a78bfa' }}>{raceCount} instances — first wins</span>
                    )}
                    {raceResult && raceCount === raceResult.raceCount && (
                      <span className="flex items-center gap-1 text-[9px]">
                        <Trophy className="w-3 h-3 flex-shrink-0" style={{ color: '#a78bfa' }} />
                        <span className="font-mono font-semibold" style={{ color: '#c4b5fd' }}>{fmtBootTime(raceResult.winnerMs)}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      <span className="flex items-center gap-1"><Timer className="w-3 h-3" style={{ color: '#f59e0b' }} />Idle</span>
                    </span>
                    <div className="flex gap-1">
                      {[5, 15, 30, 60, 0].map(min => (
                        <button key={min} onClick={() => { setIdleTimeoutMin(min); setTimeoutDirty(true); }}
                          className="px-2 py-[3px] rounded-md text-[10px] font-medium transition-all cursor-pointer"
                          style={{
                            background: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 12%, transparent)' : 'transparent',
                            color: idleTimeoutMin === min ? '#fbbf24' : 'var(--color-text-muted)',
                            border: `1px solid ${idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 35%, transparent)' : 'var(--color-border)'}`,
                          }}>
                          {min === 0 ? '∞' : `${min}m`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Footer: toggles + deploy ── */}
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t"
                style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 3%, transparent)' }}>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Toggle checked={spotInstance} onChange={setSpotInstance} size="sm" />
                    <span className="text-[10px] font-medium" style={{ color: spotInstance ? '#fbbf24' : 'var(--color-text-muted)' }}>
                      Spot{spotInstance ? ' (preemptible)' : ''}
                    </span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Toggle checked={autoBenchmark} onChange={setAutoBenchmark} size="sm" />
                    <span className="text-[10px] font-medium" style={{ color: autoBenchmark ? '#34d399' : 'var(--color-text-muted)' }}>Bench</span>
                  </label>
                  <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    <Clock className="w-3 h-3" /> ~2–5 min
                  </span>
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

export { ServiceCard };
