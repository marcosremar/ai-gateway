'use client';

import { forwardRef, SelectHTMLAttributes, ReactNode } from 'react';

interface FormSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
}

export const FormSelect = forwardRef<HTMLSelectElement, FormSelectProps>(
  ({ label, hint, error, className = '', id, children, ...props }, ref) => {
    const selectId = id || props.name;
    return (
      <div>
        {label && (
          <label htmlFor={selectId} className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={[
            'w-full px-3 py-2 text-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600',
            error ? 'border-red-500' : '',
            props.disabled ? 'opacity-60 cursor-not-allowed' : '',
            className,
          ].filter(Boolean).join(' ')}
          style={{ borderRadius: 'var(--radius-md)', border: `1px solid ${error ? '#ef4444' : 'var(--color-border)'}`, background: 'var(--color-surface)', color: 'var(--color-text)' }}
          {...props}
        >
          {children}
        </select>
        {hint && !error && <p className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>{hint}</p>}
        {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }
);

FormSelect.displayName = 'FormSelect';
