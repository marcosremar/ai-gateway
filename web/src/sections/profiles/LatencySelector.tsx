'use client';

import type { Latency } from '../provider-types';
import { LATENCY_OPTIONS } from './constants';

export function LatencySelector({ value, onChange }: { value: Latency | undefined; onChange: (v: Latency) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {LATENCY_OPTIONS.map(opt => {
        const sel = value === opt.value;
        const { Icon } = opt;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
            style={{
              background: sel ? `color-mix(in srgb, ${opt.color} 10%, transparent)` : 'transparent',
              borderColor: sel ? `color-mix(in srgb, ${opt.color} 40%, transparent)` : 'var(--color-border)',
              color: sel ? opt.color : 'var(--color-text-muted)',
            }}
          >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="font-semibold">{opt.label}</span>
            <span className="opacity-60">{opt.sub}</span>
          </button>
        );
      })}
    </div>
  );
}
