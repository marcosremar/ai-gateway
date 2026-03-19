'use client';

type StatusVariant = 'ready' | 'online' | 'booting' | 'warning' | 'error' | 'offline' | 'idle';

interface StatusDotProps {
  status: StatusVariant;
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
}

const COLORS: Record<StatusVariant, string> = {
  ready: '#34d399',
  online: '#34d399',
  booting: '#f59e0b',
  warning: '#f59e0b',
  error: '#ef4444',
  offline: '#6b7280',
  idle: '#6b7280',
};

export function StatusDot({ status, size = 'sm', label, className = '' }: StatusDotProps) {
  const s = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  const color = COLORS[status] || COLORS.idle;

  if (label) {
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        <div className={`${s} rounded-full flex-shrink-0`} style={{ background: color }} />
        <span className="text-xs font-medium" style={{ color }}>{label}</span>
      </div>
    );
  }

  return <div className={`${s} rounded-full flex-shrink-0 ${className}`} style={{ background: color }} />;
}
