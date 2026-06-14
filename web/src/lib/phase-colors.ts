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
//
// Single source of truth for STT/LLM/TTS (+ image/pipeline) accent colors.
// Previously three divergent palettes existed (#926): `phase-colors.STAGE_COLORS`,
// `LogsSection.stageBgColor` (#38bdf8/#a78bfa/#fbbf24) and `ServicesSection`
// (#0ea5e9/#8b5cf6/#f59e0b). Both sections now consume the helpers below so a
// stage looks identical on every page.

export const STAGE_COLORS = {
  stt: '#38bdf8',
  llm: '#a78bfa',
  tts: '#fbbf24',
} as const;

/** Extended accent map including non-pipeline-stage badges (image, pipeline). */
const STAGE_ACCENT_MAP: Record<string, string> = {
  stt: STAGE_COLORS.stt,
  llm: STAGE_COLORS.llm,
  tts: STAGE_COLORS.tts,
  image: '#34d399',
  pipeline: '#34d399',
};

const STAGE_MUTED = 'var(--color-text-muted)';

/** Accent color for a stage id; muted fallback for unknown stages. Pure. */
export function stageColor(stage: string): string {
  return STAGE_ACCENT_MAP[stage] ?? STAGE_MUTED;
}

/** `StatusBadge` variant for a stage id. Pure. */
export function stageBadgeVariant(stage: string): BadgeVariant {
  switch (stage) {
    case 'stt': return 'blue';
    case 'llm': return 'violet';
    case 'tts': return 'amber';
    case 'image':
    case 'pipeline': return 'emerald';
    default: return 'gray';
  }
}

const STAGE_SHORT_LABELS: Record<string, string> = {
  stt: 'STT', llm: 'LLM', tts: 'TTS', image: 'IMG', pipeline: 'PIPE',
};

/** Short uppercase label for a stage id (falls back to `stage.toUpperCase()`). Pure. */
export function stageLabel(stage: string): string {
  return STAGE_SHORT_LABELS[stage] ?? stage.toUpperCase();
}

// ── Provider phase (PipelineHealthCard) → dot color / short label ─────────────
//
// PipelineHealthCard tracks a *provider* phase distinct from the deploy/service
// `ServicePhase` above (#924). Centralized here so the two label/color maps don't
// drift across edits.

export type ProviderPhase =
  | 'active' | 'ok' | 'benchmarking' | 'ready'
  | 'degraded' | 'repechage' | 'error' | 'idle';

const PROVIDER_PHASE_COLORS: Record<ProviderPhase, string> = {
  active: '#10b981', ok: '#10b981', ready: '#10b981',
  benchmarking: '#fbbf24', degraded: '#f97316', repechage: '#a78bfa',
  error: '#ef4444', idle: '#52525b',
};

const PROVIDER_PHASE_LABELS: Record<ProviderPhase, string> = {
  active: 'active', ok: 'ok', ready: 'ready', benchmarking: 'bench…',
  degraded: 'degraded', repechage: 'retry', error: 'error', idle: 'idle',
};

/** Status-dot color for a provider phase; falls back to the idle gray. Pure. */
export function providerPhaseColor(phase: ProviderPhase): string {
  return PROVIDER_PHASE_COLORS[phase] ?? PROVIDER_PHASE_COLORS.idle;
}

/** Short human label for a provider phase. Pure. */
export function providerPhaseLabel(phase: ProviderPhase): string {
  return PROVIDER_PHASE_LABELS[phase] ?? 'idle';
}

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
