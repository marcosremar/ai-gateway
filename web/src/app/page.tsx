'use client';

import { useState, useEffect, useCallback } from 'react';
import { GatewayProvider, useGateway } from '@/hooks/useGateway';
import { Sidebar, type SidebarItem } from '@/components/ui';
import { LayoutDashboard, Settings2, Cpu, TestTube, Bot, Shield, ScrollText, Zap, KeyRound, Sparkles } from 'lucide-react';
import { OverviewSection } from '@/sections/OverviewSection';
import { ProvidersSection } from '@/sections/ProvidersSection';
import { GpuDeploySection } from '@/sections/GpuDeploySection';
import { PipelineTestSection } from '@/sections/PipelineTestSection';
import { PathBenchmarkSection } from '@/sections/PathBenchmarkSection';
import { BotSection } from '@/sections/BotSection';
import { ReputationSection } from '@/sections/ReputationSection';
import { LogsSection } from '@/sections/LogsSection';
import { ApiKeysSection } from '@/sections/ApiKeysSection';
import { PlaygroundSection } from '@/sections/PlaygroundSection';

const NAV_ITEMS: SidebarItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'api-keys', label: 'API Keys', icon: KeyRound },
  { id: 'providers', label: 'Providers', icon: Settings2 },
  { id: 'gpu', label: 'GPU Deploy', icon: Cpu },
  { id: 'playground', label: 'Playground', icon: Sparkles },
  { id: 'pipeline', label: 'Pipeline Test', icon: TestTube },
  { id: 'pathbench', label: 'Path Benchmark', icon: Zap },
  { id: 'bot', label: 'Bot', icon: Bot },
  { id: 'reputation', label: 'Reputation', icon: Shield },
  { id: 'logs', label: 'Logs & Metrics', icon: ScrollText },
];

const VALID_ROUTES = new Set(NAV_ITEMS.map(item => item.id));

function getRouteFromPath(): string {
  if (typeof window === 'undefined') return 'overview';
  // Support both /providers and /#/providers (backwards compat)
  const hash = window.location.hash.replace('#/', '').replace('#', '');
  if (hash && VALID_ROUTES.has(hash)) return hash;
  const path = window.location.pathname.replace(/^\//, '').replace(/\/$/, '');
  return VALID_ROUTES.has(path) ? path : 'overview';
}

function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const { health, error } = useGateway();

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

  // Navigate: pushState with clean URL
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
            <div className={`w-2 h-2 rounded-full ${health ? 'bg-emerald-500' : error ? 'bg-red-500' : 'bg-zinc-500'}`} />
            <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
              {health ? `${health.status}` : error ? 'Offline' : 'Connecting...'}
            </span>
          </div>
        </div>

        {/* Page content */}
        <div className="max-w-6xl mx-auto">
          {activeTab === 'overview' && <OverviewSection />}
          {activeTab === 'api-keys' && <ApiKeysSection />}
          {activeTab === 'providers' && <ProvidersSection />}
          {activeTab === 'gpu' && <GpuDeploySection />}
          {activeTab === 'playground' && <PlaygroundSection />}
          {activeTab === 'pipeline' && <PipelineTestSection />}
          {activeTab === 'pathbench' && <PathBenchmarkSection />}
          {activeTab === 'bot' && <BotSection />}
          {activeTab === 'reputation' && <ReputationSection />}
          {activeTab === 'logs' && <LogsSection />}
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
