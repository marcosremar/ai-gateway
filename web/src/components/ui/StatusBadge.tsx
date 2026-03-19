'use client';

import type { ReactNode } from 'react';

type BadgeVariant = 'emerald' | 'red' | 'amber' | 'orange' | 'blue' | 'violet' | 'gray';

interface StatusBadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

const styles: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
  emerald: { bg: 'rgba(16, 185, 129, 0.1)', text: '#34d399', dot: '#10b981' },
  red: { bg: 'rgba(248, 113, 113, 0.1)', text: '#f87171', dot: '#ef4444' },
  amber: { bg: 'rgba(251, 191, 36, 0.1)', text: '#fbbf24', dot: '#f59e0b' },
  orange: { bg: 'rgba(249, 115, 22, 0.1)', text: '#f97316', dot: '#ea580c' },
  blue: { bg: 'rgba(96, 165, 250, 0.1)', text: '#60a5fa', dot: '#3b82f6' },
  violet: { bg: 'rgba(167, 139, 250, 0.1)', text: '#a78bfa', dot: '#8b5cf6' },
  gray: { bg: 'rgba(161, 161, 170, 0.08)', text: '#a1a1aa', dot: '#71717a' },
};

export function StatusBadge({ variant = 'emerald', children, className = '', dot = false }: StatusBadgeProps) {
  const s = styles[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider ${className}`}
      style={{ background: s.bg, color: s.text }}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.dot }} />}
      {children}
    </span>
  );
}
