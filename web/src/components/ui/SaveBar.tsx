'use client';

import { Check, Save, Loader2 } from 'lucide-react';

interface SaveBarProps {
  hasChanges: boolean;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  label?: string;
}

export function SaveBar({ hasChanges, saving, saved, onSave, label = 'Save' }: SaveBarProps) {
  if (!hasChanges && !saving && !saved) return null;

  return (
    <div
      className="fixed top-0 right-0 z-20 flex items-center gap-3 px-5"
      style={{
        height: '56px', /* matches top bar h-14 */
        borderLeft: '1px solid var(--color-border)',
        background: 'color-mix(in srgb, var(--color-bg) 85%, transparent)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {saved && (
        <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: '#34d399' }}>
          <Check className="w-3.5 h-3.5" /> Saved
        </span>
      )}
      <button
        onClick={onSave}
        disabled={!hasChanges || saving}
        className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: hasChanges ? '#059669' : 'var(--color-surface-elevated)',
          color: hasChanges ? 'white' : 'var(--color-text-muted)',
          boxShadow: hasChanges ? '0 1px 4px rgba(5,150,105,0.35)' : 'none',
        }}
      >
        {saving ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</>
        ) : (
          <><Save className="w-3.5 h-3.5" /> {label}</>
        )}
      </button>
    </div>
  );
}
