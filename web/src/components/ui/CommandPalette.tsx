'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface CommandItem {
  id: string;
  label: string;
  group?: string;
  icon?: LucideIcon;
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  items: CommandItem[];
}

export function CommandPalette({ open, onClose, onSelect, items }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it => {
      const hay = [it.label, it.group ?? '', ...(it.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[active];
      if (it) { onSelect(it.id); onClose(); }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="rounded-xl border w-full max-w-lg shadow-2xl overflow-hidden"
        style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <Search className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search sections, settings…"
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--color-text)' }}
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded border" style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}>Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            filtered.map((it, idx) => {
              const Icon = it.icon;
              const isActive = idx === active;
              return (
                <button
                  key={it.id}
                  onClick={() => { onSelect(it.id); onClose(); }}
                  onMouseEnter={() => setActive(idx)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm cursor-pointer"
                  style={{
                    background: isActive ? 'color-mix(in srgb, var(--color-primary) 12%, transparent)' : 'transparent',
                    color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)',
                  }}
                >
                  {Icon && <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.group && (
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                      {it.group}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="px-3 py-2 border-t flex items-center gap-3 text-[10px]" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--color-border)' }}>↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--color-border)' }}>↵</kbd> select</span>
          <span className="ml-auto"><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--color-border)' }}>⌘K</kbd> open</span>
        </div>
      </div>
    </div>
  );
}
