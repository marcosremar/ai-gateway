'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  inspectDockerImage, getGpuTypes, type GpuTypeInfo, type DockerManifest,
} from '@/lib/gateway';
import {
  Button, FormInput, IconBox, DropdownList, Toggle,
} from '@/components/ui';
import {
  Check, Package, Server, Bot, Volume2, Mic, Loader2,
  Cpu, ScanSearch, AlertCircle, X as XIcon, Cloud, Zap,
  Timer, Gauge, HardDrive, Globe, ChevronDown, Activity, Pencil, Plus,
} from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES, GPU_TYPES, GPU_TYPES_BY_PROVIDER, PIPELINE_CATALOG, GPU_PROVIDERS,
  CLOUD_API_PROVIDERS, SERVERLESS_PROVIDERS,
  type PipelineChainEntry, type ProfileService, type ServiceKind,
} from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import { uid } from './constants';
import { GpuLiveStatus } from './GpuLiveStatus';

/* ── Country / Region data ── */

const REGION_PRESETS = [
  { code: '', label: 'Auto (any)', flag: '🌐' },
  { code: 'US', label: 'United States', flag: '🇺🇸' },
  { code: 'EU', label: 'Europe', flag: '🇪🇺' },
  { code: 'AP', label: 'Asia Pacific', flag: '🌏' },
  { code: 'SA', label: 'South America', flag: '🌎' },
];

const COUNTRIES = [
  { code: 'US', label: 'United States', flag: '🇺🇸', region: 'Americas' },
  { code: 'CA', label: 'Canada', flag: '🇨🇦', region: 'Americas' },
  { code: 'BR', label: 'Brazil', flag: '🇧🇷', region: 'Americas' },
  { code: 'MX', label: 'Mexico', flag: '🇲🇽', region: 'Americas' },
  { code: 'AR', label: 'Argentina', flag: '🇦🇷', region: 'Americas' },
  { code: 'CL', label: 'Chile', flag: '🇨🇱', region: 'Americas' },
  { code: 'CO', label: 'Colombia', flag: '🇨🇴', region: 'Americas' },
  { code: 'GB', label: 'United Kingdom', flag: '🇬🇧', region: 'Europe' },
  { code: 'DE', label: 'Germany', flag: '🇩🇪', region: 'Europe' },
  { code: 'FR', label: 'France', flag: '🇫🇷', region: 'Europe' },
  { code: 'NL', label: 'Netherlands', flag: '🇳🇱', region: 'Europe' },
  { code: 'SE', label: 'Sweden', flag: '🇸🇪', region: 'Europe' },
  { code: 'NO', label: 'Norway', flag: '🇳🇴', region: 'Europe' },
  { code: 'FI', label: 'Finland', flag: '🇫🇮', region: 'Europe' },
  { code: 'ES', label: 'Spain', flag: '🇪🇸', region: 'Europe' },
  { code: 'IT', label: 'Italy', flag: '🇮🇹', region: 'Europe' },
  { code: 'PT', label: 'Portugal', flag: '🇵🇹', region: 'Europe' },
  { code: 'PL', label: 'Poland', flag: '🇵🇱', region: 'Europe' },
  { code: 'CH', label: 'Switzerland', flag: '🇨🇭', region: 'Europe' },
  { code: 'AT', label: 'Austria', flag: '🇦🇹', region: 'Europe' },
  { code: 'BE', label: 'Belgium', flag: '🇧🇪', region: 'Europe' },
  { code: 'IE', label: 'Ireland', flag: '🇮🇪', region: 'Europe' },
  { code: 'DK', label: 'Denmark', flag: '🇩🇰', region: 'Europe' },
  { code: 'CZ', label: 'Czech Republic', flag: '🇨🇿', region: 'Europe' },
  { code: 'RO', label: 'Romania', flag: '🇷🇴', region: 'Europe' },
  { code: 'BG', label: 'Bulgaria', flag: '🇧🇬', region: 'Europe' },
  { code: 'HR', label: 'Croatia', flag: '🇭🇷', region: 'Europe' },
  { code: 'UA', label: 'Ukraine', flag: '🇺🇦', region: 'Europe' },
  { code: 'JP', label: 'Japan', flag: '🇯🇵', region: 'Asia Pacific' },
  { code: 'KR', label: 'South Korea', flag: '🇰🇷', region: 'Asia Pacific' },
  { code: 'SG', label: 'Singapore', flag: '🇸🇬', region: 'Asia Pacific' },
  { code: 'AU', label: 'Australia', flag: '🇦🇺', region: 'Asia Pacific' },
  { code: 'NZ', label: 'New Zealand', flag: '🇳🇿', region: 'Asia Pacific' },
  { code: 'IN', label: 'India', flag: '🇮🇳', region: 'Asia Pacific' },
  { code: 'TW', label: 'Taiwan', flag: '🇹🇼', region: 'Asia Pacific' },
  { code: 'HK', label: 'Hong Kong', flag: '🇭🇰', region: 'Asia Pacific' },
  { code: 'TH', label: 'Thailand', flag: '🇹🇭', region: 'Asia Pacific' },
  { code: 'MY', label: 'Malaysia', flag: '🇲🇾', region: 'Asia Pacific' },
  { code: 'ID', label: 'Indonesia', flag: '🇮🇩', region: 'Asia Pacific' },
  { code: 'PH', label: 'Philippines', flag: '🇵🇭', region: 'Asia Pacific' },
  { code: 'VN', label: 'Vietnam', flag: '🇻🇳', region: 'Asia Pacific' },
  { code: 'IL', label: 'Israel', flag: '🇮🇱', region: 'Middle East' },
  { code: 'AE', label: 'UAE', flag: '🇦🇪', region: 'Middle East' },
  { code: 'SA', label: 'Saudi Arabia', flag: '🇸🇦', region: 'Middle East' },
  { code: 'TR', label: 'Turkey', flag: '🇹🇷', region: 'Middle East' },
  { code: 'ZA', label: 'South Africa', flag: '🇿🇦', region: 'Africa' },
  { code: 'NG', label: 'Nigeria', flag: '🇳🇬', region: 'Africa' },
  { code: 'KE', label: 'Kenya', flag: '🇰🇪', region: 'Africa' },
  { code: 'EG', label: 'Egypt', flag: '🇪🇬', region: 'Africa' },
];

function RegionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = REGION_PRESETS.some(r => r.code === value);
  const isCountry = !isPreset && COUNTRIES.some(c => c.code === value);
  const currentCountry = COUNTRIES.find(c => c.code === value);
  const currentPreset = REGION_PRESETS.find(r => r.code === value);
  const displayLabel = currentCountry ? `${currentCountry.flag} ${currentCountry.label}` : currentPreset ? `${currentPreset.flag} ${currentPreset.label}` : value || 'Auto';

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Globe className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Region / Country</span>
      </div>
      {/* Quick presets */}
      <div className="flex gap-1 flex-wrap mb-2">
        {REGION_PRESETS.map(r => (
          <button key={r.code} type="button" onClick={() => onChange(r.code)}
            className="px-2 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
            style={{
              background: value === r.code ? 'color-mix(in srgb, #38bdf8 12%, transparent)' : 'transparent',
              borderColor: value === r.code ? '#38bdf8' : 'var(--color-border)',
              color: value === r.code ? '#38bdf8' : 'var(--color-text-muted)',
            }}>
            {r.flag} {r.label}
          </button>
        ))}
      </div>
      {/* Country dropdown */}
      <DropdownList
        options={COUNTRIES.map(c => ({
          key: c.code,
          label: `${c.flag} ${c.label}`,
          subtitle: c.region,
          group: c.region,
        }))}
        value={isCountry ? value : ''}
        onChange={onChange}
        accent="#38bdf8"
        size="sm"
        searchable
        placeholder={isCountry ? displayLabel : 'Select specific country...'}
      />
    </div>
  );
}

/* ── Pill selector with custom input ── */

function PillGroup({ label, icon: Icon, color = '#a78bfa', presets, value, onChange, unit, customMin, customMax }: {
  label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color?: string; presets: { v: number | string; l: string }[];
  value: number | string; onChange: (v: number | string) => void;
  unit?: string; customMin?: number; customMax?: number;
}) {
  const isCustom = !presets.some(p => p.v === value);
  const [showCustom, setShowCustom] = useState(isCustom);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      </div>
      <div className="flex gap-1 flex-wrap items-center">
        {presets.map(o => (
          <button key={String(o.v)} type="button"
            onClick={() => { onChange(o.v); setShowCustom(false); }}
            className="px-2 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
            style={{
              background: value === o.v && !showCustom ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
              borderColor: value === o.v && !showCustom ? color : 'var(--color-border)',
              color: value === o.v && !showCustom ? color : 'var(--color-text-muted)',
            }}>
            {o.l}
          </button>
        ))}
        {customMin != null && (
          showCustom ? (
            <div className="flex items-center gap-1">
              <input type="number" min={customMin} max={customMax}
                value={typeof value === 'number' ? value : ''}
                onChange={e => onChange(Number(e.target.value) || customMin)}
                className="w-16 text-[11px] px-2 py-1 rounded-md border outline-none"
                style={{ background: 'var(--color-surface-elevated)', borderColor: color, color: 'var(--color-text)' }}
                autoFocus
              />
              {unit && <span className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>{unit}</span>}
            </div>
          ) : (
            <button type="button" onClick={() => setShowCustom(true)}
              className="px-2 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
              style={{ borderColor: 'var(--color-border)', borderStyle: 'dashed', color: 'var(--color-text-muted)' }}>
              <Pencil className="w-2.5 h-2.5 inline mr-1" />Custom
            </button>
          )
        )}
      </div>
    </div>
  );
}

/* ── Deploy Settings sub-component ── */

interface DeploySettingsProps {
  raceCount: number; setRaceCount: (v: number) => void;
  idleTimeoutMin: number; setIdleTimeoutMin: (v: number) => void;
  spotInstance: boolean; setSpotInstance: (v: boolean) => void;
  autoBenchmark: boolean; setAutoBenchmark: (v: boolean) => void;
  region: string; setRegion: (v: string) => void;
  minVramGb: number; setMinVramGb: (v: number) => void;
  diskGb: number; setDiskGb: (v: number) => void;
  sttTargetMs: number; setSttTargetMs: (v: number) => void;
  llmTargetMs: number; setLlmTargetMs: (v: number) => void;
  ttsTargetMs: number; setTtsTargetMs: (v: number) => void;
  p95Multiplier: number; setP95Multiplier: (v: number) => void;
  repechageAttempts: number; setRepechageAttempts: (v: number) => void;
  shadowRuns: number; setShadowRuns: (v: number) => void;
  benchmarkMaxRuns: number; setBenchmarkMaxRuns: (v: number) => void;
  autoRecoveryEnabled: boolean; setAutoRecoveryEnabled: (v: boolean) => void;
  autoRecoveryMaxRetries: number; setAutoRecoveryMaxRetries: (v: number) => void;
}

