'use client';

import type { ReactNode } from 'react';

export function SectionHeader({ title, subtitle, action, className = '' }: { title: string; subtitle?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={`flex items-start justify-between ${className}`}>
      <div>
        <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--color-text)' }}>{title}</h2>
        {subtitle && <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
