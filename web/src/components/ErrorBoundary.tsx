'use client';
import React from 'react';

interface Props { children: React.ReactNode; fallback?: React.ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex flex-col items-center justify-center p-12 gap-3">
          <div className="text-sm font-semibold" style={{ color: '#ef4444' }}>Something went wrong</div>
          <div className="text-xs font-mono max-w-md text-center" style={{ color: 'var(--color-text-muted)' }}>
            {this.state.error?.message}
          </div>
          <button onClick={() => this.setState({ hasError: false, error: null })}
            className="px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
