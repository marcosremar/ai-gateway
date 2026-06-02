'use client';

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight, BookOpen, Menu, X } from 'lucide-react';
import { SETTINGS_APP_MARK, SETTINGS_APP_NAME } from '@/lib/branding';

export interface SidebarItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  badge?: string;
  divider?: boolean; // renders a section separator with optional label
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Close mobile drawer on selection
  const onChangeMobile = (id: string) => {
    onChange(id);
    if (isMobile) setMobileOpen(false);
  };

  return (
    <div className="contents">
      {/* Mobile hamburger button */}
      {isMobile && !mobileOpen && (
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="fixed top-2.5 left-2.5 z-40 w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer"
          style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          <Menu className="w-4 h-4" />
        </button>
      )}

      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className="sidebar-transition flex flex-col h-screen border-r relative"
        style={{
          width: isMobile ? '260px' : (collapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)'),
          borderColor: 'var(--color-border)',
          background: 'var(--color-surface)',
          position: isMobile ? 'fixed' : 'relative',
          top: 0,
          left: isMobile ? (mobileOpen ? 0 : '-280px') : 0,
          zIndex: isMobile ? 35 : 'auto',
          transition: 'left 200ms ease',
          flexShrink: 0,
        }}
      >
      {/* Logo / Brand */}
      <div className="flex items-center gap-3 px-4 h-14 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-sm">{SETTINGS_APP_MARK}</span>
        </div>
        {isMobile && (
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="ml-auto w-7 h-7 rounded-md flex items-center justify-center cursor-pointer"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight truncate">{SETTINGS_APP_NAME}</h1>
            <div
              className="flex items-center gap-1.5"
              title={
                health
                  ? `Gateway online — uptime ${formatUptime(health.uptime_sec)} (started ${new Date(Date.now() - health.uptime_sec * 1000).toLocaleString()})`
                  : error
                    ? `Gateway offline — ${error}`
                    : 'Connecting…'
              }
            >
              <div
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${health ? 'bg-emerald-500' : error ? 'bg-red-500' : 'bg-zinc-500'}`}
                role="status"
                aria-label={health ? 'Gateway online' : error ? 'Gateway offline' : 'Connecting'}
              />
              <span className="text-[10px] font-medium truncate" style={{ color: 'var(--color-text-muted)' }}>
                {health ? `up ${formatUptime(health.uptime_sec)}` : error ? 'Offline' : '...'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2" aria-label="Main navigation">
        <div className="space-y-0.5">
          {items.map((item) => {
            if (item.divider) {
              return (
                <div key={item.id} className={collapsed ? 'py-2' : 'pt-3 pb-1'}>
                  {!collapsed && item.label && (
                    <span
                      className="px-3 text-[10px] font-semibold uppercase tracking-widest"
                      style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}
                    >
                      {item.label}
                    </span>
                  )}
                  {collapsed && (
                    <div className="mx-2 border-t" style={{ borderColor: 'var(--color-border)' }} />
                  )}
                </div>
              );
            }

            const isActive = activeItem === item.id;
            const Icon = item.icon!;
            return (
              <button
                key={item.id}
                onClick={() => onChangeMobile(item.id)}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'w-full flex items-center gap-3 rounded-lg text-sm font-medium transition-all cursor-pointer',
                  collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2',
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

      {/* Footer: version + docs */}
      <div className="border-t flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        {!collapsed && (
          <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
            <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>
              v1.0.0
            </span>
            <a
              href="https://github.com/marcosomma/ai-gateway"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] font-medium rounded-md px-1.5 py-0.5 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--color-primary)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--color-text-muted)'; }}
            >
              <BookOpen className="w-3 h-3" />
              <span>Docs</span>
            </a>
          </div>
        )}

        {/* Collapse toggle */}
        <div className="px-2 py-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            style={{ color: 'var(--color-text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </div>
    </aside>
    </div>
  );
}
