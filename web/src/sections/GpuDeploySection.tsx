'use client';

import { useState, useEffect } from 'react';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import { deployGpu, terminateGpu, getGpuLogs, getProviderConfig, patchProviderConfig } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, Button, FormSelect, FormInput, StatusBadge,
  AlertBanner, CardSectionHeader, SectionHeader, SaveBar,
} from '@/components/ui';
import { Cpu, Play, Square, ScrollText, RefreshCw, Zap, ServerCog, AlertCircle, Loader2, Check, Timer, ChevronDown, ChevronUp, Shuffle } from 'lucide-react';
import { DOCKER_IMAGES, DEFAULT_DOCKER_IMAGES, GPU_TYPES } from './provider-types';

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const TIMEOUT_PRESETS = [5, 10, 15, 30, 60, 0];

export function GpuDeploySection() {
  const { gpu, error: gpuError, refresh } = useGpuStatus(true, 5000);
  const [image, setImage] = useState<string>(DOCKER_IMAGES[0].value);
  const [selectedGpus, setSelectedGpus] = useState<string[]>([GPU_TYPES[0].id]);
  const [provider, setProvider] = useState('');
  const [raceMode, setRaceMode] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Idle timeout
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(15);
  const [customTimeout, setCustomTimeout] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const [timeoutSaving, setTimeoutSaving] = useState(false);
  const [timeoutSaved, setTimeoutSaved] = useState(false);

  useEffect(() => {
    getProviderConfig().then((cfg: any) => {
      if (typeof cfg.idleTimeoutMin === 'number') setIdleTimeoutMin(cfg.idleTimeoutMin);
    }).catch(() => {});
  }, []);

  const handleTimeoutChange = (min: number) => {
    setIdleTimeoutMin(min);
    setTimeoutDirty(true);
    setTimeoutSaved(false);
    setShowCustom(false);
  };

  const handleCustomTimeout = () => {
    const val = parseInt(customTimeout);
    if (!isNaN(val) && val >= 0) {
      handleTimeoutChange(val);
      setCustomTimeout('');
    }
  };

  const saveTimeout = async () => {
    setTimeoutSaving(true);
    try {
      await patchProviderConfig({ idleTimeoutMin } as any);
      setTimeoutDirty(false);
      setTimeoutSaved(true);
      setTimeout(() => setTimeoutSaved(false), 3000);
    } catch {} finally { setTimeoutSaving(false); }
  };

  const isActive = gpu && gpu.status !== 'idle' && gpu.status !== 'error';

  async function handleDeploy() {
    setDeploying(true);
    setActionError(null);
    try {
      await deployGpu({
        dockerImage: image,
        gpuTypes: selectedGpus,
        provider: provider || undefined,
        raceCount: raceMode ? 3 : undefined,
      });
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }

  async function handleTerminate() {
    setTerminating(true);
    setActionError(null);
    try {
      await terminateGpu();
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Terminate failed');
    } finally {
      setTerminating(false);
    }
  }

  async function handleLoadLogs() {
    setLoadingLogs(true);
    setLogsOpen(true);
    try {
      const data = await getGpuLogs();
      setLogs(data.logs || '(no logs)');
    } catch {
      setLogs('Failed to load logs');
    } finally {
      setLoadingLogs(false);
    }
  }

  function toggleGpu(id: string) {
    setSelectedGpus(prev =>
      prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  }

  const selectedImageDesc = DEFAULT_DOCKER_IMAGES.find(d => d.url === image)?.description;
  const providerLabel = provider === 'vast' ? 'Vast.ai' : provider === 'runpod' ? 'RunPod' : provider === 'tensordock' ? 'TensorDock' : provider === 'modal' ? 'Modal' : 'best available';

  return (
    <div className="p-6 space-y-4">
      <SectionHeader
        title="GPU Deploy"
        subtitle="Deploy a self-hosted GPU pod for the full STT + LLM + TTS pipeline"
      />

      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}
      {gpuError && <AlertBanner variant="warning">Cannot fetch GPU status: {gpuError}</AlertBanner>}

      {/* ── Config card ── */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={ServerCog} color="blue" title="Deploy Configuration" subtitle="Image, GPU, and auto-stop" />
        </CardHeader>
        <CardBody className="space-y-4">
          {/* Row 1: Image + Provider */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <FormSelect label="Docker Image" value={image} onChange={e => setImage(e.target.value)}>
                {DOCKER_IMAGES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </FormSelect>
              {selectedImageDesc && (
                <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                  {selectedImageDesc}
                </p>
              )}
            </div>
            <FormSelect label="Provider" value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="">Auto (best available)</option>
              <option value="tensordock">TensorDock</option>
              <option value="vast">Vast.ai</option>
              <option value="runpod">RunPod (Secure)</option>
              <option value="modal">Modal</option>
            </FormSelect>
          </div>

          {/* Row 2: GPU pills (left) + Auto-stop + Actions (right) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* GPU selection */}
            <div
              className="rounded-xl border p-3"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
            >
              <h5 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-muted)' }}>
                GPU Types <span className="font-normal">(select all acceptable)</span>
              </h5>
              <div className="flex flex-wrap gap-1.5">
                {GPU_TYPES.map(gpu => {
                  const selected = selectedGpus.includes(gpu.id);
                  return (
                    <button
                      key={gpu.id}
                      onClick={() => toggleGpu(gpu.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all border cursor-pointer"
                      style={{
                        background: selected ? 'color-mix(in srgb, #10b981 12%, transparent)' : 'transparent',
                        borderColor: selected ? 'color-mix(in srgb, #10b981 40%, transparent)' : 'var(--color-border)',
                        color: selected ? '#10b981' : 'var(--color-text-muted)',
                      }}
                    >
                      {selected && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#10b981' }} />}
                      {gpu.label}
                      <span className="text-[10px] font-normal" style={{ color: selected ? 'color-mix(in srgb, #10b981 60%, transparent)' : 'var(--color-text-muted)' }}>
                        {gpu.vram}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Auto-stop + actions */}
            <div className="space-y-3">
              {/* Auto-stop */}
              <div
                className="rounded-xl border p-3"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
              >
                <h5 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-muted)' }}>
                  <Timer className="w-3 h-3 inline mr-1 -mt-px" />
                  Auto-Stop
                </h5>
                <div className="flex flex-wrap gap-1.5">
                  {TIMEOUT_PRESETS.map(min => (
                    <button key={min} onClick={() => handleTimeoutChange(min)}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer"
                      style={{
                        background: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 10%, transparent)' : 'transparent',
                        borderColor: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 35%, transparent)' : 'var(--color-border)',
                        color: idleTimeoutMin === min ? '#fbbf24' : 'var(--color-text-muted)',
                      }}>
                      {min === 0 ? 'Never' : `${min}m`}
                    </button>
                  ))}
                  {!TIMEOUT_PRESETS.includes(idleTimeoutMin) && idleTimeoutMin > 0 && (
                    <span className="px-2.5 py-1 rounded-lg text-xs font-medium border"
                      style={{ background: 'color-mix(in srgb, #f59e0b 10%, transparent)', borderColor: 'color-mix(in srgb, #f59e0b 35%, transparent)', color: '#fbbf24' }}>
                      {idleTimeoutMin}m
                    </span>
                  )}
                  {showCustom ? (
                    <div className="flex items-center gap-1">
                      <input type="number" min="1" value={customTimeout} onChange={e => setCustomTimeout(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleCustomTimeout(); if (e.key === 'Escape') setShowCustom(false); }}
                        placeholder="min" autoFocus
                        className="w-16 rounded-lg border px-2 py-1 text-xs font-mono"
                        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }} />
                      <Button variant="primary" size="sm" onClick={handleCustomTimeout} disabled={!customTimeout}>Set</Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowCustom(false)}>✕</Button>
                    </div>
                  ) : (
                    <button onClick={() => setShowCustom(true)}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium border border-dashed cursor-pointer"
                      style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                      …
                    </button>
                  )}
                </div>
                {gpu?.status === 'ready' && gpu.idleSec > 0 && (
                  <p className="text-[11px] mt-1.5" style={{ color: idleTimeoutMin > 0 && gpu.idleSec > idleTimeoutMin * 30 ? '#fbbf24' : 'var(--color-text-muted)' }}>
                    Idle {formatUptime(gpu.idleSec)}{idleTimeoutMin > 0 && ` / ${idleTimeoutMin}m`}
                  </p>
                )}
                {timeoutDirty && (
                  <div className="flex items-center gap-2 mt-2">
                    <Button onClick={saveTimeout} isLoading={timeoutSaving} loadingText="Saving..." size="sm">
                      <Check className="w-3 h-3" /> Save
                    </Button>
                    {timeoutSaved && <span className="text-[11px] text-emerald-400">Saved</span>}
                  </div>
                )}
              </div>

              {/* Race mode toggle */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => setRaceMode(v => !v)}
                  className="w-8 h-4 rounded-full transition-all relative cursor-pointer"
                  style={{ background: raceMode ? '#10b981' : 'var(--color-border)' }}
                >
                  <div
                    className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                    style={{ left: raceMode ? '17px' : '2px' }}
                  />
                </div>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  <Shuffle className="w-3 h-3 inline mr-1 -mt-px" />
                  Race mode — deploy to 3 providers simultaneously, use fastest
                </span>
              </label>

              {/* Deploy actions */}
              <div className="flex gap-2">
                <Button onClick={handleDeploy} isLoading={deploying} loadingText="Deploying..." disabled={isActive || selectedGpus.length === 0}>
                  <Zap className="w-4 h-4" /> Deploy to {providerLabel}
                </Button>
                <Button variant="danger" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping..." disabled={!isActive}>
                  <Square className="w-4 h-4" /> Terminate
                </Button>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── Status (only when active) ── */}
      {gpu && gpu.status !== 'idle' && (() => {
        const isReady = gpu.status === 'ready';
        const isError = gpu.status === 'error';
        const isBooting = gpu.status === 'creating' || gpu.status === 'booting' || gpu.status === 'installing';
        const elapsedMin = Math.floor(gpu.elapsedSec / 60);
        const elapsedSecRem = gpu.elapsedSec % 60;
        const gpuProviderLabel = gpu.provider === 'vast' ? 'VAST.ai' : gpu.provider === 'runpod' ? 'RunPod' : gpu.provider === 'tensordock' ? 'TensorDock' : gpu.provider === 'modal' ? 'Modal' : gpu.provider || '—';

        return (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3">
            {/* Status */}
            <div
              className="p-4 rounded-xl border"
              style={{
                borderColor: isReady ? 'color-mix(in srgb, #10b981 40%, transparent)' : isError ? 'color-mix(in srgb, #ef4444 40%, transparent)' : 'var(--color-border)',
                background: isReady ? 'color-mix(in srgb, #10b981 8%, var(--color-surface))' : isError ? 'color-mix(in srgb, #ef4444 8%, var(--color-surface))' : 'var(--color-surface)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium flex items-center gap-2" style={{ color: isReady ? '#10b981' : isError ? '#ef4444' : 'var(--color-text)' }}>
                  {isBooting && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: '#10b981' }} />}
                  {isReady && <Check className="w-3.5 h-3.5" style={{ color: '#10b981' }} />}
                  {isError && <AlertCircle className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                  {gpu.message}
                </p>
                {isBooting && (
                  <span className="text-xs font-mono font-semibold tabular-nums" style={{ color: '#10b981' }}>
                    {elapsedMin}:{elapsedSecRem.toString().padStart(2, '0')}
                  </span>
                )}
                {isReady && gpu.deployDurationMs && (
                  <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                    booted in {(gpu.deployDurationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>

              {isBooting && (
                <div className="mb-3">
                  <div className="w-full rounded-full h-1.5" style={{ background: 'var(--color-border)' }}>
                    <div className="h-1.5 rounded-full transition-all duration-1000 animate-pulse"
                      style={{ background: '#10b981', width: `${Math.min(90, Math.max(10, gpu.elapsedSec * 0.5))}%` }} />
                  </div>
                </div>
              )}

              {isReady && gpu.pipelineRouting && (
                <div className="flex gap-4 text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
                  <span>STT: <span style={{ color: gpu.pipelineRouting.stt === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.stt}</span></span>
                  <span>LLM: <span style={{ color: gpu.pipelineRouting.llm === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.llm}</span></span>
                  <span>TTS: <span style={{ color: gpu.pipelineRouting.tts === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.tts}</span></span>
                  <span>Mode: <span className="font-medium" style={{ color: 'var(--color-text)' }}>{gpu.pipelineRouting.mode}</span></span>
                </div>
              )}

              <div className="flex items-center gap-3">
                {isBooting && (
                  <Button variant="danger" size="sm" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping...">
                    <Square className="w-3.5 h-3.5" /> Cancel
                  </Button>
                )}
                {(isReady || isError) && (
                  <Button variant="danger" size="sm" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping...">
                    <Square className="w-3.5 h-3.5" /> {isReady ? 'Stop' : 'Terminate'}
                  </Button>
                )}
                {isReady && (
                  <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                    up {formatUptime(gpu.elapsedSec)}
                  </span>
                )}
              </div>

              {gpu.alert && <AlertBanner variant="warning" className="mt-3">{gpu.alert}</AlertBanner>}
            </div>

            {/* Instance info — compact right panel */}
            <div
              className="p-4 rounded-xl border w-52 flex-shrink-0 space-y-2"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2 h-2 rounded-full ${isReady ? 'bg-emerald-500' : isBooting ? 'bg-violet-500 animate-pulse' : 'bg-red-500'}`} />
                <span className={`text-xs font-medium ${isReady ? 'text-emerald-400' : isBooting ? 'text-violet-400' : 'text-red-400'}`}>
                  {isReady ? 'Online' : isBooting ? 'Booting...' : 'Failed'}
                </span>
              </div>
              {[
                gpu.provider && ['Provider', gpuProviderLabel, false],
                gpu.gpuType && ['GPU', gpu.gpuType, true],
                gpu.podId && ['ID', gpu.podId, true],
                gpu.costPerHr != null && ['Cost', `$${gpu.costPerHr.toFixed(3)}/hr`, true],
                gpu.endpoint && ['URL', gpu.endpoint, true],
              ].filter(Boolean).map(([label, value, mono]: any) => (
                <div key={label} className="flex justify-between gap-2 text-xs">
                  <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
                  <span className={`${mono ? 'font-mono text-[10px]' : ''} truncate text-right max-w-[120px]`} title={value}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Error recovery */}
      {gpu?.status === 'error' && !deploying && (
        <div
          className="p-4 rounded-xl border"
          style={{ borderColor: 'color-mix(in srgb, #f59e0b 30%, transparent)', background: 'color-mix(in srgb, #f59e0b 5%, transparent)' }}
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">Deploy failed</p>
              <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
                {gpu?.message || 'Unknown error. Try redeploying.'}
              </p>
              <Button onClick={handleDeploy} disabled={selectedGpus.length === 0} size="sm">
                <Zap className="w-3.5 h-3.5" /> Retry Deploy
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Logs (collapsible) ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ScrollText className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              <h3 className="font-semibold text-sm">GPU Logs</h3>
              {logs && (
                <button onClick={() => setLogsOpen(v => !v)} className="text-xs cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
                  {logsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleLoadLogs} isLoading={loadingLogs} loadingText="Loading...">
              <RefreshCw className="w-3 h-3" /> Load Logs
            </Button>
          </div>
        </CardHeader>
        {(logsOpen && logs) && (
          <CardBody>
            <pre
              className="text-xs font-mono p-3 rounded-xl overflow-auto max-h-72 whitespace-pre-wrap"
              style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
            >
              {logs}
            </pre>
          </CardBody>
        )}
        {!logs && (
          <CardBody>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Click "Load Logs" to fetch GPU pod output.</p>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
