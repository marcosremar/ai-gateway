'use client';

import { ButtonHTMLAttributes, forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  loadingText?: string;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--color-btn-primary-bg)] text-white hover:bg-[var(--color-btn-primary-hover)] disabled:hover:bg-[var(--color-btn-primary-bg)] shadow-sm',
  secondary: 'bg-[var(--color-btn-secondary-bg)] text-[var(--color-btn-secondary-text)] hover:bg-[var(--color-btn-secondary-bg-hover)]',
  outline: 'border border-[var(--color-btn-outline-border)] text-[var(--color-btn-outline-text)] bg-transparent hover:bg-[var(--color-btn-outline-bg-hover)] hover:border-[#3f3f46]',
  ghost: 'text-[var(--color-btn-ghost-text)] bg-transparent hover:bg-[var(--color-btn-ghost-bg-hover)]',
  danger: 'border border-red-900 text-red-400 bg-transparent hover:bg-red-950/50 hover:border-red-800',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', isLoading = false, loadingText = 'Loading...', fullWidth = false, disabled, className = '', children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      className={[sizeStyles[size], variantStyles[variant], fullWidth ? 'w-full' : '', 'rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)]', className].filter(Boolean).join(' ')}
      {...props}
    >
      {isLoading ? (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{loadingText}</span>
        </>
      ) : children}
    </button>
  )
);

Button.displayName = 'Button';
