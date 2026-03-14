'use client';

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface SidebarItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

interface SidebarProps {
  items: SidebarItem[];
  activeItem: string;
  onChange: (id: string) => void;
  health?: { status: string; uptime_sec: number } | null;
  error?: string | null;
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function Sidebar({ items, activeItem, onChange, health, error }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className="sidebar-transition flex flex-col h-screen border-r flex-shrink-0 relative"
      style={{
        width: collapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)',
        borderColor: 'var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      {/* Logo / Brand */}
      <div className="flex items-center gap-3 px-4 h-14 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-sm">AI</span>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight truncate">AI Gateway Settings</h1>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${health ? 'bg-emerald-500' : error ? 'bg-red-500' : 'bg-zinc-500'}`} />
              <span className="text-[10px] font-medium truncate" style={{ color: 'var(--color-text-muted)' }}>
                {health ? formatUptime(health.uptime_sec) : error ? 'Offline' : '...'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        <div className="space-y-0.5">
          {items.map((item) => {
            const isActive = activeItem === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                title={collapsed ? item.label : undefined}
                className={[
                  'w-full flex items-center gap-3 rounded-lg text-sm font-medium transition-all cursor-pointer',
                  collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2',
                  isActive
                    ? 'text-emerald-400'
                    : 'hover:text-[var(--color-text)]',
                ].join(' ')}
                style={{
                  color: isActive ? '#10b981' : 'var(--color-text-muted)',
                  background: isActive ? 'color-mix(in srgb, #10b981 8%, transparent)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--color-surface-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                {!collapsed && (
                  <>
                    <span className="truncate">{item.label}</span>
                    {item.badge && (
                      <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-950 text-emerald-400 border border-emerald-800">
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Collapse toggle */}
      <div className="border-t px-2 py-2 flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
