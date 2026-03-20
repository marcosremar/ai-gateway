'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getLatencySettings, patchLatencySettings, triggerStandbyDeploy,
  initiateStandbyHandover, cancelStandbyDeploy,
  type LatencySettings, type StandbyStatus,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, CardFooter, Button, Toggle,
  SectionHeader, StatusBadge, AlertBanner, KV, FormInput,
} from '@/components/ui';
import { Moon, Play, ArrowRightLeft, XCircle, RefreshCw, Clock } from 'lucide-react';

function fmtHours(h: number | null): string {
  if (h === null) return '—';
  return h === 1 ? '1 hour' : `${h} hours`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function statusColor(status: StandbyStatus['status']): string {
  switch (status) {
    case 'ready':      return '#34d399';
    case 'deploying':  return '#fbbf24';
    case 'benchmarking': return '#38bdf8';
    case 'handover':   return '#a78bfa';
    case 'error':      return '#f87171';
    default:           return 'var(--color-text-muted)';
  }
}

function statusVariant(status: StandbyStatus['status']): 'emerald' | 'amber' | 'sky' | 'purple' | 'red' | 'gray' {
  switch (status) {
    case 'ready':        return 'emerald';
    case 'deploying':    return 'amber';
    case 'benchmarking': return 'sky';
    case 'handover':     return 'purple';
    case 'error':        return 'red';
    default:             return 'gray';
  }
}

export function StandbySection() {
  const [settings, setSettings]   = useState<LatencySettings | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [dirty, setDirty]         = useState(false);

  // Editable local state
  const [enabled, setEnabled]     = useState(false);
  const [triggerHours, setTriggerHours] = useState(2);
  const [drainTimeoutMs, setDrainTimeoutMs] = useState(30_000);

  // Action loading states
  const [deploying, setDeploying]   = useState(false);
  const [handing, setHanding]       = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await getLatencySettings();
      setSettings(s);
      // Only sync local form state when not dirty
      if (!dirty) {
        setEnabled(s.standbyEnabled ?? false);
        setTriggerHours(s.standbyTriggerHours ?? 2);
        setDrainTimeoutMs(s.standbyDrainTimeoutMs ?? 30_000);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dirty]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setActionError(null);
    try {
      const updated = await patchLatencySettings({
        standbyEnabled: enabled,
        standbyTriggerHours: triggerHours,
        standbyDrainTimeoutMs: drainTimeoutMs,
      });
      setSettings(updated);
      setDirty(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeploy() {
    setDeploying(true);
    setActionError(null);
    try {
      const res = await triggerStandbyDeploy();
      if (!res.ok) throw new Error(res.error ?? 'Deploy failed');
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  }

  async function handleHandover() {
    setHanding(true);
    setActionError(null);
    try {
      const res = await initiateStandbyHandover();
      if (!res.ok) throw new Error(res.error ?? 'Handover failed');
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setHanding(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    setActionError(null);
    try {
      await cancelStandbyDeploy();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  const markDirty = () => setDirty(true);

  if (loading) return (
    <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      <div className="inline-flex items-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span>Loading standby settings...</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 p-6">
      <SectionHeader
        title="GPU Standby"
        subtitle="Pre-warm a standby GPU pod in the background so it's ready to take over instantly when the active pod is idle or needs replacement."
      />

      {error && <AlertBanner variant="error">{error}</AlertBanner>}
      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}

      {/* ── Enable / Config ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, #a78bfa 15%, transparent)' }}
              >
                <Moon className="w-4 h-4" style={{ color: '#a78bfa' }} />
              </div>
              <div>
                <span className="text-sm font-semibold">Standby Mode</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  Keep a warm GPU pod ready in the background
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge variant={enabled ? 'emerald' : 'gray'} dot>
                {enabled ? 'Enabled' : 'Disabled'}
              </StatusBadge>
              <Toggle
                checked={enabled}
                onChange={v => { setEnabled(v); markDirty(); }}
                size="md"
              />
            </div>
          </div>
        </CardHeader>

        <CardBody className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <FormInput
              label="Trigger After (hours)"
              type="number"
              value={triggerHours}
              hint="Deploy a standby pod after this many hours of active GPU usage."
              onChange={e => { setTriggerHours(Number(e.target.value)); markDirty(); }}
            />
            <FormInput
              label="Drain Timeout (ms)"
              type="number"
              value={drainTimeoutMs}
              hint="How long to wait for in-flight requests to finish before completing handover."
              onChange={e => { setDrainTimeoutMs(Number(e.target.value)); markDirty(); }}
            />
          </div>

          {/* Current persisted values */}
          {settings && !dirty && (
            <div className="grid grid-cols-3 gap-3 pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <KV label="Standby enabled" value={settings.standbyEnabled ? 'yes' : 'no'} />
              <KV label="Trigger after" value={fmtHours(settings.standbyTriggerHours)} />
              <KV label="Drain timeout" value={fmtMs(settings.standbyDrainTimeoutMs)} />
            </div>
          )}
        </CardBody>

        {dirty && (
          <CardFooter>
            <div className="flex items-center gap-3">
              <Button onClick={handleSave} isLoading={saving} loadingText="Saving...">
                Save Settings
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (settings) {
                    setEnabled(settings.standbyEnabled ?? false);
                    setTriggerHours(settings.standbyTriggerHours ?? 2);
                    setDrainTimeoutMs(settings.standbyDrainTimeoutMs ?? 30_000);
                  }
                  setDirty(false);
                }}
              >
                Discard
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      {/* ── Manual Controls ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, #38bdf8 15%, transparent)' }}
            >
              <Clock className="w-4 h-4" style={{ color: '#38bdf8' }} />
            </div>
            <div>
              <span className="text-sm font-semibold">Manual Controls</span>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Manually trigger standby operations
              </p>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="text-xs mb-4 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
            <strong style={{ color: 'var(--color-text-secondary)' }}>Deploy</strong> — spin up a new standby pod now (pre-warm before it&apos;s needed).{' '}
            <strong style={{ color: 'var(--color-text-secondary)' }}>Handover</strong> — promote the standby to active, draining in-flight requests.{' '}
            <strong style={{ color: 'var(--color-text-secondary)' }}>Cancel</strong> — terminate the standby pod without promoting it.
          </div>
        </CardBody>
        <CardFooter>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleDeploy} isLoading={deploying} loadingText="Deploying...">
              <Play className="w-4 h-4" /> Deploy Standby
            </Button>
            <Button variant="outline" onClick={handleHandover} isLoading={handing} loadingText="Handing over...">
              <ArrowRightLeft className="w-4 h-4" /> Initiate Handover
            </Button>
            <Button variant="danger" onClick={handleCancel} isLoading={cancelling} loadingText="Cancelling...">
              <XCircle className="w-4 h-4" /> Cancel Standby
            </Button>
            <Button variant="ghost" onClick={load}>
              <RefreshCw className="w-4 h-4" /> Refresh
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}

// Re-export the status color helpers so callers can use them if needed
export { statusColor, statusVariant };
