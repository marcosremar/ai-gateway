'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { GatewayProvider, useGateway } from '@/hooks/useGateway';
import { Sidebar, type SidebarItem } from '@/components/ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LayoutDashboard, Settings2, Bot, Shield, ScrollText, KeyRound, Sparkles, LayoutList, Sun, Moon, Gauge, RefreshCw, Activity, FlaskConical, Layers } from 'lucide-react';

// Critical above-the-fold section — loaded eagerly
import { OverviewSection } from '@/sections/OverviewSection';

// Lazy-load sections that aren't visible on initial page load
const LoadingPlaceholder = () => (
  <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
);

const BotSection = dynamic(
  () => import('@/sections/BotSection').then(m => ({ default: m.BotSection })),
  { loading: LoadingPlaceholder },
);
const ReputationSection = dynamic(
  () => import('@/sections/ReputationSection').then(m => ({ default: m.ReputationSection })),
  { loading: LoadingPlaceholder },
);
const LogsSection = dynamic(
  () => import('@/sections/LogsSection').then(m => ({ default: m.LogsSection })),
  { loading: LoadingPlaceholder },
);
const ApiKeysSection = dynamic(
  () => import('@/sections/ApiKeysSection').then(m => ({ default: m.ApiKeysSection })),
  { loading: LoadingPlaceholder },
);
const ProfilesSection = dynamic(
  () => import('@/sections/ProfilesSection').then(m => ({ default: m.ProfilesSection })),
  { loading: LoadingPlaceholder },
);
const PlaygroundSection = dynamic(
  () => import('@/sections/PlaygroundSection').then(m => ({ default: m.PlaygroundSection })),
  { loading: LoadingPlaceholder },
);
const ReadinessSection = dynamic(
  () => import('@/sections/ReadinessSection').then(m => ({ default: m.ReadinessSection })),
  { loading: LoadingPlaceholder },
);
const AutoSwapSection = dynamic(
  () => import('@/sections/AutoSwapSection').then(m => ({ default: m.AutoSwapSection })),
  { loading: LoadingPlaceholder },
);
const StandbySection = dynamic(
  () => import('@/sections/StandbySection').then(m => ({ default: m.StandbySection })),
  { loading: LoadingPlaceholder },
);
const LatencySection = dynamic(
  () => import('@/sections/LatencySection').then(m => ({ default: m.LatencySection })),
  { loading: LoadingPlaceholder },
);
const LabsSection = dynamic(
  () => import('@/sections/LabsSection').then(m => ({ default: m.LabsSection })),
  { loading: LoadingPlaceholder },
);
const VastServerlessSection = dynamic(
  () => import('@/sections/VastServerlessSection').then(m => ({ default: m.VastServerlessSection })),
  { loading: LoadingPlaceholder },
);

const NAV_ITEMS: SidebarItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },

  { id: '_config', label: 'Config', divider: true, icon: LayoutDashboard },
  { id: 'config/profiles', label: 'Profiles', icon: LayoutList },
  { id: 'config/api-keys', label: 'API Keys', icon: KeyRound },
  { id: 'config/labs', label: 'Labs', icon: FlaskConical },
  { id: 'config/vast-serverless', label: 'Vast Serverless', icon: Layers },

  { id: '_tools', label: 'Tools', divider: true, icon: LayoutDashboard },
  { id: 'tools/playground', label: 'Playground', icon: Sparkles },
  { id: 'tools/bot', label: 'Bot', icon: Bot },
  { id: 'tools/auto-swap', label: 'Auto-Swap', icon: RefreshCw },
  { id: 'tools/standby', label: 'GPU Standby', icon: Moon },

  { id: '_monitor', label: 'Monitor', divider: true, icon: LayoutDashboard },
  { id: 'monitor/latency', label: 'Latency', icon: Activity },
  { id: 'monitor/reputation', label: 'Reputation', icon: Shield },
  { id: 'monitor/logs', label: 'Logs & Metrics', icon: ScrollText },
  { id: 'monitor/readiness', label: 'Readiness', icon: Gauge },
];

const VALID_ROUTES = new Set(NAV_ITEMS.filter(item => !item.divider).map(item => item.id));

function getRouteFromPath(): string {
  if (typeof window === 'undefined') return 'overview';
  // Support hash navigation: /#/config/providers
  const hash = window.location.hash.replace('#/', '').replace('#', '');
  if (hash && VALID_ROUTES.has(hash)) return hash;
  // Pathname: /config/providers or sub-routes like /config/profiles/edit/xxx
  const path = window.location.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (VALID_ROUTES.has(path)) return path;
  // Redirect removed pages
  if (path === 'config/providers' || path === 'config/deploy') return 'config/profiles';
  if (path === 'tools/pipeline') return 'tools/playground';
  if (path === 'tools/pathbench') return 'config/profiles';
  // Match sub-routes: /config/profiles/edit/xxx → config/profiles
  for (const route of VALID_ROUTES) {
    if (path.startsWith(route + '/')) return route;
  }
  return 'overview';
}

