'use client';

interface SkeletonProps {
  className?: string;
  width?: string;
  height?: string;
}

export function Skeleton({ className = '', width, height }: SkeletonProps) {
  return (
    <div
      className={`rounded-lg animate-pulse ${className}`}
      style={{
        background: 'var(--color-surface-hover)',
        width: width || '100%',
        height: height || '1rem',
      }}
    />
  );
}

export function SkeletonCard() {
  return (
    <div
      className="rounded-xl border p-5 space-y-3"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
    >
      <div className="flex items-center gap-3">
        <Skeleton width="2rem" height="2rem" className="rounded-lg" />
        <Skeleton width="40%" height="0.875rem" />
      </div>
      <Skeleton height="0.75rem" />
      <Skeleton width="65%" height="0.75rem" />
    </div>
  );
}
