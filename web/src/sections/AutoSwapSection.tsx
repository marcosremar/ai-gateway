'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getAutoSwapStatus, toggleAutoSwap, runAutoSwapBenchmark, getHealth,
  type AutoSwapStatusResponse, type AutoSwapBenchmarkResponse, type HealthResponse,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, CardFooter, Button, Toggle,
  SectionHeader, StatusBadge, AlertBanner, KV,
} from '@/components/ui';
import { RefreshCw, Zap, Mic, Brain, Volume2, FlaskConical } from 'lucide-react';

const STAGE_META: Record<string, { label: string; icon: typeof Mic; color: string }> = {
  stt: { label: 'STT', icon: Mic,     color: '#38bdf8' },
  llm: { label: 'LLM', icon: Brain,   color: '#a78bfa' },
  tts: { label: 'TTS', icon: Volume2, color: '#34d399' },
};

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function AutoSwapSection() {
  const [status, setStatus]   = useState<AutoSwapStatusResponse | null>(null);
  const [health, setHealth]   = useState<HealthResponse | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<AutoSwapBenchmarkResponse | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([getAutoSwapStatus(), getHealth()]);
      setStatus(s);
      setHealth(h);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  async function handleToggle(enabled: boolean) {
    setToggling(true);
    try {
      const next = await toggleAutoSwap(enabled);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }

  async function handleBenchmark() {
    setBenchRunning(true);
    setBenchResult(null);
    setBenchError(null);
    try {
      const result = await runAutoSwapBenchmark({
        phrases: [
          { text: "Bonjour, comment allez-vous aujourd'hui?", expectedLang: 'fr' },
          { text: "Hello, how are you doing today?", expectedLang: 'en' },
          { text: "Buenos días, ¿cómo estás?", expectedLang: 'es' },
          { text: "Guten Morgen, wie geht es Ihnen?", expectedLang: 'de' },
          { text: "Buongiorno, come stai?", expectedLang: 'it' },
        ],
        source: 'fr',
        target: 'en',
        minConfidence: 0.7,
      });
      setBenchResult(result);
    } catch (err) {
      setBenchError(err instanceof Error ? err.message : String(err));
    } finally {
      setBenchRunning(false);
    }
  }

  const routing = health?.components;

  if (loading) return (
    <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      <div className="inline-flex items-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span>Loading auto-swap status...</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 p-6">
      <SectionHeader
        title="Auto-Swap"
        subtitle="Automatically switch the active source/target language pair when a different language is detected in speech."
      />

      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      {/* ── Status + Toggle ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, #38bdf8 15%, transparent)' }}
              >
                <Zap className="w-4 h-4" style={{ color: '#38bdf8' }} />
              </div>
              <div>
                <span className="text-sm font-semibold">Auto-Swap</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  Switch language pair mid-session on detection
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {status && (
                <StatusBadge variant={status.enabled ? 'emerald' : 'gray'} dot>
                  {status.enabled ? 'Enabled' : 'Disabled'}
                </StatusBadge>
              )}
              <Toggle
                checked={status?.enabled ?? false}
                onChange={handleToggle}
                size="md"
              />
            </div>
          </div>
        </CardHeader>
        {status && (
          <CardBody>
            <div className="text-sm leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
              {status.enabled
                ? 'When speech is detected in a language that differs from the current source language, the pipeline will automatically swap the source/target pair for that utterance.'
                : 'Auto-swap is disabled. The pipeline will always translate from the configured source language regardless of what is spoken.'}
            </div>
          </CardBody>
        )}
      </Card>

      {/* ── Current Provider Routing ── */}
      {routing && (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold">Current Provider Routing</span>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-3 gap-4">
              {(['stt', 'llm', 'tts'] as const).map(stage => {
                const meta = STAGE_META[stage];
                const Icon = meta.icon;
                const component = routing[stage];
                const provider = component?.provider ?? '—';
                const isHealthy = component?.healthy ?? false;
                return (
                  <div
                    key={stage}
                    className="flex flex-col gap-3 p-4 rounded-xl border"
                    style={{
                      background: 'var(--color-surface)',
                      borderColor: `color-mix(in srgb, ${meta.color} 30%, var(--color-border))`,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{ background: `color-mix(in srgb, ${meta.color} 15%, transparent)` }}
                      >
                        <Icon className="w-4 h-4" style={{ color: meta.color }} />
                      </div>
                      <span className="text-xs font-bold uppercase font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                        {meta.label}
                      </span>
                    </div>
                    <div>
                      <div className="font-mono text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>
                        {provider}
                      </div>
                      {component?.endpoint && (
                        <div
                          className="font-mono text-[10px] truncate mt-0.5"
                          style={{ color: 'var(--color-text-muted)' }}
                          title={component.endpoint}
                        >
                          {component.endpoint}
                        </div>
                      )}
                    </div>
                    <StatusBadge variant={isHealthy ? 'emerald' : 'gray'} dot>
                      {component?.status ?? 'unknown'}
                    </StatusBadge>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Benchmark ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, #a78bfa 15%, transparent)' }}
            >
              <FlaskConical className="w-4 h-4" style={{ color: '#a78bfa' }} />
            </div>
            <div>
              <span className="text-sm font-semibold">Language Detection Benchmark</span>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Run a short detection benchmark to evaluate swap accuracy
              </p>
            </div>
          </div>
        </CardHeader>

        {(benchResult || benchError) && (
          <CardBody>
            {benchError && <AlertBanner variant="error">{benchError}</AlertBanner>}

            {benchResult && (
              <div className="space-y-4">
                {/* Summary row */}
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: 'Accuracy',       value: fmtPct(benchResult.accuracy),          color: benchResult.accuracy >= 0.8 ? '#34d399' : '#f87171' },
                    { label: 'Avg Latency',    value: fmtMs(benchResult.avgLatencyMs),       color: 'var(--color-text)' },
                    { label: 'P95 Latency',    value: fmtMs(benchResult.p95LatencyMs),       color: 'var(--color-text)' },
                    { label: 'Swap Detections',value: String(benchResult.swapDetections),    color: 'var(--color-text)' },
                  ].map(({ label, value, color }) => (
                    <div
                      key={label}
                      className="flex flex-col gap-1 p-3 rounded-lg"
                      style={{ background: 'var(--color-surface)' }}
                    >
                      <span className="text-[10px] font-medium uppercase" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
                      <span className="text-lg font-mono font-bold" style={{ color }}>{value}</span>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-3 gap-3 text-xs">
                  <KV label="Correct" value={`${benchResult.correctCount} / ${benchResult.relevantPhrases}`} />
                  <KV label="False Positives" value={String(benchResult.falsePositives)} />
                  <KV label="False Negatives" value={String(benchResult.falseNegatives)} />
                </div>

                {/* Per-phrase results */}
                <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--color-border)' }}>
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}>
                        <th className="text-left px-3 py-2">Phrase</th>
                        <th className="text-center px-3 py-2">Expected</th>
                        <th className="text-center px-3 py-2">Detected</th>
                        <th className="text-right px-3 py-2">Conf</th>
                        <th className="text-right px-3 py-2">Latency</th>
                        <th className="text-center px-3 py-2">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benchResult.results.map((r, i) => (
                        <tr
                          key={i}
                          style={{
                            borderTop: '1px solid var(--color-border)',
                            background: i % 2 === 0 ? 'transparent' : 'var(--color-surface-elevated)',
                          }}
                        >
                          <td className="px-3 py-2 max-w-[200px] truncate" style={{ color: 'var(--color-text-secondary)' }} title={r.text}>
                            {r.text}
                          </td>
                          <td className="px-3 py-2 text-center uppercase font-bold" style={{ color: 'var(--color-text-muted)' }}>{r.expectedLang}</td>
                          <td className="px-3 py-2 text-center uppercase font-bold" style={{ color: r.correct ? '#34d399' : '#f87171' }}>{r.detectedLang}</td>
                          <td className="px-3 py-2 text-right" style={{ color: 'var(--color-text-secondary)' }}>{fmtPct(r.confidence)}</td>
                          <td className="px-3 py-2 text-right" style={{ color: 'var(--color-text-muted)' }}>{fmtMs(r.latencyMs)}</td>
                          <td className="px-3 py-2 text-center">
                            {r.correct
                              ? <span style={{ color: '#34d399' }}>✓</span>
                              : <span style={{ color: '#f87171' }}>✗</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardBody>
        )}

        <CardFooter>
          <div className="flex items-center gap-3">
            <Button onClick={handleBenchmark} isLoading={benchRunning} loadingText="Running benchmark...">
              <FlaskConical className="w-4 h-4" /> Run Benchmark
            </Button>
            <Button variant="ghost" onClick={load}>
              <RefreshCw className="w-4 h-4" /> Refresh
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
