'use client';

import { useState } from 'react';
import {
  benchmarkPaths,
  type BenchmarkPathsResponse,
  type ProviderBenchResult,
  type StageBenchResult,
  type PipelineIteration,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, CardFooter,
  Button, FormSelect, FormInput, AlertBanner, CardSectionHeader, Toggle,
} from '@/components/ui';
import { Zap, Play, Trophy, Cpu, Cloud, ArrowRight, TrendingDown, Activity } from 'lucide-react';

const STAGES = [
  { id: 'stt' as const, label: 'STT', desc: 'Speech-to-Text' },
  { id: 'llm' as const, label: 'LLM', desc: 'Translation' },
  { id: 'tts' as const, label: 'TTS', desc: 'Text-to-Speech' },
];

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
];

const PROVIDER_COLORS: Record<string, string> = {
  gpu: '#34d399', groq: '#60a5fa', ollama: '#a78bfa', openai: '#fbbf24', cache: '#9ca3af',
};

function ProviderBadge({ name, best }: { name: string; best?: boolean }) {
  const c = PROVIDER_COLORS[name] || '#9ca3af';
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: `${c}20`, color: c, border: best ? `1px solid ${c}` : '1px solid transparent' }}>
      {name === 'gpu' ? <Cpu className="w-3 h-3" /> : <Cloud className="w-3 h-3" />}
      {name}{best && <Trophy className="w-3 h-3" />}
    </span>
  );
}

function LatencyBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color = value < max * 0.4 ? '#34d399' : value < max * 0.7 ? '#fbbf24' : '#f87171';
  return (
    <div className="flex items-center gap-2 min-w-[160px]">
      <div className="flex-1 h-2 rounded-full" style={{ background: 'var(--color-ink-300)' }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-mono w-14 text-right">{value}ms</span>
    </div>
  );
}

