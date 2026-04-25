'use client';

import { useGateway } from '@/hooks/useGateway';
import { Spinner } from '@/components/ui';

const RULE_TYPES = [
  { type: 'regex', label: 'Regex Match', description: 'Bloqueia/permite requests por padrão regex', color: '#60a5fa' },
  { type: 'jsonSchema', label: 'JSON Schema', description: 'Valida se a resposta do LLM bate com um schema', color: '#a78bfa' },
  { type: 'containsCode', label: 'Contém Código', description: 'Detecta código (SQL, Python, TypeScript, etc.)', color: '#f59e0b' },
  { type: 'webhook', label: 'Webhook', description: 'Chama endpoint externo para decidir pass/block', color: '#34d399' },
  { type: 'notNull', label: 'Not Null', description: 'Garante que a resposta não está vazia', color: '#fb923c' },
  { type: 'modelWhitelist', label: 'Model Allowlist', description: 'Permite ou bloqueia modelos específicos', color: '#e879f9' },
];

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border p-4 text-center"
      style={{
        borderColor: `color-mix(in srgb, ${color} 25%, var(--color-border))`,
        background: `color-mix(in srgb, ${color} 8%, var(--color-surface))`,
      }}>
      <div className="font-mono text-3xl font-bold mb-0.5" style={{ color }}>{value}</div>
      <div className="text-[10px] font-semibold uppercase" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}>{label}</div>
    </div>
  );
}

export function GuardrailsSection() {
  const { health } = useGateway();

  if (!health) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;

  const g = health.guardrails;
  const hasData = g && g.totalEvaluations > 0;
  const blockRate = hasData && g.totalEvaluations > 0
    ? Math.round((g.blocked / g.totalEvaluations) * 10000) / 100
    : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(16,185,129,0.15)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Guardrails</h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Regras que filtram e validam requests/responses antes e depois do LLM.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatBox label="Total" value={g?.totalEvaluations ?? 0} color="#a1a1aa" />
        <StatBox label="Passou" value={g?.passed ?? 0} color="#4ade80" />
        <StatBox label="Bloqueado" value={g?.blocked ?? 0} color="#f87171" />
        <StatBox label="Auditado" value={g?.audited ?? 0} color="#fbbf24" />
      </div>

      {/* Block rate bar */}
      {hasData && (
        <div className="rounded-xl border p-4"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold">Taxa de bloqueio</span>
            <span className="font-mono text-sm font-bold" style={{ color: blockRate > 10 ? '#f87171' : '#4ade80' }}>
              {blockRate}%
            </span>
          </div>
          <div className="w-full h-2 rounded-full" style={{ background: 'var(--color-border)' }}>
            <div className="h-2 rounded-full transition-all"
              style={{ width: `${Math.min(blockRate, 100)}%`, background: blockRate > 10 ? '#f87171' : '#10b981' }} />
          </div>
          {g?.lastBlockedAt && (
            <p className="text-[10px] mt-2" style={{ color: 'var(--color-text-muted)' }}>
              Último bloqueio: {new Date(g.lastBlockedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* Rule hits breakdown */}
      {hasData && Object.keys(g!.ruleHits).length > 0 && (
        <div className="rounded-xl border overflow-hidden"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
          <div className="px-4 py-2.5 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-[12px] font-semibold">Regras ativadas</span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {Object.entries(g!.ruleHits)
              .sort((a, b) => b[1] - a[1])
              .map(([rule, count]) => {
                const meta = RULE_TYPES.find(r => r.type === rule);
                const maxCount = Math.max(...Object.values(g!.ruleHits));
                return (
                  <div key={rule} className="px-4 py-3 flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: meta?.color ?? '#71717a' }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium">{meta?.label ?? rule}</div>
                      <div className="w-full h-1 rounded-full mt-1" style={{ background: 'var(--color-border)' }}>
                        <div className="h-1 rounded-full"
                          style={{ width: `${(count / maxCount) * 100}%`, background: meta?.color ?? '#71717a' }} />
                      </div>
                    </div>
                    <span className="font-mono text-sm font-bold flex-shrink-0" style={{ color: meta?.color ?? '#71717a' }}>{count}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Available rules reference */}
      <div className="rounded-xl border overflow-hidden"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
        <div className="px-4 py-2.5 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <span className="text-[12px] font-semibold">Tipos de regra disponíveis</span>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
          {RULE_TYPES.map(({ type, label, description, color }) => (
            <div key={type} className="px-4 py-3 flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: color }} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold">{label}</span>
                  <code className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                    style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
                    {type}
                  </code>
                  {g?.ruleHits?.[type] ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ml-auto"
                      style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                      {g.ruleHits[type]}× ativado
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {!hasData && (
        <div className="rounded-xl border p-8 text-center"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeLinecap="round" className="mx-auto mb-3 opacity-40">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <p className="text-sm font-medium mb-1">Nenhuma regra ativa ainda</p>
          <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            Configure um <code className="font-mono">GuardrailEngine</code> no <code className="font-mono">ProxyConfig</code> para ativar filtragem de requests.
          </p>
        </div>
      )}
    </div>
  );
}
