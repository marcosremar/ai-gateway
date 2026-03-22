import type { ServicePhase } from './gateway';
import type { BadgeVariant } from '@/components/ui/StatusBadge';

export type { ServicePhase };

// ── Phase → color / bg / badge variant ───────────────────────────────────────

interface PhaseStyle {
  color: string;
  bg: string;
  variant: BadgeVariant;
}

export const PHASE_COLORS: Record<ServicePhase, PhaseStyle> = {
  idle:         { color: 'var(--color-text-muted, #71717a)', bg: 'transparent',                variant: 'gray' },
  downloading:  { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.06)', variant: 'violet' },
  loading:      { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.06)', variant: 'violet' },
  compiling:    { color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.06)',  variant: 'amber' },
  warming:      { color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.06)',  variant: 'amber' },
  benchmarking: { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.06)',  variant: 'blue' },
  shadow:       { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.06)', variant: 'violet' },
  ready:        { color: '#34d399', bg: 'rgba(52, 211, 153, 0.06)',  variant: 'emerald' },
  degraded:     { color: '#f97316', bg: 'rgba(249, 115, 22, 0.06)',  variant: 'orange' },
  repechage:    { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.06)', variant: 'amber' },
  failed:       { color: '#f87171', bg: 'rgba(248, 113, 113, 0.06)', variant: 'red' },
  condemned:    { color: '#991b1b', bg: 'rgba(248, 113, 113, 0.06)', variant: 'red' },
};

export function phaseColor(phase: ServicePhase): string {
  return PHASE_COLORS[phase]?.color ?? PHASE_COLORS.idle.color;
}

export function phaseBg(phase: ServicePhase): string {
  return PHASE_COLORS[phase]?.bg ?? PHASE_COLORS.idle.bg;
}

export function phaseVariant(phase: ServicePhase): BadgeVariant {
  return PHASE_COLORS[phase]?.variant ?? 'gray';
}

// ── Stage accent colors ──────────────────────────────────────────────────────

export const STAGE_COLORS = {
  stt: '#38bdf8',
  llm: '#a78bfa',
  tts: '#fbbf24',
} as const;

// ── Phase duration formatter ─────────────────────────────────────────────────

export function formatPhaseDuration(phaseStartedAt: number | undefined): string | null {
  if (!phaseStartedAt) return null;
  const elapsedMs = Date.now() - phaseStartedAt;
  if (elapsedMs < 0) return null;
  const s = Math.floor(elapsedMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Phase label (human-readable) ─────────────────────────────────────────────

const PHASE_LABELS: Record<ServicePhase, string> = {
  idle: 'Idle', downloading: 'Downloading', loading: 'Loading',
  compiling: 'Compiling', warming: 'Warming', benchmarking: 'Benchmarking',
  shadow: 'Shadow', ready: 'Ready', degraded: 'Degraded',
  repechage: 'Repechage', failed: 'Failed', condemned: 'Condemned',
};

export function phaseLabel(phase: ServicePhase): string {
  return PHASE_LABELS[phase] ?? phase;
}