function StageCard({ stage, data, maxLatency }: { stage: typeof STAGES[0]; data: StageBenchResult; maxLatency: number }) {
  return (
    <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-surface)' }}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{stage.label}</div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{stage.desc}</div>
        </div>
        {data.recommendation && <ProviderBadge name={data.recommendation} best />}
      </div>
      <div className="space-y-2">
        {(Object.entries(data.providers) as [string, ProviderBenchResult][]).map(([name, r]) => (
          <div key={name} className="flex items-center gap-3">
            <div className="w-16"><ProviderBadge name={name} /></div>
            {r.available && r.latencies.length > 0 ? (
              <>
                <LatencyBar value={r.avg} max={maxLatency} />
                <div className="flex gap-3 text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                  <span>p95={r.p95}</span><span>min={r.min}</span>
                  {r.errors > 0 && <span style={{ color: '#f87171' }}>err={r.errors}</span>}
                </div>
              </>
            ) : (
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {!r.available ? 'unavailable' : r.errors > 0 ? `failed (${r.errorMessages?.[0]?.slice(0, 40) || '?'})` : 'no data'}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressionRow({ it, maxMs }: { it: PipelineIteration; maxMs: number }) {
  const pct = maxMs > 0 ? Math.min((it.totalMs / maxMs) * 100, 100) : 0;
  const color = it.error ? '#f87171' : it.usedGpu ? '#34d399' : '#60a5fa';
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-6 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>{it.index + 1}</span>
      <div className="flex-1 h-3 rounded-full relative" style={{ background: 'var(--color-ink-300)' }}>
        <div className="h-3 rounded-full transition-all" style={{ width: `${pct}%`, background: color, opacity: 0.7 }} />
        {/* Stage segments */}
        {!it.error && it.totalMs > 0 && (
          <div className="absolute inset-0 flex rounded-full overflow-hidden">
            <div style={{ width: `${(it.sttMs / it.totalMs) * pct}%`, background: '#fbbf24', opacity: 0.8 }} title={`STT ${it.sttMs}ms`} />
            <div style={{ width: `${(it.llmMs / it.totalMs) * pct}%`, background: '#a78bfa', opacity: 0.8 }} title={`LLM ${it.llmMs}ms`} />
            <div style={{ width: `${(it.ttsMs / it.totalMs) * pct}%`, background: '#34d399', opacity: 0.8 }} title={`TTS ${it.ttsMs}ms`} />
          </div>
        )}
      </div>
      <span className="w-14 text-right font-mono font-medium" style={{ color }}>{it.totalMs}ms</span>
      <span className="w-10 text-center">{it.error ? '❌' : it.usedGpu ? '🖥' : '☁️'}</span>
    </div>
  );
}

export function PathBenchmarkSection() {
  const [srcLang, setSrcLang] = useState('fr');
  const [tgtLang, setTgtLang] = useState('en');
  const [iterations, setIterations] = useState(3);
  const [pipelineIts, setPipelineIts] = useState(5);
  const [includeGpu, setIncludeGpu] = useState(true);
  const [includeCloud, setIncludeCloud] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BenchmarkPathsResponse | null>(null);

  async function handleRun() {
    setRunning(true); setError(null); setReport(null);
    try {
      const result = await benchmarkPaths({
        iterations, pipelineIterations: pipelineIts, warmupIterations: 2,
        source: srcLang, target: tgtLang, includeGpu, includeCloud,
      });
      setReport(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Benchmark failed'); }
    finally { setRunning(false); }
  }

  let maxLatency = 0;
  if (report) {
    for (const stage of Object.values(report.stages)) {
      if (!stage) continue;
      for (const provider of Object.values(stage.providers)) {
        if (provider && provider.avg > maxLatency) maxLatency = provider.avg;
      }
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Config */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Zap} color="amber" title="Full Path Benchmark"
            subtitle="Provider comparison + pipeline progression + recommendation" />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <FormSelect label="Source" value={srcLang} onChange={e => setSrcLang(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <FormSelect label="Target" value={tgtLang} onChange={e => setTgtLang(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <FormInput label="Per-stage iters" type="number" value={String(iterations)}
              onChange={e => setIterations(Math.max(1, Math.min(20, parseInt(e.target.value) || 3)))} />
            <FormInput label="Pipeline iters" type="number" value={String(pipelineIts)}
              onChange={e => setPipelineIts(Math.max(0, Math.min(30, parseInt(e.target.value) || 5)))} />
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Toggle checked={includeGpu} onChange={setIncludeGpu} />
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>GPU</span>
              </div>
              <div className="flex items-center gap-2">
                <Toggle checked={includeCloud} onChange={setIncludeCloud} />
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>Cloud</span>
              </div>
            </div>
          </div>
          {error && <AlertBanner variant="error">{error}</AlertBanner>}
          {report?.notes && report.notes.length > 0 && (
            <AlertBanner variant="warning">{report.notes.join(' | ')}</AlertBanner>
          )}
        </CardBody>
        <CardFooter>
          <Button onClick={handleRun} isLoading={running} loadingText="Running full benchmark...">
            <Play className="w-4 h-4" /> Run Full Benchmark
          </Button>
          {report && <span className="text-xs font-mono ml-3" style={{ color: 'var(--color-text-muted)' }}>Done in {report.durationMs}ms</span>}
        </CardFooter>
      </Card>

      {report && (
        <>
          {/* Recommendation */}
          <Card>
            <CardHeader>
              <CardSectionHeader icon={Trophy} color="emerald" title="Recommendation" subtitle={report.recommendation.path} />
            </CardHeader>
            <CardBody>
              <div className="flex flex-col md:flex-row items-start md:items-center gap-4">
                <div className="flex items-center gap-2">
                  {(['stt', 'llm', 'tts'] as const).map((stage, i) => {
                    const p = report.recommendation.routing[stage];
                    return p ? (
                      <div key={stage} className="flex items-center gap-2">
                        {i > 0 && <ArrowRight className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />}
                        <div className="text-center">
                          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>{stage.toUpperCase()}</div>
                          <ProviderBadge name={p} best />
                        </div>
                      </div>
                    ) : null;
                  })}
                </div>
                <div className="flex-1 ml-4">
                  <div className="text-2xl font-bold font-mono" style={{ color: '#34d399' }}>{report.recommendation.estimatedTotalMs}ms</div>
                  <div className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>{report.recommendation.reason}</div>
                </div>
              </div>
              {Object.keys(report.paths).length > 1 && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                  {Object.entries(report.paths).sort(([, a], [, b]) => a.totalAvg - b.totalAvg).map(([name, path]) => {
                    const best = name === report.recommendation.path;
                    return (
                      <div key={name} className="p-3 rounded-xl" style={{ background: 'var(--color-surface)', border: best ? '1px solid #34d399' : '1px solid var(--color-border)' }}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{name}</span>
                          <span className="text-sm font-bold font-mono" style={{ color: best ? '#34d399' : 'var(--color-text-muted)' }}>{path.totalAvg}ms</span>
                        </div>
                        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{path.description}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Per-stage */}
          <Card>
            <CardHeader>
              <CardSectionHeader icon={Cpu} color="blue" title="Per-Stage Provider Comparison" subtitle={`${iterations} iterations per provider`} />
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="flex items-center gap-3 text-sm">
                <div className={`w-2 h-2 rounded-full ${report.gpuStatus.available ? 'bg-emerald-500' : 'bg-gray-500'}`} />
                <span style={{ color: 'var(--color-text-muted)' }}>
                  GPU: {report.gpuStatus.available ? `${report.gpuStatus.gpuType} (${report.gpuStatus.dockerImage.split('/').pop()})` : 'unavailable'}
                </span>
              </div>
              {STAGES.map(s => { const d = report.stages[s.id]; return d ? <StageCard key={s.id} stage={s} data={d} maxLatency={maxLatency} /> : null; })}
            </CardBody>
          </Card>

          {/* Pipeline Progression */}
          {report.progression && (
            <Card>
              <CardHeader>
                <CardSectionHeader icon={Activity} color="violet" title="Pipeline Progression"
                  subtitle={`${report.progression.warmupIterations.length} warmup + ${report.progression.measuredIterations.length} measured via /v1/speech`} />
              </CardHeader>
              <CardBody className="space-y-4">
                {/* Legend */}
                <div className="flex gap-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ background: '#fbbf24' }} /> STT</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ background: '#a78bfa' }} /> LLM</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ background: '#34d399' }} /> TTS</span>
                  <span>🖥 GPU</span><span>☁️ Cloud</span>
                </div>

                {/* Iterations chart */}
                {(() => {
                  const all = [...report.progression!.warmupIterations, ...report.progression!.measuredIterations];
                  const maxMs = Math.max(...all.map(it => it.totalMs), 1);
                  const warmupLen = report.progression!.warmupIterations.length;
                  return (
                    <div className="space-y-1">
                      {report.progression!.warmupIterations.length > 0 && (
                        <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>Warmup (discarded)</div>
                      )}
                      {report.progression!.warmupIterations.map((it, i) => (
                        <div key={`w${i}`} style={{ opacity: 0.5 }}><ProgressionRow it={it} maxMs={maxMs} /></div>
                      ))}
                      {warmupLen > 0 && <div className="border-b my-2" style={{ borderColor: 'var(--color-border)' }} />}
                      <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>Measured</div>
                      {report.progression!.measuredIterations.map((it, i) => (
                        <ProgressionRow key={`m${i}`} it={it} maxMs={maxMs} />
                      ))}
                    </div>
                  );
                })()}

                {/* Analysis */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                  <div className="p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingDown className="w-4 h-4" style={{ color: '#34d399' }} />
                      <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Cold Start Penalty</span>
                    </div>
                    <div className="text-lg font-bold font-mono" style={{ color: report.progression.coldStartPenalty.penaltyMs > 200 ? '#fbbf24' : '#34d399' }}>
                      +{report.progression.coldStartPenalty.penaltyMs}ms
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {report.progression.coldStartPenalty.firstCallMs}ms first → {report.progression.coldStartPenalty.warmAvgMs}ms warm
                    </div>
                  </div>

                  <div className="p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
                    <div className="flex items-center gap-2 mb-1">
                      <Activity className="w-4 h-4" style={{ color: '#60a5fa' }} />
                      <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Latency Trend</span>
                    </div>
                    <div className="text-lg font-bold font-mono" style={{ color: report.progression.trend.improvementPct > 0 ? '#34d399' : '#f87171' }}>
                      {report.progression.trend.improvementPct > 0 ? '+' : ''}{report.progression.trend.improvementPct}%
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      1st half {report.progression.trend.firstHalfAvg}ms → 2nd half {report.progression.trend.secondHalfAvg}ms
                    </div>
                  </div>

                  <div className="p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
                    <div className="text-xs font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>Per-Stage Evolution</div>
                    {Object.entries(report.progression.perStageTrend).map(([stage, t]) => (
                      <div key={stage} className="flex items-center gap-2 text-xs font-mono">
                        <span className="w-8" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                        <span>{t.first}ms</span>
                        <span style={{ color: t.delta < 0 ? '#34d399' : t.delta > 0 ? '#f87171' : 'var(--color-text-muted)' }}>
                          {t.delta < 0 ? '↓' : t.delta > 0 ? '↑' : '→'} {Math.abs(t.delta)}ms
                        </span>
                        <span>→ {t.last}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
