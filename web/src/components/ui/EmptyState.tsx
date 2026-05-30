'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function EmptyState({ icon: Icon, title, description, action, size = 'md' }: EmptyStateProps) {
  const padding = size === 'sm' ? 'p-6' : size === 'lg' ? 'p-12' : 'p-10';
  const iconSize = size === 'sm' ? 'w-8 h-8' : size === 'lg' ? 'w-12 h-12' : 'w-10 h-10';

  return (
    <div
      className={`rounded-xl border ${padding} text-center`}
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      {Icon && (
        <Icon
          className={`${iconSize} mx-auto mb-3 opacity-25`}
          style={{ color: 'var(--color-text-muted)' }}
          aria-hidden="true"
        />
      )}
      <p className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>{title}</p>
      {description && (
        <p className="text-sm mb-4" style={{ color: 'var(--color-text-muted)' }}>{description}</p>
      )}
      {action}
    </div>
  );
}
