'use client';

import { useState, useEffect, useCallback } from 'react';
import { getApiKeys, setApiKeys, type ApiKeyEntry } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, Button, StatusBadge, AlertBanner,
  Spinner, SectionHeader, CardSectionHeader,
} from '@/components/ui';
import { Cloud, ServerCog, Eye, EyeOff, Save, Check } from 'lucide-react';

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

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all"
      style={{
        borderColor: isEditing
          ? 'color-mix(in srgb, #10b981 40%, var(--color-border))'
          : 'var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      {/* Name + env var */}
      <div className="flex-shrink-0 w-36">
        <div className="text-sm font-medium">{entry.name}</div>
        <div className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>{entry.envVar}</div>
      </div>

      {/* Input */}
      <div className="flex-1 min-w-0">
        <input
          type={isVisible ? 'text' : 'password'}
          value={isEditing ? editValue : ''}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={entry.configured ? entry.masked : 'Not configured — paste key here'}
          className="w-full bg-transparent border-0 text-sm font-mono py-1 px-0 focus:outline-none placeholder:text-[var(--color-text-muted)]"
          style={{ color: 'var(--color-text)' }}
        />
      </div>

      {/* Toggle visibility */}
      <button
        type="button"
        onClick={onToggleVisibility}
        className="flex-shrink-0 p-1.5 rounded-md hover:bg-white/5 cursor-pointer transition-colors"
        title={isVisible ? 'Hide' : 'Show'}
      >
        {isVisible
          ? <EyeOff className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          : <Eye className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        }
      </button>

      {/* Status badge */}
      <StatusBadge variant={entry.configured ? 'emerald' : 'gray'} dot>
        {entry.configured ? 'Active' : 'Missing'}
      </StatusBadge>
    </div>
  );
}
