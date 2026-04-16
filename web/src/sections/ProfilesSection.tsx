'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  getProviderConfig, patchProviderConfig,
} from '@/lib/gateway';
import {
  Button, SectionHeader, AlertBanner,
} from '@/components/ui';
import {
  ChevronLeft, Mic, Check, Plus, Server, Cloud, Cpu, Pencil,
} from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES,
  type PipelineChainEntry, type App,
  type Latency, type Service,
} from './provider-types';
import { PROVIDER_ICON } from './FallbackChainList';
import ProfilesPanel from './ProfilesPanel';
const AppsPanel = ProfilesPanel;
import {
  uid, profileToStages, stagesToProfileFields, pMeta,
  DEFAULT_STAGES, DEFAULT_LLM,
  type StageEntry,
} from './profiles/constants';
import { LatencySelector } from './profiles/LatencySelector';
import { ServiceCard } from './profiles/ServiceCard';
import { ServiceForm } from './profiles/ServiceForm';
import { StageList } from './profiles/StageList';
import { ReactFlowPipelineDiagram } from './profiles/ReactFlowDiagram';
import { usePipelineRunner } from './profiles/usePipelineRunner';

// ── Main AppsSection ──

/** Parse sub-route from URL: /config/apps/edit/{id} or /config/apps/new */
function getAppSubRoute(): { view: 'list' | 'detail'; appId: string | null } {
  if (typeof window === 'undefined') return { view: 'list', appId: null };
  const path = window.location.pathname.replace(/^\//, '').replace(/\/$/, '');
  // Support both /config/apps and legacy /config/profiles URLs
  if (path === 'config/apps/new' || path === 'config/profiles/new') return { view: 'detail', appId: null };
  const m = path.match(/^config\/(?:apps|profiles)\/edit\/(.+)$/);
  if (m) return { view: 'detail', appId: m[1] };
  return { view: 'list', appId: null };
}

export function AppsSection() {
  const initRoute = getAppSubRoute();
  const [view, setViewRaw] = useState<'list' | 'detail'>(initRoute.view);
  const [apps, setApps] = useState<App[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [editingAppId, setEditingAppId] = useState<string | null>(initRoute.appId);

  /** Navigate view with URL update */
  const setView = useCallback((v: 'list' | 'detail', appId?: string | null) => {
    setViewRaw(v);
    if (v === 'list') {
      window.history.pushState(null, '', '/config/apps');
    } else if (appId) {
      window.history.pushState(null, '', `/config/apps/edit/${appId}`);
    } else {
      window.history.pushState(null, '', '/config/apps/new');
    }
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const onPop = () => {
      const r = getAppSubRoute();
      setViewRaw(r.view);
      if (r.view === 'detail' && r.appId) {
        setEditingAppId(r.appId);
        const a = apps.find(x => x.id === r.appId);
        if (a) setAppName(a.name);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [apps]);

  // Detail state
  const [stages, setStages] = useState<StageEntry[]>(() => DEFAULT_STAGES.map(s => ({ ...s, id: uid() })));
  const [latency, setLatency] = useState<Latency>('realtime');
  const [services, setServices] = useState<Service[]>(() =>
    DEFAULT_DOCKER_IMAGES.map(img => ({
      id: uid(),
      name: `Babelcast ${img.label}`,
      kind: 'container' as const,
      dockerImage: img.url,
      gpuTypes: [],
      gpuProvider: 'vast',
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

  // Pipeline runner for testing profiles
  const pipeline = usePipelineRunner({
    sttEnabled,
    ttsEnabled,
    sourceLang: 'fr',
    targetLang: 'en',
  });

  /** Migrate old gpuDeploy/gpuImage/gpuTypes top-level fields into Service entries,
   *  and auto-derive cloud API service entries from chain providers. */
  const migrateServices = (p: App & Record<string, unknown>): Service[] => {
    const hasExplicitServices = Array.isArray(p.services);
    const existing: Service[] = hasExplicitServices ? (p.services as Service[]) : [];
    const result: Service[] = [...existing];

    // Migrate GPU pods from legacy gpuDeploy field, OR auto-generate for profiles
    // that have NO services array at all (old format). If the profile has an explicit
    // services array (even empty), respect the user's choice — don't re-inject defaults.
    if (!hasExplicitServices && !result.some(s => s.kind === 'container')) {
      const gpuDeploy = p.gpuDeploy as { dockerImage?: string; gpuTypes?: string[] } | undefined;
      const gpuTypes: string[] = gpuDeploy?.gpuTypes ?? (p.gpuTypes as string[] | undefined) ?? [];
      const gpuProvider: string = (p.gpuProvider as string | undefined) ?? 'vast';
      for (const img of DEFAULT_DOCKER_IMAGES) {
        result.push({
          id: uid(),
          name: `Babelcast ${img.label}`,
          kind: 'container',
          dockerImage: img.url,
          gpuTypes,
          gpuProvider,
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
  const [editingService, setEditingService] = useState<Service | null>(null);

  // Slide-in panel: shows ServiceCard from the right when clicking a provider in the diagram
  const [slideService, setSlideService] = useState<Service | null>(null);

  const [appName, setAppName] = useState('New App');
  const [appDescription, setAppDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'pipeline' | 'services'>('pipeline');

  /** Load a profile into stages state */
  const loadApp = useCallback((p: App) => {
    setStages(profileToStages(p));
    setLatency(p.latency ?? 'realtime');
    const svc = migrateServices(p as App & Record<string, unknown>);
    setServices(svc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getProviderConfig()
      .then((cfg: any) => {
        const cfgApps = cfg.apps ?? cfg.profiles;  // compat: server may send either
        if (cfgApps?.length) setApps(cfgApps);
        if (cfg.activeAppId ?? cfg.activeProfileId) setActiveAppId(cfg.activeAppId ?? cfg.activeProfileId);
        // Load default stages from active pipeline config
        const defaultStages: StageEntry[] = [];
        if (cfg.pipelineStt?.length) defaultStages.push({ id: uid(), key: 'stt', label: 'STT', chain: cfg.pipelineStt, enabled: true });
        defaultStages.push({ id: uid(), key: 'llm', label: 'LLM', chain: cfg.pipelineLlm?.length ? cfg.pipelineLlm : DEFAULT_LLM, enabled: true });
        if (cfg.pipelineTts?.length) defaultStages.push({ id: uid(), key: 'tts', label: 'TTS', chain: cfg.pipelineTts, enabled: true });
        if (defaultStages.length > 0) setStages(defaultStages);
        // If URL points to a specific app, open it
        const route = getAppSubRoute();
        if (route.view === 'detail' && route.appId && cfgApps?.length) {
          const p = (cfgApps as App[]).find((x: App) => x.id === route.appId);
          if (p) {
            setEditingAppId(p.id);
            setAppName(p.name);
            setAppDescription(p.description ?? '');
            loadApp(p);
          }
        }
      })
      .catch((err) => { console.error('[AppsSection] Failed to load config:', err); })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setStages(DEFAULT_STAGES.map(s => ({ ...s, id: uid() })));
    setLatency('realtime');
    setServices([]);
    setEditingAppId(null);
    setAppName('New App');
    setAppDescription('');
    setView('detail', null);
  };

  const onApplyApp = useCallback((profile: App) => {
    setEditingAppId(profile.id);
    setAppName(profile.name);
    setAppDescription(profile.description ?? '');
    loadApp(profile);
    setView('detail', profile.id);
  }, [setView, loadApp]);

  const createCurrentApp = useCallback((name: string): App => {
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
    const currentName = appName || apps.find(p => p.id === editingAppId)?.name || '';
    if (!currentName?.trim()) {
      setSaveError('App name cannot be empty.');
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
    const prevApps = apps;
    const prevActiveId = activeAppId;
    const prevEditingId = editingAppId;

    try {
      let updatedApps: App[];
      let newActiveId: string;

      if (editingAppId) {
        const fields = stagesToProfileFields(stages);
        updatedApps = apps.map(p => {
          if (p.id !== editingAppId) return p;
          return { ...p, name: currentName.trim(), description: appDescription.trim() || undefined, latency, ...fields, services };
        });
        newActiveId = editingAppId;
      } else {
        const p = { ...createCurrentApp(currentName.trim()), description: appDescription.trim() || undefined };
        updatedApps = [...apps, p];
        newActiveId = p.id;
      }

      // Optimistic update
      setApps(updatedApps);
      setActiveAppId(newActiveId);
      setEditingAppId(newActiveId);

      const patch: Record<string, any> = {
        apps: updatedApps,
        activeAppId: newActiveId,
        pipelineStt: sttEnabled ? sttChain : [],
        pipelineLlm: llmChain,
        pipelineTts: ttsEnabled ? ttsChain : [],
      };

      const gpuService = services.find(s => s.kind === 'container');
      if (gpuService) {
        patch.gpuImage = gpuService.dockerImage;
        patch.gpuTypes = gpuService.gpuTypes;
        patch.gpuProvider = gpuService.gpuProvider || '';
      }

      await patchProviderConfig(patch as any);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      // Rollback optimistic state
      setApps(prevApps);
      setActiveAppId(prevActiveId);
      setEditingAppId(prevEditingId);
      setSaveError(err instanceof Error ? err.message : 'Failed to save profile. Check gateway connection.');
    } finally { setSaving(false); }
  };

  if (view === 'list') {
    return (
      <div className="p-6 space-y-5 pb-20">
        <SectionHeader
          title="Apps"
          subtitle="Manage pipeline apps"
        />

        {loading ? (
          /* Loading skeleton */
          <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading apps">
            {[1, 2, 3].map(i => (
              <div key={i} className="rounded-lg border p-3 flex items-center gap-3"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
                <div className="w-5 h-5 rounded-md" style={{ background: 'var(--color-border)' }} />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 rounded w-1/3" style={{ background: 'var(--color-border)' }} />
                  <div className="h-2.5 rounded w-2/3" style={{ background: 'color-mix(in srgb, var(--color-border) 50%, transparent)' }} />
                </div>
                <div className="w-8 h-4 rounded-full" style={{ background: 'var(--color-border)' }} />
              </div>
            ))}
          </div>
        ) : (
          <AppsPanel
            apps={apps} setApps={setApps}
            activeAppId={activeAppId} setActiveAppId={setActiveAppId}
            onApplyApp={onApplyApp} createCurrentApp={createCurrentApp}
          />
        )}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={openNew} disabled={loading}>
            <Mic className="w-4 h-4" /> New App
          </Button>
        </div>

      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ position: 'relative' }}>
      {/* Top bar: Back + editable name + Save */}
      <div className="flex items-center gap-3 px-6 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}>
        <button
          onClick={() => setView('list', null)}
          className="flex items-center gap-1 text-sm cursor-pointer transition-opacity hover:opacity-70 flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ChevronLeft className="w-4 h-4" /> Apps
        </button>
        <span style={{ color: 'var(--color-border)' }}>/</span>
        <div className="flex-1 min-w-0">
          <div className="group flex items-center gap-1.5">
            <input
              type="text"
              value={appName || apps.find(p => p.id === editingAppId)?.name || ''}
              onChange={e => setAppName(e.target.value)}
              placeholder="App name..."
              className="flex-1 min-w-0 text-base font-bold bg-transparent border-none outline-none rounded px-1 -ml-1 transition-colors hover:bg-white/5 focus:bg-white/5"
              style={{ color: 'var(--color-text)' }}
            />
            <Pencil className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-40 transition-opacity" style={{ color: 'var(--color-text-muted)' }} />
            {editingAppId && (
              <code className="text-[10px] font-mono flex-shrink-0 px-1.5 py-0.5 rounded"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
                {editingAppId}
              </code>
            )}
          </div>
          <input
            type="text"
            value={appDescription}
            onChange={e => setAppDescription(e.target.value)}
            placeholder="Description (opcional)..."
            className="w-full text-xs bg-transparent border-none outline-none rounded px-1 -ml-1 mt-0.5 transition-colors hover:bg-white/5 focus:bg-white/5"
            style={{ color: 'var(--color-text-muted)' }}
          />
        </div>
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

      {/* React Flow pipeline diagram — fills all available space */}
      <div className="flex-1 min-h-0" style={{ display: 'flex', flexDirection: 'column' }}>
        <ReactFlowPipelineDiagram
          sttChain={sttChain} llmChain={llmChain} ttsChain={ttsChain}
          sttEnabled={sttEnabled} ttsEnabled={ttsEnabled}
          services={services}
          profileId={editingAppId}
          pipelineState={pipeline}
          onRunPipeline={pipeline.run}
          onResetPipeline={pipeline.reset}
          onAddService={(stageKey, provider, model) => {
            // 1. Add to chain
            setStages(prev => prev.map(s => {
              if (s.key !== stageKey) return s;
              return { ...s, chain: [...s.chain, { provider, model }] };
            }));
            // 2. Find or create the matching service and open slide panel
            const isGpu = provider === 'gpu';
            const isServerless = provider === 'modal';
            let svc = isGpu
              ? services.find(s => s.kind === 'container')
              : isServerless
                ? services.find(s => s.kind === 'serverless' && s.cloudProvider === 'modal')
                : services.find(s => s.kind === 'cloud' && s.cloudProvider === provider);
            if (!svc) {
              // Auto-create the service entry
              const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
              const svcKind = isGpu ? 'container' : isServerless ? 'serverless' : 'cloud';
              svc = { id: uid(), name: providerName, kind: svcKind, cloudProvider: isGpu ? undefined : provider } as Service;
              setServices(prev => [...prev, svc!]);
            }
            setSlideService(svc);
          }}
          onReorderChain={(stageKey, newChain) => {
            setStages(prev => prev.map(s => {
              if (s.key !== stageKey) return s;
              return { ...s, chain: newChain };
            }));
          }}
          onClickProvider={(stageKey, entryIdx) => {
            const stage = stages.find(s => s.key === stageKey);
            const entry = stage?.chain[entryIdx];
            if (!entry) return;
            const matchingSvc = entry.provider === 'gpu'
              ? services.find(s => s.kind === 'container')
              : entry.provider === 'modal'
                ? services.find(s => s.kind === 'serverless' && s.cloudProvider === 'modal')
                : services.find(s => s.kind === 'cloud' && s.cloudProvider === entry.provider);
            if (matchingSvc) {
              setSlideService(prev => prev?.id === matchingSvc.id ? null : matchingSvc);
            }
          }}
        />
      </div>


      {/* Backdrop overlay */}
      {slideService && (
        <div className="fixed inset-0" style={{ background: 'rgba(0,0,0,0.3)', zIndex: 50 }}
          onClick={() => setSlideService(null)} />
      )}

      {/* Slide-in service panel — fixed to viewport right */}
      <div
        className="fixed top-0 right-0 h-full border-l transition-transform duration-300 ease-in-out"
        style={{
          width: 'min(700px, 90vw)',
          transform: slideService ? 'translateX(0)' : 'translateX(100%)',
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
          zIndex: 51,
          boxShadow: '-8px 0 40px rgba(0,0,0,0.4)',
        }}>
        {slideService && (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                  {slideService.name}
                </span>
                <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded"
                  style={{
                    background: slideService.kind === 'container'
                      ? 'color-mix(in srgb, #f59e0b 12%, transparent)'
                      : slideService.kind === 'serverless'
                        ? 'color-mix(in srgb, #a78bfa 12%, transparent)'
                        : 'color-mix(in srgb, #38bdf8 12%, transparent)',
                    color: slideService.kind === 'container'
                      ? '#f59e0b'
                      : slideService.kind === 'serverless'
                        ? '#a78bfa'
                        : '#38bdf8',
                  }}>
                  {slideService.kind === 'container' ? 'Self-hosted' : slideService.kind === 'serverless' ? 'Serverless' : 'Cloud API'}
                </span>
              </div>
              <button onClick={() => setSlideService(null)}
                className="p-1.5 rounded cursor-pointer transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <ChevronLeft className="w-4 h-4" style={{ transform: 'rotate(180deg)' }} />
              </button>
            </div>
            {/* ServiceForm for all service kinds */}
            <div className="flex-1 overflow-y-auto p-4">
              <ServiceForm
                initial={slideService}
                onSave={s => {
                  setServices(prev => prev.map(x => x.id === s.id ? s : x));
                  setSlideService(s);
                }}
                onCancel={() => setSlideService(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
