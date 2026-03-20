'use client';

import { useState, useEffect, useCallback } from 'react';
import { getApiKeys, setApiKeys, type ApiKeyEntry } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, Button, StatusBadge, AlertBanner,
  Spinner, SectionHeader, CardSectionHeader, IconBox,
} from '@/components/ui';
import { Cloud, ServerCog, Eye, EyeOff, Save, Check, KeyRound, AlertTriangle } from 'lucide-react';

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getApiKeys();
      setKeys(data.keys);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleEdit = (envVar: string, value: string) => {
    setEdits(prev => ({ ...prev, [envVar]: value }));
    setSaved(false);
  };

  const toggleVisibility = (envVar: string) => {
    setVisible(prev => {
      const next = new Set(prev);
      if (next.has(envVar)) next.delete(envVar); else next.add(envVar);
      return next;
    });
  };

  const handleSave = async () => {
    const toSave: Record<string, string> = {};
    for (const [envVar, value] of Object.entries(edits)) {
      toSave[envVar] = value;
    }
    if (Object.keys(toSave).length === 0) return;

    setSaving(true);
    try {
      const result = await setApiKeys(toSave);
      setKeys(result.keys);
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save API keys');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = Object.keys(edits).length > 0;

  if (loading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (error && !keys.length) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;

  const cloudKeys = keys.filter(k => k.category === 'cloud');
  const gpuKeys = keys.filter(k => k.category === 'gpu');

  const totalKeys = keys.length;
  const configuredKeys = keys.filter(k => k.configured).length;
  const progressPct = totalKeys > 0 ? Math.round((configuredKeys / totalKeys) * 100) : 0;

  return (
    <div className="p-6 space-y-5">
      <SectionHeader
        title="API Keys"
        subtitle="Configure provider API keys. Saved to the gateway .env file."
        action={
          <div className="flex items-center gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <Check className="w-3.5 h-3.5" /> Saved
              </span>
            )}
            <Button
              onClick={handleSave}
              disabled={!hasChanges}
              isLoading={saving}
              loadingText="Saving..."
              size="sm"
            >
              <Save className="w-3.5 h-3.5" /> Save Changes
            </Button>
          </div>
        }
      />

      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      {/* Inline progress summary */}
      <div
        className="flex items-center gap-4 px-4 py-3 rounded-xl"
        style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}
      >
        <IconBox icon={KeyRound} color="#10b981" size="sm" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {configuredKeys} of {totalKeys} providers configured
            </span>
            <span
              className="text-xs font-mono font-semibold"
              style={{ color: configuredKeys === totalKeys ? '#34d399' : '#fbbf24' }}
            >
              {progressPct}%
            </span>
          </div>
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--color-border)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progressPct}%`,
                background: configuredKeys === totalKeys
                  ? 'linear-gradient(90deg, #10b981, #34d399)'
                  : 'linear-gradient(90deg, #f59e0b, #fbbf24)',
              }}
            />
          </div>
        </div>
        {configuredKeys < totalKeys && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs text-amber-400 font-medium">{totalKeys - configuredKeys} missing</span>
          </div>
        )}
      </div>

      <AlertBanner variant="info">
        Changes take effect immediately for new requests. Some providers may require a gateway restart for full reconfiguration.
      </AlertBanner>

      {/* Cloud API Keys */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Cloud} color="blue" title="Cloud API Keys" subtitle="STT, LLM, and TTS cloud providers" />
        </CardHeader>
        <CardBody className="space-y-2">
          {cloudKeys.map(key => (
            <KeyRow
              key={key.envVar}
              entry={key}
              editValue={edits[key.envVar]}
              isVisible={visible.has(key.envVar)}
              onEdit={(v) => handleEdit(key.envVar, v)}
              onToggleVisibility={() => toggleVisibility(key.envVar)}
            />
          ))}
        </CardBody>
      </Card>

      {/* GPU Provider Keys */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={ServerCog} color="violet" title="GPU Provider Keys" subtitle="Self-hosted GPU deployment platforms" />
        </CardHeader>
        <CardBody className="space-y-2">
          {gpuKeys.map(key => (
            <KeyRow
              key={key.envVar}
              entry={key}
              editValue={edits[key.envVar]}
              isVisible={visible.has(key.envVar)}
              onEdit={(v) => handleEdit(key.envVar, v)}
              onToggleVisibility={() => toggleVisibility(key.envVar)}
            />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function KeyRow({
  entry,
  editValue,
  isVisible,
  onEdit,
  onToggleVisibility,
}: {
  entry: ApiKeyEntry;
  editValue?: string;
  isVisible: boolean;
  onEdit: (value: string) => void;
  onToggleVisibility: () => void;
}) {
  const isEditing = editValue !== undefined;
  const isConfigured = entry.configured;

  // Status-based accent colors
  const accentColor = isConfigured ? '#10b981' : '#ef4444';
  const bgTint = isConfigured ? 'rgba(16, 185, 129, 0.04)' : 'rgba(239, 68, 68, 0.04)';
  const borderColor = isEditing
    ? 'color-mix(in srgb, #10b981 50%, var(--color-border))'
    : isConfigured
      ? 'color-mix(in srgb, #10b981 20%, var(--color-border))'
      : 'color-mix(in srgb, #ef4444 20%, var(--color-border))';

  return (
    <div
      className="flex items-center gap-3 rounded-lg overflow-hidden transition-all"
      style={{
        background: bgTint,
        border: `1px solid ${borderColor}`,
        borderLeft: `2.5px solid ${accentColor}`,
      }}
    >
      {/* Icon */}
      <div className="flex-shrink-0 pl-3">
        <IconBox
          icon={KeyRound}
          color={accentColor}
          size="sm"
        />
      </div>

      {/* Name + env var */}
      <div className="flex-shrink-0 w-36 py-2.5">
        <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{entry.name}</div>
        <div
          className="text-[10px] font-mono mt-0.5"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {entry.envVar}
        </div>
      </div>

      {/* Code-editor style input area */}
      <div
        className="flex-1 min-w-0 mx-1 my-1.5 rounded-md px-3 py-1.5 flex items-center gap-2"
        style={{
          background: 'color-mix(in srgb, var(--color-surface) 60%, transparent)',
          border: '1px solid var(--color-border)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        <input
          type={isVisible ? 'text' : 'password'}
          value={isEditing ? editValue : ''}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={entry.configured ? entry.masked : 'Not configured — paste key here'}
          className="w-full bg-transparent border-0 text-xs py-0.5 px-0 focus:outline-none placeholder:opacity-50"
          style={{
            color: isEditing ? '#34d399' : 'var(--color-text-muted)',
            fontFamily: 'inherit',
          }}
        />
        <button
          type="button"
          onClick={onToggleVisibility}
          className="flex-shrink-0 p-1 rounded hover:bg-white/5 cursor-pointer transition-colors"
          title={isVisible ? 'Hide' : 'Show'}
        >
          {isVisible
            ? <EyeOff className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            : <Eye className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          }
        </button>
      </div>

      {/* Status badge — more prominent */}
      <div className="flex-shrink-0 pr-3">
        <StatusBadge variant={isConfigured ? 'emerald' : 'red'} dot>
          {isConfigured ? 'Active' : 'Missing'}
        </StatusBadge>
      </div>
    </div>
  );
}
