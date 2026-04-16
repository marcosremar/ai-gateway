/**
 * Catch-all route for client-side SPA navigation.
 *
 * The dashboard uses pushState for routes like /config/apps/edit/{id}.
 * Without this catch-all, refreshing or navigating directly to those URLs
 * returns a 404 in Next.js dev mode.
 *
 * In production (static export), the gateway's SPA fallback serves index.html
 * for unknown paths, but generateStaticParams ensures known routes get their
 * own pre-rendered HTML files too.
 */
import { DashboardApp } from '../page';

export function generateStaticParams() {
  return [
    // Dashboard root
    { slug: ['dashboard'] },
    // Config
    { slug: ['config', 'services'] },
    { slug: ['config', 'apps'] },
    { slug: ['config', 'apps', 'new'] },
    { slug: ['config', 'guardrails'] },
    { slug: ['config', 'api-keys'] },
    { slug: ['config', 'labs'] },
    { slug: ['config', 'vast-serverless'] },
    // Legacy compat
    { slug: ['config', 'profiles'] },
    { slug: ['config', 'profiles', 'new'] },
    // Tools
    { slug: ['tools', 'playground'] },
    { slug: ['tools', 'bot'] },
    { slug: ['tools', 'auto-swap'] },
    { slug: ['tools', 'standby'] },
    // Monitor
    { slug: ['monitor', 'latency'] },
    { slug: ['monitor', 'reputation'] },
    { slug: ['monitor', 'logs'] },
    { slug: ['monitor', 'readiness'] },
  ];
}

export default function CatchAllPage() {
  return <DashboardApp />;
}
