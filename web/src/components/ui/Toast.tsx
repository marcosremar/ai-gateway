'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

type ToastVariant = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none" style={{ maxWidth: '380px' }}>
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const icons: Record<ToastVariant, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
};

const colors: Record<ToastVariant, { bg: string; border: string; icon: string; text: string }> = {
  success: { bg: 'color-mix(in srgb, #10b981 8%, var(--color-surface-elevated))', border: 'color-mix(in srgb, #10b981 25%, var(--color-border))', icon: '#34d399', text: '#6ee7b7' },
  error: { bg: 'color-mix(in srgb, #ef4444 8%, var(--color-surface-elevated))', border: 'color-mix(in srgb, #ef4444 25%, var(--color-border))', icon: '#f87171', text: '#fca5a5' },
  info: { bg: 'color-mix(in srgb, #3b82f6 8%, var(--color-surface-elevated))', border: 'color-mix(in srgb, #3b82f6 25%, var(--color-border))', icon: '#60a5fa', text: '#93c5fd' },
};

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const Icon = icons[toast.variant];
  const c = colors[toast.variant];
  return (
    <div
      className="pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-lg animate-slide-in"
      style={{ background: c.bg, borderColor: c.border }}
      role="alert"
    >
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: c.icon }} />
      <span className="text-sm flex-1" style={{ color: c.text }}>{toast.message}</span>
      <button
        onClick={onClose}
        className="flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
        style={{ color: 'var(--color-text-muted)' }}
        aria-label="Close notification"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
