'use client';

import { useState } from 'react';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import { deployGpu, terminateGpu, getGpuLogs } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, Button, FormSelect, StatusBadge,
  AlertBanner, CardSectionHeader, SectionHeader,
} from '@/components/ui';
import { Cpu, Play, Square, ScrollText, RefreshCw, Zap, ServerCog, AlertCircle, Loader2, Check } from 'lucide-react';
import { DOCKER_IMAGES, GPU_TYPES } from './provider-types';

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function GpuDeploySection() {
  const { gpu, error: gpuError, refresh } = useGpuStatus(true, 5000);
  const [image, setImage] = useState<string>(DOCKER_IMAGES[0].value);
  const [selectedGpus, setSelectedGpus] = useState<string[]>([GPU_TYPES[0].id]);
  const [provider, setProvider] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isActive = gpu && gpu.status !== 'idle' && gpu.status !== 'error';

  async function handleDeploy() {
    setDeploying(true);
    setActionError(null);
    try {
      await deployGpu({
        dockerImage: image,
        gpuTypes: selectedGpus,
        provider: provider || undefined,
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

  const providerLabel = provider === 'vast' ? 'Vast.ai' : provider === 'runpod' ? 'RunPod' : provider === 'tensordock' ? 'TensorDock' : provider === 'modal' ? 'Modal' : 'Auto';

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="GPU Deploy"
        subtitle="Deploy a self-hosted GPU pod for the full STT + LLM + TTS pipeline"
      />

      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}
      {gpuError && <AlertBanner variant="warning">Cannot fetch GPU status: {gpuError}</AlertBanner>}

      {/* Deploy Config — 2 column layout (ported from Cabeção CloudDeployPanel) */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={ServerCog} color="blue" title="Deploy Configuration" subtitle="Docker image and GPU selection" />
        </CardHeader>
        <CardBody className="space-y-5">
          {/* Docker image + Provider */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <FormSelect label="Docker Image" value={image} onChange={e => setImage(e.target.value)}>
              {DOCKER_IMAGES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </FormSelect>
            <FormSelect label="Provider" value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="">Auto (best available)</option>
              <option value="tensordock">TensorDock</option>
              <option value="vast">Vast.ai</option>
              <option value="runpod">RunPod</option>
              <option value="modal">Modal</option>
            </FormSelect>
          </div>

          {/* GPU Selection — Cabeção-style pill buttons */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* Left: GPU pills */}
            <div
              className="rounded-xl border p-4 flex flex-col"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
            >
              <h5 className="text-sm font-semibold mb-3">Select GPUs</h5>
              <div className="flex flex-wrap gap-1.5">
                {GPU_TYPES.map(gpu => {
                  const selected = selectedGpus.includes(gpu.id);
                  return (
                    <button
                      key={gpu.id}
                      onClick={() => toggleGpu(gpu.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border cursor-pointer"
                      style={{
                        background: selected
                          ? 'color-mix(in srgb, #10b981 12%, transparent)'
                          : 'transparent',
                        borderColor: selected
                          ? 'color-mix(in srgb, #10b981 40%, transparent)'
                          : 'var(--color-border)',
                        color: selected ? '#10b981' : 'var(--color-text-muted)',
                      }}
                    >
                      {selected && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#10b981' }} />}
                      {gpu.label}
                      <span
                        className="text-[10px] font-normal"
                        style={{ color: selected ? 'color-mix(in srgb, #10b981 60%, transparent)' : 'var(--color-text-muted)' }}
                      >
                        {gpu.vram}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right: Deploy action */}
            <div
              className="rounded-xl border p-4 flex flex-col justify-between"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
            >
              <div>
                <h5 className="text-sm font-semibold mb-2">Deploy to {providerLabel}</h5>
                <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--color-text-muted)' }}>
                  Finds the best available GPU, deploys the Docker image, and returns a ready endpoint.
                  Pipeline automatically routes to GPU when healthy.
                </p>
              </div>
              <div className="flex gap-3">
                <Button onClick={handleDeploy} isLoading={deploying} loadingText="Deploying..." disabled={isActive || selectedGpus.length === 0}>
                  <Zap className="w-4 h-4" /> Deploy
                </Button>
                <Button variant="danger" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping..." disabled={!isActive}>
                  <Square className="w-4 h-4" /> Terminate
                </Button>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Deploy Status Bar — Cabeção DeployStatusClusterInfo pattern */}
      {gpu && gpu.status !== 'idle' && (() => {
        const isReady = gpu.status === 'ready';
        const isError = gpu.status === 'error';
        const isBooting = gpu.status === 'creating' || gpu.status === 'booting' || gpu.status === 'installing';
        const elapsedMin = Math.floor(gpu.elapsedSec / 60);
        const elapsedSecRem = gpu.elapsedSec % 60;
        const gpuProviderLabel = gpu.provider === 'vast' ? 'VAST.ai' : gpu.provider === 'runpod' ? 'RunPod' : gpu.provider === 'tensordock' ? 'TensorDock' : gpu.provider === 'modal' ? 'Modal' : gpu.provider || 'Unknown';

        return (
          <div className="flex gap-3 items-stretch">
            {/* Left: Deploy Status */}
            <div
              className="p-4 rounded-xl border flex-[8] min-w-0"
              style={{
                borderColor: isReady
                  ? 'color-mix(in srgb, #10b981 40%, transparent)' : isError
                  ? 'color-mix(in srgb, #ef4444 40%, transparent)' : 'var(--color-border)',
                background: isReady
                  ? 'color-mix(in srgb, #10b981 8%, var(--color-surface))' : isError
                  ? 'color-mix(in srgb, #ef4444 8%, var(--color-surface))' : 'var(--color-surface)',
              }}
            >
              <h5 className="text-sm font-semibold mb-2">Deploy Status</h5>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium flex items-center gap-2" style={{
                  color: isReady ? '#10b981' : isError ? '#ef4444' : 'var(--color-text)',
                }}>
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
                    deployed in {(gpu.deployDurationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>

              {/* Progress bar while booting */}
              {isBooting && (
                <div className="mb-3">
                  <div className="w-full rounded-full h-1.5" style={{ background: 'var(--color-border)' }}>
                    <div
                      className="h-1.5 rounded-full transition-all duration-1000 animate-pulse"
                      style={{
                        background: '#10b981',
                        width: `${Math.min(90, Math.max(10, gpu.elapsedSec * 0.5))}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Ready: show pipeline routing */}
              {isReady && gpu.pipelineRouting && (
                <div className="flex gap-4 text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                  <span>STT: <span style={{ color: gpu.pipelineRouting.stt === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.stt}</span></span>
                  <span>LLM: <span style={{ color: gpu.pipelineRouting.llm === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.llm}</span></span>
                  <span>TTS: <span style={{ color: gpu.pipelineRouting.tts === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.tts}</span></span>
                  <span>Mode: <span className="font-medium" style={{ color: 'var(--color-text)' }}>{gpu.pipelineRouting.mode}</span></span>
                </div>
              )}

              {/* Terminate button (only while booting, no instance card yet) */}
              {isBooting && (
                <div className="mt-3">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleTerminate}
                    isLoading={terminating}
                    loadingText="Stopping..."
                  >
                    <Square className="w-3.5 h-3.5" /> Cancel Deploy
                  </Button>
                </div>
              )}

              {gpu.alert && <AlertBanner variant="warning" className="mt-3">{gpu.alert}</AlertBanner>}
            </div>

            {/* Right: Instance Info */}
            <div
              className="p-4 rounded-xl border flex-[2] min-w-0"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
            >
              <div className="flex items-center justify-between mb-3">
                <h5 className="text-sm font-semibold">Instance</h5>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      isReady ? 'bg-emerald-500' :
                      isBooting ? 'bg-violet-500 animate-pulse' :
                      isError ? 'bg-red-500' :
                      'bg-gray-400 animate-pulse'
                    }`}
                  />
                  <span className={`text-[10px] font-medium ${
                    isReady ? 'text-emerald-400' :
                    isBooting ? 'text-violet-400' :
                    isError ? 'text-red-400' :
                    'text-gray-400'
                  }`}>
                    {isReady ? 'Online' :
                     isBooting ? 'Booting...' :
                     isError ? 'Failed' :
                     'Checking...'}
                  </span>
                </div>
              </div>
              <div className="space-y-2 text-xs">
                {gpu.provider && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Provider</span>
                    <span className="font-mono">{gpuProviderLabel}</span>
                  </div>
                )}
                {gpu.gpuType && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>GPU</span>
                    <span className="font-mono">{gpu.gpuType}</span>
                  </div>
                )}
                {gpu.podId && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>ID</span>
                    <span className="font-mono text-[10px] truncate max-w-[140px]" title={gpu.podId}>{gpu.podId}</span>
                  </div>
                )}
                {gpu.costPerHr != null && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Cost</span>
                    <span className="font-mono">${gpu.costPerHr.toFixed(3)}/hr</span>
                  </div>
                )}
                {gpu.endpoint && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Endpoint</span>
                    <span className="font-mono text-[10px] truncate max-w-[140px]" title={gpu.endpoint}>{gpu.endpoint}</span>
                  </div>
                )}
                {isReady && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Uptime</span>
                    <span className="font-mono">{formatUptime(gpu.elapsedSec)}</span>
                  </div>
                )}
              </div>

              {(isReady || isError) && (
                <div className="mt-3">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleTerminate}
                    isLoading={terminating}
                    loadingText="Stopping..."
                  >
                    <Square className="w-3.5 h-3.5" /> {isReady ? 'Stop' : 'Terminate'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Error recovery (ported from Cabeção CloudDeployPanel) */}
      {gpu?.status === 'error' && !deploying && (
        <div
          className="p-4 rounded-xl border"
          style={{ borderColor: 'color-mix(in srgb, #f59e0b 30%, transparent)', background: 'color-mix(in srgb, #f59e0b 5%, transparent)' }}
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">Deploy failed</p>
              <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--color-text-muted)' }}>
                {gpu?.message || 'Unknown error. Try redeploying.'}
              </p>
              <Button
                onClick={handleDeploy}
                disabled={selectedGpus.length === 0}
                size="sm"
              >
                <Zap className="w-3.5 h-3.5" /> Retry Deploy
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Logs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ScrollText className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
              <h3 className="font-semibold">GPU Logs</h3>
            </div>
            <Button variant="outline" size="sm" onClick={handleLoadLogs} isLoading={loadingLogs} loadingText="Loading...">
              Refresh Logs
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <pre
            className="text-xs font-mono p-4 rounded-xl overflow-auto max-h-80 whitespace-pre-wrap"
            style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
          >
            {logs ?? 'Click "Refresh Logs" to load GPU pod logs.'}
          </pre>
        </CardBody>
      </Card>
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className={`${mono ? 'font-mono text-xs' : ''} truncate text-right`}>{value}</span>
    </div>
  );
}
