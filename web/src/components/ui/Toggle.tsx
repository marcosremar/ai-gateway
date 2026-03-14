'use client';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function Toggle({ checked, onChange, disabled = false, size = 'md' }: ToggleProps) {
  const isSm = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex items-center rounded-full border-0 cursor-pointer transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
        isSm ? 'w-8 h-[18px]' : 'w-10 h-[22px]',
      ].join(' ')}
      style={{ background: checked ? 'var(--color-btn-primary-bg)' : 'var(--color-ink-300)' }}
    >
      <span
        className={[
          'inline-block bg-white rounded-full shadow-sm transition-transform',
          isSm ? 'w-3.5 h-3.5' : 'w-[18px] h-[18px]',
          checked ? (isSm ? 'translate-x-[16px]' : 'translate-x-[20px]') : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}
