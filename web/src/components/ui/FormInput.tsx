'use client';

import { forwardRef, InputHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface FormInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  icon?: LucideIcon;
}

export const FormInput = forwardRef<HTMLInputElement, FormInputProps>(
  ({ label, hint, error, icon: Icon, className = '', id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <div>
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            {label}
          </label>
        )}
        <div className="relative">
          {Icon && <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none" style={{ color: 'var(--color-ink-400)' }} />}
          <input
            ref={ref}
            id={inputId}
            className={[
              'w-full border rounded-lg text-sm transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600',
              Icon ? 'pl-10 pr-3' : 'px-3', 'py-2',
              error ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20' : '',
              props.disabled ? 'opacity-60 cursor-not-allowed' : '',
              className,
            ].filter(Boolean).join(' ')}
            style={{ borderColor: error ? undefined : 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
            {...props}
          />
        </div>
        {hint && !error && <p className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>{hint}</p>}
        {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }
);

FormInput.displayName = 'FormInput';