/* Service lifecycle phases */
// DEPLOY STATES (infrastructure — applies to the whole pod)
const DEPLOY_PHASES = [
  { phase: 'Offline', color: '#6b7280', desc: 'No GPU deployed. All traffic routes to cloud providers.', time: '—' },
  { phase: 'Searching', color: '#a78bfa', desc: 'Querying providers for available GPUs. Filters: ≥500 Mbps, VRAM, price, reputation.', time: '0-2s' },
  { phase: 'No Offers', color: '#f59e0b', desc: 'No GPUs match on this provider. Tries next provider. Blacklisted hosts excluded.', time: '0-5s' },
  { phase: 'Queued', color: '#a78bfa', desc: 'GPU allocated, waiting in provider queue. Hardware provisioning.', time: '10-120s' },
  { phase: 'Creating', color: '#38bdf8', desc: 'Instance being created. Setting up networking, SSH, storage.', time: '30-90s' },
  { phase: 'Pulling Image', color: '#38bdf8', desc: 'Docker image downloading. Faster on hosts with cached layers.', time: '3-120s' },
  { phase: 'Booting', color: '#38bdf8', desc: 'Container started. Server process initializing.', time: '5-30s' },
  { phase: 'Draining', color: '#a78bfa', desc: 'Standby ready. Active requests finishing before handover.', time: '0-30s' },
];

// SERVICE STATES (per STT/LLM/TTS — each service has its own lifecycle)
const SERVICE_PHASES = [
  { phase: 'Downloading', color: '#a78bfa', desc: 'Model downloading from HuggingFace. Cloud serves this stage.', time: '30-180s' },
  { phase: 'Loading', color: '#a78bfa', desc: 'Model loading into GPU memory/VRAM.', time: '10-60s' },
  { phase: 'Compiling', color: '#fbbf24', desc: 'CUDA graph compilation for fast inference (TTS only).', time: '10-30s' },
  { phase: 'Warming', color: '#fbbf24', desc: 'First inference warming up. Establishing baseline latency.', time: '5-15s' },
  { phase: 'Benchmarking', color: '#38bdf8', desc: 'Testing latency against target. Progressive relaxation ±15%.', time: '30-120s' },
  { phase: 'Shadow', color: '#a78bfa', desc: 'Validation alongside cloud. N consecutive successes needed.', time: '10-60s' },
  { phase: 'Ready', color: '#10b981', desc: 'Serving production traffic. P95 monitored continuously.', time: '∞' },
  { phase: 'Degraded', color: '#f59e0b', desc: 'P95 exceeded (3 violations). Falls back to cloud.', time: '30-90s' },
  { phase: 'Failed', color: '#ef4444', desc: 'Benchmark failed — did not meet target latency.', time: '—' },
  { phase: 'Repechage', color: '#f97316', desc: 'Retrying benchmark. Max N attempts, 2 min between.', time: '2-6 min' },
  { phase: 'Condemned', color: '#ef4444', desc: 'All retries failed. Auto-recovery deploys replacement.', time: '—' },
];

// Combined for backward compat
const LIFECYCLE_PHASES = [...DEPLOY_PHASES, ...SERVICE_PHASES];

