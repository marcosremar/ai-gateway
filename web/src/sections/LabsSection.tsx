'use client';

import { useState, useEffect, useCallback } from 'react';
import { getLabsFlags, updateLabsFlags, type LabsFlags } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, Toggle, SectionHeader, AlertBanner,
  Spinner, StatusBadge, SaveBar, CardSectionHeader,
} from '@/components/ui';
import { BarChart3, Languages, Layers } from 'lucide-react';

export function LabsSection() {
  const [flags, setFlags] = useState<LabsFlags | null>(null);
  const [draft, setDraft] = useState<Partial<LabsFlags>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getLabsFlags();
      setFlags(data);
      setDraft({});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load labs flags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateDraft = (patch: Partial<LabsFlags>) => {
    setDraft(prev => ({ ...prev, ...patch }));
    setSaved(false);
  };

  const hasChanges = Object.keys(draft).length > 0;

  const merged = flags ? { ...flags, ...draft } : null;

  const handleSave = async () => {
    if (!hasChanges) return;
    setSaving(true);
    try {
      const updated = await updateLabsFlags(draft);
      setFlags(updated);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save labs flags');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (error && !flags) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;
  if (!merged) return null;

  return (
    <div className="p-6 space-y-5">
      <SectionHeader
        title="Labs"
        subtitle="Experimental features — enable at your own risk"
      />

      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      <AlertBanner variant="warning">
        These features are experimental and may affect stability. Changes are applied after saving.
      </AlertBanner>

      {/* PeakEWMA Load Balancing */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardSectionHeader
              icon={BarChart3}
              color="#f59e0b"
              title="PeakEWMA Load Balancing"
              subtitle="Route requests to providers based on exponentially weighted moving average latency, favoring faster endpoints"
            />
            <div className="flex items-center gap-3 flex-shrink-0">
              <StatusBadge variant={merged.peakEwma ? 'emerald' : 'gray'} dot>
                {merged.peakEwma ? 'Enabled' : 'Disabled'}
              </StatusBadge>
              <Toggle
                checked={merged.peakEwma}
                onChange={(v) => updateDraft({ peakEwma: v })}
              />
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            <label className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  Decay Factor
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  How fast old latency observations decay (0.1 = slow, 0.9 = fast). Default: 0.3
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <input
                  type="range"
                  min="0.1"
                  max="0.9"
                  step="0.05"
                  value={merged.ewmaDecayFactor}
                  onChange={(e) => updateDraft({ ewmaDecayFactor: parseFloat(e.target.value) })}
                  className="w-32"
                  disabled={!merged.peakEwma}
                />
                <span
                  className="text-sm font-mono w-10 text-right"
                  style={{ color: 'var(--color-text)' }}
                >
                  {merged.ewmaDecayFactor.toFixed(2)}
                </span>
              </div>
            </label>
          </div>
        </CardBody>
      </Card>

      {/* Speculative Translation */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardSectionHeader
              icon={Languages}
              color="#8b5cf6"
              title="Speculative Translation"
              subtitle="Start translating partial ASR results before transcription is finalized, reducing perceived latency"
            />
            <div className="flex items-center gap-3 flex-shrink-0">
              <StatusBadge variant={merged.speculativeTranslation ? 'emerald' : 'gray'} dot>
                {merged.speculativeTranslation ? 'Enabled' : 'Disabled'}
              </StatusBadge>
              <Toggle
                checked={merged.speculativeTranslation}
                onChange={(v) => updateDraft({ speculativeTranslation: v })}
              />
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            <label className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  Min Confidence
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Minimum ASR confidence to start speculative translation (0.5 - 0.95). Default: 0.7
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <input
                  type="range"
                  min="0.5"
                  max="0.95"
                  step="0.05"
                  value={merged.speculationMinConfidence}
                  onChange={(e) => updateDraft({ speculationMinConfidence: parseFloat(e.target.value) })}
                  className="w-32"
                  disabled={!merged.speculativeTranslation}
                />
                <span
                  className="text-sm font-mono w-10 text-right"
                  style={{ color: 'var(--color-text)' }}
                >
                  {merged.speculationMinConfidence.toFixed(2)}
                </span>
              </div>
            </label>
          </div>
        </CardBody>
      </Card>

      {/* Streaming Pipeline Overlap */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardSectionHeader
              icon={Layers}
              color="#06b6d4"
              title="Streaming Pipeline Overlap"
              subtitle="Start TTS synthesis before LLM translation is fully complete, overlapping pipeline stages for lower latency"
            />
            <div className="flex items-center gap-3 flex-shrink-0">
              <StatusBadge variant={merged.streamingOverlap ? 'emerald' : 'gray'} dot>
                {merged.streamingOverlap ? 'Enabled' : 'Disabled'}
              </StatusBadge>
              <Toggle
                checked={merged.streamingOverlap}
                onChange={(v) => updateDraft({ streamingOverlap: v })}
              />
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            <label className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  Min Tokens Before TTS
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Minimum LLM tokens received before starting TTS (1 - 10). Default: 3
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={merged.overlapMinTokens}
                  onChange={(e) => updateDraft({ overlapMinTokens: parseInt(e.target.value, 10) || 3 })}
                  className="w-20 px-2 py-1 text-sm font-mono rounded-md border text-right"
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                  disabled={!merged.streamingOverlap}
                />
              </div>
            </label>
          </div>
        </CardBody>
      </Card>

      <SaveBar
        hasChanges={hasChanges}
        saving={saving}
        saved={saved}
        onSave={handleSave}
        label="Save Labs Settings"
      />
    </div>
  );
}
