'use client';

import { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className = '', ...props }: CardProps) {
  return (
    <div
      className={`rounded-xl border overflow-hidden card-hover ${className}`}
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-surface-elevated)',
      }}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardSubProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '' }: CardSubProps) {
  return (
    <div className={`px-5 py-3.5 border-b ${className}`} style={{ borderColor: 'var(--color-border-light)' }}>
      {children}
    </div>
  );
}

export function CardBody({ children, className = '' }: CardSubProps) {
  return <div className={`p-5 ${className}`}>{children}</div>;
}

export function CardFooter({ children, className = '' }: CardSubProps) {
  return (
    <div className={`px-5 py-3.5 border-t ${className}`} style={{ borderColor: 'var(--color-border-light)', background: 'var(--color-surface)' }}>
      {children}
    </div>
  );
}