function DeploySettings(props: DeploySettingsProps) {
  const { raceCount, setRaceCount, idleTimeoutMin, setIdleTimeoutMin,
    spotInstance, setSpotInstance, autoBenchmark, setAutoBenchmark,
    region, setRegion, minVramGb, setMinVramGb, diskGb, setDiskGb,
    sttTargetMs, setSttTargetMs, llmTargetMs, setLlmTargetMs, ttsTargetMs, setTtsTargetMs,
    p95Multiplier, setP95Multiplier, repechageAttempts, setRepechageAttempts,
    shadowRuns, setShadowRuns, benchmarkMaxRuns, setBenchmarkMaxRuns,
    autoRecoveryEnabled, setAutoRecoveryEnabled, autoRecoveryMaxRetries, setAutoRecoveryMaxRetries,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const hasCustom = raceCount > 1 || idleTimeoutMin !== 15 || spotInstance || !!region || minVramGb > 0 || diskGb !== 20 || autoBenchmark
    || sttTargetMs !== 800 || llmTargetMs !== 2000 || ttsTargetMs !== 1500
    || p95Multiplier !== 2.0 || repechageAttempts !== 3 || shadowRuns !== 5 || benchmarkMaxRuns !== 20;

  return (
    <div>
      <button type="button" onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1.5 w-full text-left cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}>
        <ChevronDown className="w-3 h-3 transition-transform" style={{ transform: expanded ? 'rotate(0)' : 'rotate(-90deg)' }} />
        <span className="text-[10px] font-semibold uppercase tracking-wide">Deploy Settings</span>
        {hasCustom && !expanded && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#a78bfa' }}>
            customized
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2.5 space-y-3.5 pl-1">

          {/* ── Max Latency Targets ── */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <Gauge className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Max Latency (per service)</span>
            </div>
            <p className="text-[9px] mb-2" style={{ color: 'var(--color-text-muted)' }}>
              Each service must respond within this time to pass benchmark. In production, P95 &gt; target &times; {p95Multiplier} triggers demotion &amp; fallback to next provider.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { label: 'STT', color: '#38bdf8', value: sttTargetMs, set: setSttTargetMs, def: 800 },
                { label: 'LLM', color: '#a78bfa', value: llmTargetMs, set: setLlmTargetMs, def: 2000 },
                { label: 'TTS', color: '#fbbf24', value: ttsTargetMs, set: setTtsTargetMs, def: 1500 },
              ]).map(t => (
                <div key={t.label} className="rounded-lg border p-2"
                  style={{ borderColor: `color-mix(in srgb, ${t.color} 25%, var(--color-border))`, background: `color-mix(in srgb, ${t.color} 3%, transparent)` }}>
                  <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: t.color }}>{t.label}</span>
                  <div className="flex items-center gap-1 mt-1">
                    <input type="number" min={50} max={30000} step={50}
                      value={t.value}
                      onChange={e => t.set(Math.max(50, Math.min(30000, Number(e.target.value) || t.def)))}
                      className="w-full text-[11px] font-mono px-1.5 py-0.5 rounded border outline-none text-center"
                      style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                    />
                    <span className="text-[9px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>ms</span>
                  </div>
                  <div className="text-[8px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                    demote at &gt;{Math.round(t.value * p95Multiplier)}ms
                  </div>
                  {t.value !== t.def && (
                    <button type="button" onClick={() => t.set(t.def)}
                      className="text-[8px] cursor-pointer" style={{ color: t.color }}>
                      reset to {t.def}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ── Readiness Behavior ── */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Activity className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Readiness Behavior</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
                <span className="text-[9px] font-semibold" style={{ color: 'var(--color-text-muted)' }}>P95 Multiplier</span>
                <p className="text-[8px] mb-1" style={{ color: 'var(--color-text-muted)' }}>Demote if P95 &gt; target &times; N</p>
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={10} step={0.1} value={p95Multiplier}
                    onChange={e => setP95Multiplier(Math.max(1, Math.min(10, Number(e.target.value) || 2)))}
                    className="w-full text-[11px] font-mono px-1.5 py-0.5 rounded border outline-none text-center"
                    style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  />
                  <span className="text-[9px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>&times;</span>
                </div>
              </div>
              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
                <span className="text-[9px] font-semibold" style={{ color: 'var(--color-text-muted)' }}>Repechage Retries</span>
                <p className="text-[8px] mb-1" style={{ color: 'var(--color-text-muted)' }}>Retry before condemning</p>
                <div className="flex items-center gap-1">
                  <input type="number" min={0} max={20} value={repechageAttempts}
                    onChange={e => setRepechageAttempts(Math.max(0, Math.min(20, Number(e.target.value) || 3)))}
                    className="w-full text-[11px] font-mono px-1.5 py-0.5 rounded border outline-none text-center"
                    style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  />
                </div>
              </div>
              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
                <span className="text-[9px] font-semibold" style={{ color: 'var(--color-text-muted)' }}>Shadow Runs</span>
                <p className="text-[8px] mb-1" style={{ color: 'var(--color-text-muted)' }}>Consecutive OK before going live</p>
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={100} value={shadowRuns}
                    onChange={e => setShadowRuns(Math.max(1, Math.min(100, Number(e.target.value) || 5)))}
                    className="w-full text-[11px] font-mono px-1.5 py-0.5 rounded border outline-none text-center"
                    style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  />
                </div>
              </div>
              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
                <span className="text-[9px] font-semibold" style={{ color: 'var(--color-text-muted)' }}>Benchmark Runs</span>
                <p className="text-[8px] mb-1" style={{ color: 'var(--color-text-muted)' }}>Max attempts per service</p>
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={100} value={benchmarkMaxRuns}
                    onChange={e => setBenchmarkMaxRuns(Math.max(1, Math.min(100, Number(e.target.value) || 20)))}
                    className="w-full text-[11px] font-mono px-1.5 py-0.5 rounded border outline-none text-center"
                    style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ── Race Count ── */}
          <PillGroup label="Parallel Race" icon={Gauge} color="#a78bfa"
            presets={[{ v: 1, l: '1' }, { v: 2, l: '×2' }, { v: 3, l: '×3' }, { v: 5, l: '×5' }]}
            value={raceCount} onChange={v => setRaceCount(Number(v))}
            customMin={1} customMax={20} unit="instances"
          />

          {/* ── Auto-Stop ── */}
          <PillGroup label="Auto-Stop (idle)" icon={Timer} color="#f59e0b"
            presets={[{ v: 5, l: '5m' }, { v: 15, l: '15m' }, { v: 30, l: '30m' }, { v: 60, l: '1h' }, { v: 0, l: 'Never' }]}
            value={idleTimeoutMin} onChange={v => setIdleTimeoutMin(Number(v))}
            customMin={1} customMax={1440} unit="min"
          />

          {/* ── Region ── */}
          <RegionPicker value={region} onChange={setRegion} />

          {/* ── Min VRAM ── */}
          <PillGroup label="Min VRAM" icon={Cpu} color="#10b981"
            presets={[{ v: 0, l: 'Any' }, { v: 8, l: '8 GB' }, { v: 16, l: '16 GB' }, { v: 24, l: '24 GB' }, { v: 40, l: '40 GB' }, { v: 80, l: '80 GB' }]}
            value={minVramGb} onChange={v => setMinVramGb(Number(v))}
            customMin={1} customMax={640} unit="GB"
          />

          {/* ── Disk ── */}
          <PillGroup label="Disk Size" icon={HardDrive} color="#06b6d4"
            presets={[{ v: 10, l: '10 GB' }, { v: 20, l: '20 GB' }, { v: 50, l: '50 GB' }, { v: 100, l: '100 GB' }, { v: 200, l: '200 GB' }]}
            value={diskGb} onChange={v => setDiskGb(Number(v))}
            customMin={5} customMax={2000} unit="GB"
          />

          {/* ── Toggles ── */}
          <div className="space-y-2.5 pt-1">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] font-medium" style={{ color: 'var(--color-text)' }}>Spot / Interruptible</span>
                <p className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Cheaper but may be preempted</p>
              </div>
              <Toggle checked={spotInstance} onChange={setSpotInstance} size="sm" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] font-medium" style={{ color: 'var(--color-text)' }}>Auto-benchmark on ready</span>
                <p className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Run readiness checks after GPU boots</p>
              </div>
              <Toggle checked={autoBenchmark} onChange={setAutoBenchmark} size="sm" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] font-medium" style={{ color: 'var(--color-text)' }}>Auto-recovery on condemned</span>
                <p className="text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                  Deploy replacement machine automatically (max {autoRecoveryMaxRetries} retries)
                </p>
              </div>
              <Toggle checked={autoRecoveryEnabled} onChange={setAutoRecoveryEnabled} size="sm" />
            </div>
            {autoRecoveryEnabled && (
              <div className="flex items-center gap-2 pl-1">
                <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Max recovery attempts:</span>
                <input type="number" min={1} max={10} value={autoRecoveryMaxRetries}
                  onChange={e => setAutoRecoveryMaxRetries(Math.max(1, Math.min(10, Number(e.target.value) || 2)))}
                  className="w-14 text-[11px] font-mono px-1.5 py-0.5 rounded border outline-none text-center"
                  style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── ServiceForm ── */

interface ServiceFormProps {
  initial?: ProfileService;
  onSave: (s: ProfileService) => void;
  onCancel: () => void;
}

function ServiceForm({ initial, onSave, onCancel }: ServiceFormProps) {
  // Derive initial kind — migrate modal-cloud → serverless
  const deriveKind = (s?: ProfileService): ServiceKind => {
    if (!s) return 'gpu-pod';
    if (s.kind === 'cloud' && s.cloudProvider === 'modal') return 'serverless';
    return s.kind;
  };

  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState<ServiceKind>(deriveKind(initial));
  const [cloudProvider, setCloudProvider] = useState(initial?.cloudProvider || 'groq');
  const [serverlessProvider, setServerlessProvider] = useState(
    (initial?.kind === 'cloud' && initial?.cloudProvider === 'modal') ? 'modal'
    : initial?.kind === 'serverless' ? (initial?.cloudProvider || 'modal')
    : 'modal'
  );

  // Docker image: either a known preset or custom URL
  const initDockerUrl = initial?.dockerImage || DEFAULT_DOCKER_IMAGES[0].url;
  const isKnownUrl = (url: string) => DEFAULT_DOCKER_IMAGES.some(img => img.url === url);
  const [dockerImage, setDockerImage] = useState(initDockerUrl);
  const [customDockerUrl, setCustomDockerUrl] = useState(isKnownUrl(initDockerUrl) ? '' : initDockerUrl);
  const [useCustom, setUseCustom] = useState(!isKnownUrl(initDockerUrl));

  const [gpuTypes, setGpuTypes] = useState<string[]>(initial?.gpuTypes || []);
  const [gpuCloudProvider, setGpuCloudProvider] = useState(initial?.gpuCloudProvider || GPU_PROVIDERS[0].id);

  // Deploy settings
  const [raceCount, setRaceCount] = useState(initial?.raceCount ?? 1);
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(initial?.idleTimeoutMin ?? 15);
  const [spotInstance, setSpotInstance] = useState(initial?.spotInstance ?? false);
  const [autoBenchmark, setAutoBenchmark] = useState(initial?.autoBenchmark ?? false);
  const [region, setRegion] = useState(initial?.region ?? '');
  const [minVramGb, setMinVramGb] = useState(initial?.minVramGb ?? 0);
  const [diskGb, setDiskGb] = useState(initial?.diskGb ?? 20);
  const [sttTargetMs, setSttTargetMs] = useState(initial?.sttTargetMs ?? 800);
  const [llmTargetMs, setLlmTargetMs] = useState(initial?.llmTargetMs ?? 2000);
  const [ttsTargetMs, setTtsTargetMs] = useState(initial?.ttsTargetMs ?? 1500);
  const [p95Multiplier, setP95Multiplier] = useState(initial?.p95DemotionMultiplier ?? 2.0);
  const [repechageAttempts, setRepechageAttempts] = useState(initial?.repechageMaxAttempts ?? 3);
  const [shadowRunsVal, setShadowRunsVal] = useState(initial?.shadowRuns ?? 5);
  const [benchmarkMaxRunsVal, setBenchmarkMaxRunsVal] = useState(initial?.benchmarkMaxRuns ?? 20);
  const [autoRecoveryEnabled, setAutoRecoveryEnabled] = useState(initial?.autoRecoveryEnabled ?? true);
  const [autoRecoveryMaxRetries, setAutoRecoveryMaxRetries] = useState(initial?.autoRecoveryMaxRetries ?? 2);
  const [deployTimeoutMin, setDeployTimeoutMin] = useState(initial?.deployTimeoutMin ?? 30);

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

  // Live GPU catalog from provider (only for self-hosted)
  const [liveGpus, setLiveGpus] = useState<GpuTypeInfo[]>([]);
  const [gpuLoading, setGpuLoading] = useState(false);

  useEffect(() => {
    if (kind !== 'gpu-pod') return;
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
  }, [gpuCloudProvider, kind]);

  const toggleGpu = (id: string) =>
    setGpuTypes(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);


  const handleSave = () => {
    if (!name.trim()) return;
    const base = { id: initial?.id || uid(), name: name.trim(), kind };
    const modelFields = {
      ...(sttModel ? { sttModel } : {}),
      ...(llmModel ? { llmModel } : {}),
      ...(ttsModel ? { ttsModel } : {}),
    };
    let s: ProfileService;
    if (kind === 'cloud') {
      s = { ...base, cloudProvider };
    } else if (kind === 'serverless') {
      s = { ...base, cloudProvider: serverlessProvider, dockerImage, ...modelFields };
    } else {
      s = {
        ...base, dockerImage, gpuTypes, gpuCloudProvider, ...modelFields,
        raceCount, idleTimeoutMin, spotInstance, autoBenchmark, region, minVramGb, diskGb,
        sttTargetMs, llmTargetMs, ttsTargetMs,
        p95DemotionMultiplier: p95Multiplier, repechageMaxAttempts: repechageAttempts,
        shadowRuns: shadowRunsVal, benchmarkMaxRuns: benchmarkMaxRunsVal,
        autoRecoveryEnabled, autoRecoveryMaxRetries, deployTimeoutMin,
      };
    }
    onSave(s);
  };

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: 'var(--color-surface)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, #a78bfa 4%, transparent)' }}>
        <div className="flex items-center gap-2">
          <IconBox icon={Server} color="#a78bfa" size="sm" />
          <span className="text-sm font-semibold">{initial ? 'Edit Service' : 'New Service'}</span>
        </div>
        <div className="flex gap-1.5">
          {([
            { k: 'gpu-pod' as ServiceKind, label: 'Self-hosted', TabIcon: Server },
            { k: 'serverless' as ServiceKind, label: 'Serverless', TabIcon: Cloud },
            { k: 'cloud' as ServiceKind, label: 'Cloud API', TabIcon: Zap },
          ]).map(tab => {
            const sel = kind === tab.k;
            return (
              <button key={tab.k} type="button" onClick={() => setKind(tab.k)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
                style={{
                  background: sel ? 'color-mix(in srgb, #a78bfa 12%, transparent)' : 'transparent',
                  borderColor: sel ? '#a78bfa' : 'var(--color-border)',
                  color: sel ? '#c4b5fd' : 'var(--color-text-muted)',
                }}>
                <tab.TabIcon className="w-3 h-3" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Live Status + Lifecycle (always visible at top for gpu-pod/serverless) ── */}
      {kind !== 'cloud' && (
        <div className="px-5 pt-5 pb-4 space-y-4 border-b" style={{ borderColor: 'var(--color-border)' }}>

          {/* Live GPU Status */}
          <GpuLiveStatus />

          {/* Lifecycle phases — two rows of 4 for readability */}
          {/* Deploy States (infrastructure) */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>
              Deploy Lifecycle <span className="normal-case font-normal">(infrastructure — whole pod)</span>
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {DEPLOY_PHASES.map(p => (
                <div key={p.phase} className="rounded-lg p-2"
                  style={{ background: `color-mix(in srgb, ${p.color} 8%, var(--color-surface))`, border: `1px solid color-mix(in srgb, ${p.color} 15%, var(--color-border))` }}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
                    <span className="text-[10px] font-bold" style={{ color: p.color }}>{p.phase}</span>
                    {p.time && p.time !== '—' && (
                      <span className="text-[7px] font-mono ml-auto" style={{ color: 'var(--color-text-muted)' }}>~{p.time}</span>
                    )}
                  </div>
                  <p className="text-[9px] leading-snug" style={{ color: 'var(--color-text-muted)' }}>{p.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Service States (per STT/LLM/TTS) */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>
              Service Lifecycle <span className="normal-case font-normal">(per STT / LLM / TTS — independent)</span>
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {SERVICE_PHASES.map(p => (
                <div key={p.phase} className="rounded-lg p-2"
                  style={{ background: `color-mix(in srgb, ${p.color} 8%, var(--color-surface))`, border: `1px solid color-mix(in srgb, ${p.color} 15%, var(--color-border))` }}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
                    <span className="text-[10px] font-bold" style={{ color: p.color }}>{p.phase}</span>
                    {p.time && p.time !== '—' && (
                      <span className="text-[7px] font-mono ml-auto" style={{ color: 'var(--color-text-muted)' }}>~{p.time}</span>
                    )}
                  </div>
                  <p className="text-[9px] leading-snug" style={{ color: 'var(--color-text-muted)' }}>{p.desc}</p>
                </div>
              ))}
            </div>
            <p className="text-[9px] mt-2 px-3 py-1.5 rounded-lg"
              style={{ background: 'color-mix(in srgb, #38bdf8 5%, transparent)', color: 'var(--color-text-muted)' }}>
              Each service (STT/LLM/TTS) progresses through these states <strong>independently</strong>. A service routes to cloud until it reaches Ready. Uses <strong style={{ color: '#38bdf8' }}>P95</strong> for demotion.
            </p>
          </div>
        </div>
      )}

      <div className="p-4 space-y-3">

        {/* ── Name ── */}
        <FormInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="Service name" />

        {kind === 'cloud' ? (
          /* ── Cloud API provider buttons ── */
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Cloud Provider</p>
            <div className="flex flex-wrap gap-1.5">
              {CLOUD_API_PROVIDERS.map(p => {
                const provIcon = PROVIDER_ICON[p.id];
                const ProvIcon = provIcon?.icon ?? Package;
                const provColor = provIcon?.color ?? p.color;
                const sel = cloudProvider === p.id;
                return (
                  <button key={p.id} type="button" onClick={() => setCloudProvider(p.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
                    style={{
                      background: sel ? `color-mix(in srgb, ${provColor} 12%, transparent)` : 'var(--color-surface-elevated)',
                      borderColor: sel ? provColor : 'var(--color-border)',
                      color: sel ? provColor : 'var(--color-text-muted)',
                    }}>
                    <ProvIcon className="w-3.5 h-3.5" />
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* ── Serverless provider buttons ── */}
            {kind === 'serverless' && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Provider</p>
                <div className="flex flex-wrap gap-1.5">
                  {SERVERLESS_PROVIDERS.map(p => {
                    const provIcon = PROVIDER_ICON[p.id];
                    const PIcon = provIcon?.icon ?? Cloud;
                    const pColor = provIcon?.color ?? p.color;
                    const sel = serverlessProvider === p.id;
                    return (
                      <button key={p.id} type="button" onClick={() => setServerlessProvider(p.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
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
            )}

            {/* ── Docker Image (shared: self-hosted + serverless) ── */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Docker Image</p>
              {!useCustom ? (
                <div className="space-y-2">
                  <DropdownList
                    options={DEFAULT_DOCKER_IMAGES.map(img => ({
                      key: img.url,
                      label: img.label,
                      subtitle: img.description,
                      icon: Package,
                      iconColor: '#a78bfa',
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
                    onClick={() => { setUseCustom(true); setCustomDockerUrl(''); }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer"
                    style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)', borderStyle: 'dashed' }}
                  >
                    <Plus className="w-3 h-3" /> Add custom Docker image
                  </button>
                </div>
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
                  {inspectResult && (
                    <div className="p-2 rounded-lg border text-[11px] space-y-0.5"
                      style={{ borderColor: 'color-mix(in srgb, #10b981 30%, var(--color-border))', background: 'color-mix(in srgb, #10b981 4%, var(--color-surface-elevated))' }}>
                      <div className="font-semibold" style={{ color: '#34d399' }}>
                        Services: {inspectResult.services.length > 0 ? inspectResult.services.join(', ') : '\u2014'}
                        {inspectResult.protocol !== 'rest' && <span className="ml-2" style={{ color: 'var(--color-text-muted)' }}>({inspectResult.protocol})</span>}
                      </div>
                      {[inspectResult.sttModel, inspectResult.llmModel, inspectResult.ttsModel].some(Boolean) && (
                        <div style={{ color: 'var(--color-text-muted)' }}>Models auto-filled</div>
                      )}
                    </div>
                  )}
                  {inspectError && (
                    <div className="p-2 rounded-lg border text-[11px] flex items-center gap-1.5"
                      style={{ borderColor: 'color-mix(in srgb, #f87171 30%, var(--color-border))', color: '#f87171', background: 'color-mix(in srgb, #f87171 4%, var(--color-surface-elevated))' }}>
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      {inspectResult === null && 'No babelcast labels found \u2014 '}
                      {inspectError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Services (read-only, auto-detected from Docker image) ── */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Services</p>
              <div className="flex flex-wrap gap-1.5">
                {([
                  { stage: 'stt' as const, model: sttModel, StageIcon: Mic, color: '#38bdf8' },
                  { stage: 'llm' as const, model: llmModel, StageIcon: Bot, color: '#a78bfa' },
                  { stage: 'tts' as const, model: ttsModel, StageIcon: Volume2, color: '#fbbf24' },
                ]).filter(s => s.model).map(s => {
                  const models = (PIPELINE_CATALOG[s.stage].models as Record<string, { id: string; label: string }[]>).gpu ?? [];
                  const modelLabel = models.find(m => m.id === s.model)?.label ?? s.model;
                  return (
                    <div key={s.stage}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px]"
                      style={{
                        borderColor: `color-mix(in srgb, ${s.color} 30%, var(--color-border))`,
                        background: `color-mix(in srgb, ${s.color} 6%, transparent)`,
                      }}>
                      <s.StageIcon className="w-3 h-3" style={{ color: s.color }} />
                      <span className="font-semibold uppercase" style={{ color: s.color }}>{s.stage}</span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>{modelLabel}</span>
                    </div>
                  );
                })}
                {!sttModel && !llmModel && !ttsModel && (
                  <span className="text-[11px] italic" style={{ color: 'var(--color-text-muted)' }}>No services detected</span>
                )}
              </div>
            </div>

            {/* ── Infrastructure (self-hosted only) ── */}
            {kind === 'gpu-pod' && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Infrastructure</p>

                {/* GPU Cloud Provider */}
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {GPU_PROVIDERS.map(p => {
                    const provIcon = PROVIDER_ICON[p.id];
                    const PIcon = provIcon?.icon ?? Cpu;
                    const pColor = provIcon?.color ?? p.color;
                    const sel = gpuCloudProvider === p.id;
                    return (
                      <button key={p.id} type="button"
                        onClick={() => { setGpuCloudProvider(p.id); setGpuTypes([]); }}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
                        style={{
                          background: sel ? `color-mix(in srgb, ${pColor} 12%, transparent)` : 'transparent',
                          borderColor: sel ? pColor : 'var(--color-border)',
                          color: sel ? pColor : 'var(--color-text-muted)',
                        }}>
                        <PIcon className="w-3 h-3" />
                        {p.name}
                      </button>
                    );
                  })}
                </div>

                {/* GPU type selection */}
                <div>
                  {gpuTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {gpuTypes.map((id, idx) => {
                        const info = liveGpus.find(g => g.name === id);
                        const label = info?.shortName ?? id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, '');
                        const latMs = info?.bestLatencyMs;
                        const latColor = latMs == null ? 'var(--color-text-muted)' : latMs < 100 ? '#34d399' : latMs < 250 ? '#fbbf24' : '#f87171';
                        return (
                          <span key={id}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
                            style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#c4b5fd', border: '1px solid color-mix(in srgb, #a78bfa 30%, transparent)' }}>
                            <span className="text-[9px] font-bold opacity-60">#{idx + 1}</span>
                            {label}
                            {latMs != null && (
                              <span className="text-[9px] font-mono" style={{ color: latColor }}>{Math.round(latMs)}ms</span>
                            )}
                            <button type="button" onClick={() => toggleGpu(id)} className="ml-0.5 hover:opacity-70 cursor-pointer">&times;</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <DropdownList
                    options={liveGpus
                      .filter(g => !gpuTypes.includes(g.name))
                      .map(g => {
                        const vramGb = g.vramGb ?? (g.vram > 0 ? g.vram : null);
                        const latMs = g.bestLatencyMs;
                        const latLabel = latMs != null ? `${Math.round(latMs)}ms` : null;
                        return {
                          key: g.name,
                          label: g.shortName,
                          subtitle: [vramGb ? `${vramGb}GB` : null, g.minPricePerHr != null ? `$${g.minPricePerHr.toFixed(2)}/hr` : null, latLabel].filter(Boolean).join(' \u00b7 ') || undefined,
                        };
                      })}
                    value=""
                    onChange={key => toggleGpu(key)}
                    accent="#a78bfa"
                    size="sm"
                    searchable
                    placeholder={gpuLoading ? 'Loading GPUs...' : gpuTypes.length > 0 ? 'Add GPU...' : 'Select GPU type...'}
                  />
                </div>
              </div>
            )}

            {/* ── Deploy Timeout ── */}
            {kind === 'gpu-pod' && (
              <PillGroup label="Deploy Timeout (max)" icon={Timer} color="#ef4444"
                presets={[{ v: 10, l: '10m' }, { v: 20, l: '20m' }, { v: 30, l: '30m' }, { v: 45, l: '45m' }, { v: 60, l: '1h' }]}
                value={deployTimeoutMin} onChange={v => setDeployTimeoutMin(Number(v))}
                customMin={3} customMax={120} unit="min"
              />
            )}

            {/* ── Deploy Settings (gpu-pod only) ── */}
            {kind === 'gpu-pod' && (
              <DeploySettings
                raceCount={raceCount} setRaceCount={setRaceCount}
                idleTimeoutMin={idleTimeoutMin} setIdleTimeoutMin={setIdleTimeoutMin}
                spotInstance={spotInstance} setSpotInstance={setSpotInstance}
                autoBenchmark={autoBenchmark} setAutoBenchmark={setAutoBenchmark}
                region={region} setRegion={setRegion}
                minVramGb={minVramGb} setMinVramGb={setMinVramGb}
                diskGb={diskGb} setDiskGb={setDiskGb}
                sttTargetMs={sttTargetMs} setSttTargetMs={setSttTargetMs}
                llmTargetMs={llmTargetMs} setLlmTargetMs={setLlmTargetMs}
                ttsTargetMs={ttsTargetMs} setTtsTargetMs={setTtsTargetMs}
                p95Multiplier={p95Multiplier} setP95Multiplier={setP95Multiplier}
                repechageAttempts={repechageAttempts} setRepechageAttempts={setRepechageAttempts}
                shadowRuns={shadowRunsVal} setShadowRuns={setShadowRunsVal}
                benchmarkMaxRuns={benchmarkMaxRunsVal} setBenchmarkMaxRuns={setBenchmarkMaxRunsVal}
                autoRecoveryEnabled={autoRecoveryEnabled} setAutoRecoveryEnabled={setAutoRecoveryEnabled}
                autoRecoveryMaxRetries={autoRecoveryMaxRetries} setAutoRecoveryMaxRetries={setAutoRecoveryMaxRetries}
              />
            )}
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

export { ServiceForm };
export type { ServiceFormProps };
