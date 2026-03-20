/**
 * Catch-all route for client-side SPA navigation.
 *
 * The dashboard uses pushState for routes like /config/profiles/edit/{id}.
 * Without this catch-all, refreshing or navigating directly to those URLs
 * returns a 404 in Next.js dev mode.
 *
 * In production (static export), the gateway's SPA fallback serves index.html
 * for unknown paths, but generateStaticParams ensures known routes get their
 * own pre-rendered HTML files too.
 */
import Home from '../page';

export function generateStaticParams() {
  return [
    { slug: ['config', 'profiles'] },
    { slug: ['config', 'profiles', 'new'] },
    { slug: ['config', 'api-keys'] },
    { slug: ['tools', 'playground'] },
    { slug: ['tools', 'bot'] },
    { slug: ['monitor', 'reputation'] },
    { slug: ['monitor', 'logs'] },
  ];
}

export default function CatchAllPage() {
  return <Home />;
}
