'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className = '' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      className={`inline-flex items-center justify-center w-6 h-6 rounded-md transition-all cursor-pointer hover:bg-[var(--color-surface-hover)] ${className}`}
      style={{ color: copied ? '#34d399' : 'var(--color-text-muted)' }}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}
