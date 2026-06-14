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
import { staticSlugParams } from '@/lib/nav';

// Bounded static-export route list lives in `lib/nav` (#963) so the
// pre-rendered-shell surface is a single source of truth and unit-testable.
export function generateStaticParams() {
  return staticSlugParams();
}

export default function CatchAllPage() {
  return <DashboardApp />;
}
