'use client';

import type { ReactNode } from 'react';
import { AlertCircle, Info, CheckCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type AlertVariant = 'warning' | 'info' | 'error' | 'success';

interface AlertBannerProps {
  variant?: AlertVariant;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}

const variants: Record<AlertVariant, { bg: string; border: string; iconColor: string; textColor: string; DefaultIcon: LucideIcon }> = {
  warning: { bg: 'rgba(245, 158, 11, 0.06)', border: 'rgba(245, 158, 11, 0.15)', iconColor: '#fbbf24', textColor: '#fde68a', DefaultIcon: AlertCircle },
  info:    { bg: 'rgba(59, 130, 246, 0.06)', border: 'rgba(59, 130, 246, 0.15)', iconColor: '#60a5fa', textColor: '#93c5fd', DefaultIcon: Info },
  error:   { bg: 'rgba(239, 68, 68, 0.06)', border: 'rgba(239, 68, 68, 0.15)', iconColor: '#f87171', textColor: '#fca5a5', DefaultIcon: AlertCircle },
  success: { bg: 'rgba(16, 185, 129, 0.06)', border: 'rgba(16, 185, 129, 0.15)', iconColor: '#34d399', textColor: '#6ee7b7', DefaultIcon: CheckCircle },
};

export function AlertBanner({ variant = 'warning', icon, children, className = '' }: AlertBannerProps) {
  const v = variants[variant];
  const IconComp = icon || v.DefaultIcon;
  return (
    <div
      className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border ${className}`}
      style={{ background: v.bg, borderColor: v.border }}
    >
      <IconComp className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: v.iconColor }} />
      <div className="text-xs leading-relaxed" style={{ color: v.textColor }}>{children}</div>
    </div>
  );
}
