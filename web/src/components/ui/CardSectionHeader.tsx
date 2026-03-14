'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

const colorMap: Record<string, { bg: string; fg: string }> = {
  emerald: { bg: 'rgba(16, 185, 129, 0.1)', fg: '#34d399' },
  blue: { bg: 'rgba(96, 165, 250, 0.1)', fg: '#60a5fa' },
  violet: { bg: 'rgba(167, 139, 250, 0.1)', fg: '#a78bfa' },
  amber: { bg: 'rgba(251, 191, 36, 0.1)', fg: '#fbbf24' },
  orange: { bg: 'rgba(251, 146, 60, 0.1)', fg: '#fb923c' },
  red: { bg: 'rgba(248, 113, 113, 0.1)', fg: '#f87171' },
  stone: { bg: 'rgba(168, 162, 158, 0.1)', fg: '#a8a29e' },
  gray: { bg: 'rgba(156, 163, 175, 0.1)', fg: '#9ca3af' },
  sky: { bg: 'rgba(56, 189, 248, 0.1)', fg: '#38bdf8' },
  teal: { bg: 'rgba(45, 212, 191, 0.1)', fg: '#2dd4bf' },
};

export function CardSectionHeader({ icon: Icon, color = 'emerald', title, subtitle, action, className = '' }: {
  icon: LucideIcon; color?: string; title: string; subtitle?: string; action?: ReactNode; className?: string;
}) {
  const c = colorMap[color] || colorMap.emerald;
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: c.bg }}>
          <Icon className="w-[18px] h-[18px]" style={{ color: c.fg }} />
        </div>
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{title}</h3>
          {subtitle && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{subtitle}</p>}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
