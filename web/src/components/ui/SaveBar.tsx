'use client';

import { Check, Save, Loader2 } from 'lucide-react';

interface SaveBarProps {
  hasChanges: boolean;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  label?: string;
}

export function SaveBar({ hasChanges, saving, saved, onSave, label = 'Save Changes' }: SaveBarProps) {
  return (
    <div
      className="sticky bottom-0 z-10 flex items-center justify-between px-6 py-4 border-t"
      style={{
        borderColor: hasChanges ? 'color-mix(in srgb, #10b981 30%, var(--color-border))' : 'var(--color-border)',
        background: hasChanges
          ? 'color-mix(in srgb, #10b981 4%, var(--color-surface))'
          : 'var(--color-surface)',
      }}
    >
      <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        {saved ? (
          <span className="flex items-center gap-2 text-emerald-400 font-medium">
            <Check className="w-4 h-4" /> Changes saved successfully
          </span>
        ) : hasChanges ? (
          <span className="font-medium" style={{ color: 'var(--color-text)' }}>You have unsaved changes</span>
        ) : (
          'All changes saved'
        )}
      </div>
      <button
        onClick={onSave}
        disabled={!hasChanges || saving}
        className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: hasChanges ? '#059669' : 'var(--color-btn-secondary-bg)',
          color: hasChanges ? 'white' : 'var(--color-text-muted)',
          boxShadow: hasChanges ? '0 1px 3px rgba(5, 150, 105, 0.3)' : 'none',
        }}
      >
        {saving ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Saving...
          </>
        ) : (
          <>
            <Save className="w-4 h-4" />
            {label}
          </>
        )}
      </button>
    </div>
  );
}
