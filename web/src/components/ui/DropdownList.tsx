'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ── Types ──

export interface DropdownOption {
  key: string;
  label: string;
  subtitle?: string;
  icon?: LucideIcon;
  iconColor?: string;
  group?: string;
}

export interface DropdownListProps {
  options: DropdownOption[];
  value: string;
  onChange: (key: string) => void;
  accent?: string;
  placeholder?: string;
  size?: 'sm' | 'md';
  className?: string;
  onClose?: () => void;
  autoOpen?: boolean;
}

// ── Component ──

export function DropdownList({
  options, value, onChange, accent = '#10b981', placeholder = 'Select...', size = 'md', className = '',
  onClose, autoOpen = false,
}: DropdownListProps) {
  const [open, setOpen] = useState(autoOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const close = useCallback(() => { setOpen(false); onClose?.(); }, [onClose]);

  // Compute position when opening — flip above trigger if not enough space below
  const MAX_PANEL_H = 256; // matches max-h-64 (16rem = 256px)
  useEffect(() => {
    if (!open || !triggerRef.current) return;

    const computePos = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      // Open above if not enough space below but enough above
      const openAbove = spaceBelow < MAX_PANEL_H && spaceAbove > spaceBelow;
      setPos({
        top: openAbove ? rect.top - Math.min(MAX_PANEL_H, spaceAbove) - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };

    computePos();
    window.addEventListener('scroll', computePos, true);
    window.addEventListener('resize', computePos);
    return () => {
      window.removeEventListener('scroll', computePos, true);
      window.removeEventListener('resize', computePos);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, close]);

  const selected = options.find(o => o.key === value);
  const groups = buildGroups(options);
  const py = size === 'sm' ? 'py-1.5' : 'py-2';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  return (
    <div className={className}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { if (open) close(); else setOpen(true); }}
        className={`w-full flex items-center gap-2 px-3 ${py} rounded-xl border cursor-pointer transition-colors ${textSize}`}
        style={{
          borderColor: open ? accent : 'var(--color-border)',
          background: 'var(--color-surface-elevated)',
          color: 'var(--color-text)',
        }}
      >
        {selected?.icon && (() => {
          const Icon = selected.icon;
          return (
            <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
              style={{ background: `color-mix(in srgb, ${selected.iconColor || accent} 15%, transparent)` }}>
              <Icon className="w-3 h-3" style={{ color: selected.iconColor || accent }} />
            </div>
          );
        })()}
        <span className="flex-1 text-left truncate font-medium">
          {selected?.label || placeholder}
        </span>
        {selected?.subtitle && (
          <span className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>
            {selected.subtitle}
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--color-text-muted)' }}
        />
      </button>

      {/* Portal dropdown — renders at body level, above everything */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          className="fixed rounded-xl border p-1.5 max-h-64 overflow-y-auto"
          style={{
            top: pos.top,
            left: pos.left,
            width: pos.width,
            zIndex: 9999,
            borderColor: `color-mix(in srgb, ${accent} 40%, var(--color-border))`,
            background: 'var(--color-surface)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}
        >
          {groups.map(({ label: groupLabel, items }) => (
            <div key={groupLabel || '__ungrouped'} className="mb-1 last:mb-0">
              {groupLabel && (
                <div className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--color-text-muted)' }}>
                  {groupLabel}
                </div>
              )}
              <div className="space-y-0.5">
                {items.map(opt => {
                  const isSelected = opt.key === value;
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => { onChange(opt.key); close(); }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer"
                      style={{
                        background: isSelected ? `color-mix(in srgb, ${accent} 12%, transparent)` : 'transparent',
                      }}
                      onMouseEnter={e => {
                        if (!isSelected) e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-muted) 8%, transparent)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = isSelected ? `color-mix(in srgb, ${accent} 12%, transparent)` : 'transparent';
                      }}
                    >
                      {Icon && (
                        <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
                          style={{ background: `color-mix(in srgb, ${opt.iconColor || accent} 15%, transparent)` }}>
                          <Icon className="w-3 h-3" style={{ color: opt.iconColor || accent }} />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium" style={{ color: isSelected ? accent : 'var(--color-text)' }}>
                          {opt.label}
                        </span>
                        {opt.subtitle && (
                          <span className="text-[10px] ml-1.5" style={{ color: 'var(--color-text-muted)' }}>
                            {opt.subtitle}
                          </span>
                        )}
                      </div>
                      {isSelected && (
                        <span className="text-[10px] font-semibold flex-shrink-0" style={{ color: accent }}>&#10003;</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Helpers ──

function buildGroups(options: DropdownOption[]): { label: string; items: DropdownOption[] }[] {
  const map = new Map<string, DropdownOption[]>();
  for (const o of options) {
    const g = o.group || '';
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(o);
  }
  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
}
