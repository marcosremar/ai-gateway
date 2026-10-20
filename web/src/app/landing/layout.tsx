import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Gateway — Self-hosted AI Infrastructure',
  description:
    'GPU-accelerated speech translation, multi-provider routing, and production-grade reliability.',
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
