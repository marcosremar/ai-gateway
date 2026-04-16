'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { X, Plus, Check, Trash2, Pencil, Copy, Mic, Bot, Volume2 } from 'lucide-react';
import { Button, Toggle, ConfirmModal } from '@/components/ui';
import { patchProviderConfig } from '@/lib/gateway';
import type { App } from './provider-types';

const LATENCY_BADGE: Record<string, { label: string; color: string }> = {
  realtime: { label: 'realtime', color: '#10b981' },
  low: { label: 'low', color: '#3b82f6' },
  batch: { label: 'batch', color: '#6b7280' },
};

// ── App Item ──

const AppItem = memo(function AppItem({
  profile, index, isActive, onApply, onDelete, onRename, onToggleEnabled, onDuplicate,
}: {
  profile: App; index: number; isActive: boolean;
  onApply: (p: App) => void;
  onDelete: (p: App) => void;
  onRename: (id: string, name: string) => void;
  onToggleEnabled: (id: string) => void;
  onDuplicate: (p: App) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(profile.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commitRename = () => {
    const t = editName.trim();
    if (t && t !== profile.name) onRename(profile.id, t);
    setEditing(false);
  };

  const isEnabled = profile.enabled !== false;
  const accentColor = '#0ea5e9';

  const latencyBadge = LATENCY_BADGE[profile.latency] ?? null;

  const activeStages = [
    profile.stt !== undefined ? 'stt' : null,
    'llm',
    profile.tts !== undefined ? 'tts' : null,
  ].filter(Boolean) as string[];

  const gpuCount = (profile.services ?? []).filter(s => s.kind === 'container' || s.kind === 'serverless').length;

  const summaryParts: string[] = [];
  if (profile.stt && profile.stt[0]) summaryParts.push(profile.stt[0].provider);
  if (profile.llm?.[0]) summaryParts.push(profile.llm[0].provider);
  if (profile.tts && profile.tts[0]) summaryParts.push(profile.tts[0].provider);
  let summary = summaryParts.join(' → ');
  const allChains = [profile.stt, profile.llm, profile.tts].filter(Boolean) as typeof profile.llm[];
  const fb = allChains.filter(s => s.length > 1).reduce((a, s) => a + s.length - 1, 0);
  if (fb > 0) summary += ` (+${fb} fallback${fb > 1 ? 's' : ''})`;
  if (gpuCount > 0) summary += ` · ${gpuCount} GPU pod${gpuCount > 1 ? 's' : ''}`;

  return (
    <div
      data-id={profile.id}
      role="button"
      tabIndex={0}
      aria-label={`${profile.name} — ${profile.latency ?? 'realtime'}`}
      className="group flex items-center gap-2.5 rounded-lg border transition-all cursor-pointer px-3 py-2.5"
      onClick={() => !editing && onApply(profile)}
      onKeyDown={e => {
        if (editing) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onApply(profile); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDelete(profile); }
        if (e.key === 'F2') { e.preventDefault(); setEditName(profile.name); setEditing(true); }
      }}
      style={{
        borderColor: isActive ? `color-mix(in srgb, ${accentColor} 40%, transparent)` : 'var(--color-border)',
        background: isActive ? `color-mix(in srgb, ${accentColor} 4%, var(--color-surface-elevated))` : 'var(--color-surface-elevated)',
        opacity: isEnabled ? 1 : 0.45,
      }}
    >
      {/* Rank */}
      <span className="text-[10px] font-bold w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
        style={{
          background: isActive ? `color-mix(in srgb, ${accentColor} 15%, transparent)` : 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
          color: isActive ? accentColor : 'var(--color-text-muted)',
        }}>
        {index + 1}
      </span>

      {/* Latency badge */}
      {latencyBadge && (
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md flex-shrink-0"
          style={{ background: `color-mix(in srgb, ${latencyBadge.color} 10%, transparent)` }}>
          <span className="text-[10px] font-semibold" style={{ color: latencyBadge.color }}>
            {latencyBadge.label}
          </span>
        </div>
      )}

      {/* Stage pills */}
      {activeStages.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {activeStages.map(stage => {
            const stageColor = stage === 'stt' ? '#0ea5e9' : stage === 'llm' ? '#8b5cf6' : '#f59e0b';
            const StageIcon = stage === 'stt' ? Mic : stage === 'llm' ? Bot : Volume2;
            return (
              <div key={stage} className="flex items-center gap-0.5 px-1 py-0.5 rounded flex-shrink-0"
                style={{ background: `color-mix(in srgb, ${stageColor} 10%, transparent)` }}>
                <StageIcon className="w-2.5 h-2.5" style={{ color: stageColor }} />
                <span className="text-[9px] font-semibold uppercase" style={{ color: stageColor }}>{stage}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Name + summary */}
      {editing ? (
        <input ref={inputRef} type="text" value={editName}
          onChange={e => setEditName(e.target.value)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setEditName(profile.name); setEditing(false); } }}
          onBlur={commitRename}
          className="flex-1 min-w-0 rounded-md border px-2 py-0.5 text-sm font-semibold"
          style={{ borderColor: accentColor, background: 'var(--color-surface)', color: 'var(--color-text)', outline: 'none' }}
        />
      ) : (
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: accentColor }} />}
            <span className={`text-sm font-semibold truncate ${!isEnabled ? 'line-through' : ''}`}>{profile.name}</span>
            <code className="text-[9px] font-mono px-1 py-0.5 rounded flex-shrink-0 opacity-40"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
              {profile.id.slice(0, 8)}
            </code>
          </div>
          {profile.description ? (
            <span className="text-[11px] truncate block" style={{ color: 'var(--color-text-secondary)' }}>{profile.description}</span>
          ) : (
            <span className="text-[11px] truncate block" style={{ color: 'var(--color-text-muted)' }}>{summary}</span>
          )}
        </div>
      )}

      {/* Enable/disable toggle */}
      <div onClick={e => e.stopPropagation()} className="flex-shrink-0">
        <Toggle checked={isEnabled} onChange={() => onToggleEnabled(profile.id)} size="sm" />
      </div>

      {/* Actions */}
      {!editing && (
        <button type="button" onClick={e => { e.stopPropagation(); setEditName(profile.name); setEditing(true); }}
          aria-label={`Rename ${profile.name}`} title="Rename"
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/5 flex-shrink-0 transition-opacity cursor-pointer">
          <Pencil className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        </button>
      )}
      <button type="button" onClick={e => { e.stopPropagation(); onDuplicate(profile); }}
        aria-label={`Duplicate ${profile.name}`} title="Duplicate"
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/5 flex-shrink-0 transition-opacity cursor-pointer">
        <Copy className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
      </button>
      <button type="button" onClick={e => { e.stopPropagation(); onDelete(profile); }}
        aria-label={`Delete ${profile.name}`} title="Delete"
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 flex-shrink-0 transition-opacity cursor-pointer">
        <Trash2 className="w-3 h-3 text-red-400" />
      </button>
    </div>
  );
});

