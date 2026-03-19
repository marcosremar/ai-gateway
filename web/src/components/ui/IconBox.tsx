'use client';

import type { LucideIcon } from 'lucide-react';

interface IconBoxProps {
  icon: LucideIcon;
  color?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  xs: { box: 'w-5 h-5', icon: 'w-2.5 h-2.5', radius: 'rounded' },
  sm: { box: 'w-6 h-6', icon: 'w-3 h-3', radius: 'rounded-md' },
  md: { box: 'w-8 h-8', icon: 'w-4 h-4', radius: 'rounded-lg' },
  lg: { box: 'w-10 h-10', icon: 'w-5 h-5', radius: 'rounded-xl' },
};

export function IconBox({ icon: Icon, color = 'var(--color-text-muted)', size = 'md', className = '' }: IconBoxProps) {
  const s = SIZES[size];
  return (
    <div
      className={`${s.box} ${s.radius} flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}
    >
      <Icon className={s.icon} style={{ color }} />
    </div>
  );
}
