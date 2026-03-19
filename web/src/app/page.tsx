'use client';

import { useState, useEffect, useCallback } from 'react';
import { GatewayProvider, useGateway } from '@/hooks/useGateway';
import { Sidebar, type SidebarItem } from '@/components/ui';
import { LayoutDashboard, Settings2, TestTube, Bot, Shield, ScrollText, Zap, KeyRound, Sparkles, FlaskConical, LayoutList, Sun, Moon } from 'lucide-react';
import { OverviewSection } from '@/sections/OverviewSection';
import { PipelineTestSection } from '@/sections/PipelineTestSection';
import { PathBenchmarkSection } from '@/sections/PathBenchmarkSection';
import { BotSection } from '@/sections/BotSection';
import { ReputationSection } from '@/sections/ReputationSection';
import { LogsSection } from '@/sections/LogsSection';
import { ApiKeysSection } from '@/sections/ApiKeysSection';
import { ProfilesSection } from '@/sections/ProfilesSection';
import { PlaygroundSection } from '@/sections/PlaygroundSection';
import { ReadinessSection } from '@/sections/ReadinessSection';

const NAV_ITEMS: SidebarItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },

  { id: '_config', label: 'Config', divider: true, icon: LayoutDashboard },
  { id: 'config/profiles', label: 'Profiles', icon: LayoutList },
  { id: 'config/api-keys', label: 'API Keys', icon: KeyRound },

  { id: '_tools', label: 'Tools', divider: true, icon: LayoutDashboard },
  { id: 'tools/playground', label: 'Playground', icon: Sparkles },
  { id: 'tools/pipeline', label: 'Pipeline Test', icon: TestTube },
  { id: 'tools/pathbench', label: 'Path Benchmark', icon: Zap },
  { id: 'tools/bot', label: 'Bot', icon: Bot },

  { id: '_monitor', label: 'Monitor', divider: true, icon: LayoutDashboard },
  { id: 'monitor/readiness', label: 'GPU Readiness', icon: FlaskConical },
  { id: 'monitor/reputation', label: 'Reputation', icon: Shield },
  { id: 'monitor/logs', label: 'Logs & Metrics', icon: ScrollText },
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
  // Redirect removed page
  if (path === 'config/providers' || path === 'config/deploy') return 'config/profiles';
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
      <main className="flex-1 overflow-auto" style={{ background: 'var(--color-bg)' }}>
        {/* Top bar */}
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

        {/* Page content */}
        <div className="max-w-6xl mx-auto" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
          {activeTab === 'overview' && <OverviewSection />}
          {activeTab === 'config/api-keys' && <ApiKeysSection />}
          {activeTab === 'config/profiles' && <ProfilesSection />}
          {activeTab === 'tools/playground' && <PlaygroundSection />}
          {activeTab === 'tools/pipeline' && <PipelineTestSection />}
          {activeTab === 'tools/pathbench' && <PathBenchmarkSection />}
          {activeTab === 'tools/bot' && <BotSection />}
          {activeTab === 'monitor/readiness' && <ReadinessSection />}
          {activeTab === 'monitor/reputation' && <ReputationSection />}
          {activeTab === 'monitor/logs' && <LogsSection />}
        </div>
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