function useTheme() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') { document.documentElement.classList.add('light'); setLight(true); }
  }, []);
  const toggle = useCallback(() => {
    setLight(prev => {
      const next = !prev;
      document.documentElement.classList.toggle('light', next);
      localStorage.setItem('theme', next ? 'light' : 'dark');
      return next;
    });
  }, []);
  return { light, toggle };
}

function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const { health, error } = useGateway();
  const { light, toggle: toggleTheme } = useTheme();

  // Sync tab with URL on mount and popstate
  useEffect(() => {
    setActiveTab(getRouteFromPath());

    const onNav = () => setActiveTab(getRouteFromPath());
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
    };
  }, []);

  // Navigate: pushState with clean nested URL
  const navigate = useCallback((id: string) => {
    const url = id === 'overview' ? '/' : `/${id}`;
    window.history.pushState(null, '', url);
    setActiveTab(id);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        items={NAV_ITEMS}
        activeItem={activeTab}
        onChange={navigate}
        health={health}
        error={error}
      />

      {/* Main content */}
      <main className={`flex-1 ${activeTab === 'config/profiles' ? 'overflow-hidden flex flex-col' : 'overflow-auto'}`} style={{ background: 'var(--color-bg)' }}>
        {/* Top bar — hidden for profiles (has its own breadcrumb bar) */}
        {activeTab !== 'config/profiles' && (
          <div
            className="sticky top-0 z-10 flex items-center justify-between px-6 h-14 border-b backdrop-blur-sm"
            style={{
              borderColor: 'var(--color-border)',
              background: 'color-mix(in srgb, var(--color-bg) 80%, transparent)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                {NAV_ITEMS.find(t => t.id === activeTab)?.label}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={toggleTheme}
                className="flex items-center justify-center w-8 h-8 rounded-lg border cursor-pointer transition-colors"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'var(--color-surface-elevated)',
                  color: 'var(--color-text-muted)',
                }}
                title={light ? 'Switch to dark' : 'Switch to light'}
              >
                {light ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
              </button>
              <div className={`w-2 h-2 rounded-full ${health ? 'bg-emerald-500' : error ? 'bg-red-500' : 'bg-zinc-500'}`} />
              <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                {health ? `${health.status}` : error ? 'Offline' : 'Connecting...'}
              </span>
            </div>
          </div>
        )}

        {/* Profiles — full width, no max-w constraint, own top bar */}
        {activeTab === 'config/profiles' && <ErrorBoundary><div className="flex-1 min-h-0 flex flex-col"><ProfilesSection /></div></ErrorBoundary>}

        {/* Page content */}
        {activeTab !== 'config/profiles' && <div className="max-w-6xl mx-auto" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
          {activeTab === 'overview' && <ErrorBoundary><OverviewSection /></ErrorBoundary>}
          {activeTab === 'config/api-keys' && <ErrorBoundary><ApiKeysSection /></ErrorBoundary>}
          {activeTab === 'config/labs' && <ErrorBoundary><LabsSection /></ErrorBoundary>}
          {activeTab === 'config/vast-serverless' && <ErrorBoundary><VastServerlessSection /></ErrorBoundary>}
          {activeTab === 'tools/playground' && <ErrorBoundary><PlaygroundSection /></ErrorBoundary>}
          {activeTab === 'tools/bot' && <ErrorBoundary><BotSection /></ErrorBoundary>}
          {activeTab === 'monitor/latency' && <ErrorBoundary><LatencySection /></ErrorBoundary>}
          {activeTab === 'monitor/reputation' && <ErrorBoundary><ReputationSection /></ErrorBoundary>}
          {activeTab === 'monitor/logs' && <ErrorBoundary><LogsSection /></ErrorBoundary>}
          {activeTab === 'monitor/readiness' && <ErrorBoundary><ReadinessSection /></ErrorBoundary>}
          {activeTab === 'tools/auto-swap' && <ErrorBoundary><AutoSwapSection /></ErrorBoundary>}
          {activeTab === 'tools/standby' && <ErrorBoundary><StandbySection /></ErrorBoundary>}
        </div>}
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <GatewayProvider>
      <Dashboard />
    </GatewayProvider>
  );
}