// ── Panel ──

interface AppsPanelProps {
  apps: App[];
  setApps: React.Dispatch<React.SetStateAction<App[]>>;
  activeAppId: string | null;
  setActiveAppId: React.Dispatch<React.SetStateAction<string | null>>;
  onApplyApp: (profile: App) => void;
  createCurrentApp: (name: string) => App;
}

export default function AppsPanel({
  apps, setApps, activeAppId, setActiveAppId, onApplyApp, createCurrentApp,
}: AppsPanelProps) {
  const [newName, setNewName] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<App | null>(null);

  const doDelete = () => {
    if (!confirmDelete) return;
    const next = apps.filter(p => p.id !== confirmDelete.id);
    setApps(next);
    if (activeAppId === confirmDelete.id) setActiveAppId(next[0]?.id || null);
    setConfirmDelete(null);
    patchProviderConfig({ apps: next } as any).catch(console.error);
  };

  const toggleEnabled = useCallback((id: string) => {
    setApps(prev => {
      const next = prev.map(p => p.id === id ? { ...p, enabled: !(p.enabled !== false) } : p);
      patchProviderConfig({ apps: next } as any).catch(console.error);
      return next;
    });
  }, [setApps]);

  const duplicateApp = useCallback((p: App) => {
    const copy: App = {
      ...p,
      id: `${p.id}-${Date.now()}`,
      name: `${p.name} (copy)`,
      stt: p.stt ? [...p.stt] : undefined,
      llm: [...p.llm],
      tts: p.tts ? [...p.tts] : undefined,
      services: p.services ? p.services.map(s => ({ ...s })) : [],
    };
    setApps(prev => [...prev, copy]);
  }, [setApps]);

  const save = () => {
    const name = newName.trim();
    if (!name) return;
    const p = createCurrentApp(name);
    setApps(prev => [...prev, p]);
    setActiveAppId(p.id);
    setNewName('');
    setShowInput(false);
  };

  return (
    <>
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center justify-between px-4 py-2.5" style={{
          background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)',
        }}>
          <p className="text-xs font-semibold">Apps</p>
          <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            {apps.length > 0 ? `${apps.length} saved · click to load · toggle to enable/disable` : 'Save current config as a profile'}
          </p>
        </div>

        {apps.length > 0 ? (
          <div className="p-2" style={{ background: 'var(--color-bg)' }}>
            <div className="flex flex-col gap-1.5">
              {apps.map((p, i) => (
                <AppItem key={p.id} profile={p} index={i}
                  isActive={activeAppId === p.id}
                  onApply={onApplyApp}
                  onDelete={p => setConfirmDelete(p)}
                  onRename={(id, name) => setApps(prev => {
                    const next = prev.map(x => x.id === id ? { ...x, name } : x);
                    patchProviderConfig({ apps: next } as any).catch(console.error);
                    return next;
                  })}
                  onToggleEnabled={toggleEnabled}
                  onDuplicate={duplicateApp}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="px-4 py-5 text-center" style={{ background: 'var(--color-bg)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No apps yet</p>
          </div>
        )}

        <div className="px-2 py-2 border-t" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}>
          {!showInput ? (
            <button type="button" onClick={() => setShowInput(true)}
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg border border-dashed text-xs cursor-pointer transition-all hover:border-[var(--color-text-muted)]"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
              <Plus className="w-3 h-3" /> Save current config as profile
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setNewName(''); setShowInput(false); } }}
                placeholder="App name..." autoFocus
                className="flex-1 rounded-lg border px-2.5 py-1.5 text-sm"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }} />
              <Button variant="primary" size="sm" onClick={save} disabled={!newName.trim()}>Save</Button>
              <button type="button" onClick={() => { setNewName(''); setShowInput(false); }}
                className="p-1 rounded hover:bg-white/5 flex-shrink-0 cursor-pointer">
                <X className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
              </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal open={confirmDelete !== null} onClose={() => setConfirmDelete(null)}
        onConfirm={doDelete} title="Delete profile?"
        description={`"${confirmDelete?.name}" will be permanently removed.`}
        confirmLabel="Delete" variant="danger" />
    </>
  );
}
