'use client';

interface KVProps {
  label: string;
  value: string | number;
  mono?: boolean;
  className?: string;
}

export function KV({ label, value, mono = false, className = '' }: KVProps) {
  return (
    <div className={`flex items-center justify-between py-1 ${className}`}>
      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className={`text-xs font-medium ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
