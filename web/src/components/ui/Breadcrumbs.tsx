'use client';

import { ChevronRight, Home } from 'lucide-react';

export interface BreadcrumbCrumb {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface BreadcrumbsProps {
  items: BreadcrumbCrumb[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs">
      <a
        href="/"
        onClick={(e) => { e.preventDefault(); window.history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}
        className="flex items-center cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}
        aria-label="Home"
      >
        <Home className="w-3.5 h-3.5" />
      </a>
      {items.map((c, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
            {isLast || (!c.href && !c.onClick) ? (
              <span style={{ color: 'var(--color-text)' }} aria-current={isLast ? 'page' : undefined}>{c.label}</span>
            ) : (
              <a
                href={c.href || '#'}
                onClick={(e) => {
                  if (c.onClick) {
                    e.preventDefault();
                    c.onClick();
                  } else if (c.href) {
                    e.preventDefault();
                    window.history.pushState(null, '', c.href);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }
                }}
                className="cursor-pointer hover:underline"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {c.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}
