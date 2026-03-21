'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  getProviderConfig, patchProviderConfig,
} from '@/lib/gateway';
import {
  Button, SectionHeader, AlertBanner,
} from '@/components/ui';
import {
  ChevronLeft, Mic, Check, Plus, Server, Cloud, Cpu,
} from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES,
  type PipelineChainEntry, type ProviderProfile,
  type Latency, type ProfileService,
} from './provider-types';
import { PROVIDER_ICON } from './FallbackChainList';
import ProfilesPanel from './ProfilesPanel';
import {
  uid, profileToStages, stagesToProfileFields, pMeta,
  DEFAULT_STAGES, DEFAULT_LLM,
  type ProfileStage,
} from './profiles/constants';
import { LatencySelector } from './profiles/LatencySelector';
import { ServiceCard } from './profiles/ServiceCard';
import { ServiceForm } from './profiles/ServiceForm';
import { StageList } from './profiles/StageList';
import { ReactFlowPipelineDiagram } from './profiles/ReactFlowDiagram';
import { usePipelineRunner } from './profiles/usePipelineRunner';

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

  // Pipeline runner for testing profiles
  const pipeline = usePipelineRunner({
    sttEnabled,
    ttsEnabled,
    sourceLang: 'fr',
    targetLang: 'en',
  });

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

  // Slide-in panel: shows ServiceCard from the right when clicking a provider in the diagram
  const [slideService, setSlideService] = useState<ProfileService | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'pipeline' | 'services'>('pipeline');

  /** Load a profile into stages state */
  const loadProfile = useCallback((p: ProviderProfile) => {
    setStages(profileToStages(p));
    setLatency(p.latency ?? 'realtime');
    const svc = migrateServices(p as ProviderProfile & Record<string, unknown>);
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
      .catch(() => {})
      .finally(() => setLoading(false));
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

        {loading ? (
          /* Loading skeleton */
          <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading profiles">
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
          <ProfilesPanel
            profiles={profiles} setProfiles={setProfiles}
            activeProfileId={activeProfileId} setActiveProfileId={setActiveProfileId}
            onApplyProfile={onApplyProfile} createCurrentProfile={createCurrentProfile}
          />
        )}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={openNew} disabled={loading}>
            <Mic className="w-4 h-4" /> New Profile
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

      {/* React Flow pipeline diagram — fills all available space */}
      <div className="flex-1 min-h-0" style={{ display: 'flex', flexDirection: 'column' }}>
        <ReactFlowPipelineDiagram
          sttChain={sttChain} llmChain={llmChain} ttsChain={ttsChain}
          sttEnabled={sttEnabled} ttsEnabled={ttsEnabled}
          services={services}
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
              ? services.find(s => s.kind === 'gpu-pod')
              : isServerless
                ? services.find(s => s.kind === 'serverless' && s.cloudProvider === 'modal')
                : services.find(s => s.kind === 'cloud' && s.cloudProvider === provider);
            if (!svc) {
              // Auto-create the service entry
              const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
              const svcKind = isGpu ? 'gpu-pod' : isServerless ? 'serverless' : 'cloud';
              svc = { id: uid(), name: providerName, kind: svcKind, cloudProvider: isGpu ? undefined : provider } as ProfileService;
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
              ? services.find(s => s.kind === 'gpu-pod')
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
          width: 'min(560px, 90vw)',
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
                    background: slideService.kind === 'gpu-pod'
                      ? 'color-mix(in srgb, #f59e0b 12%, transparent)'
                      : slideService.kind === 'serverless'
                        ? 'color-mix(in srgb, #a78bfa 12%, transparent)'
                        : 'color-mix(in srgb, #38bdf8 12%, transparent)',
                    color: slideService.kind === 'gpu-pod'
                      ? '#f59e0b'
                      : slideService.kind === 'serverless'
                        ? '#a78bfa'
                        : '#38bdf8',
                  }}>
                  {slideService.kind === 'gpu-pod' ? 'Self-hosted' : slideService.kind === 'serverless' ? 'Serverless' : 'Cloud API'}
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
            {/* GPU pod / Serverless: ServiceCard with deploy settings */}
            {(slideService.kind === 'gpu-pod' || slideService.kind === 'serverless') && (
              <div className="flex-1 overflow-y-auto">
                <ServiceCard
                  service={slideService}
                  onEdit={() => {}}
                  onDelete={() => {
                    setServices(prev => prev.filter(s => s.id !== slideService.id));
                    setSlideService(null);
                  }}
                />
              </div>
            )}
            {/* Cloud: ServiceForm with all settings */}
            {slideService.kind === 'cloud' && (
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}
