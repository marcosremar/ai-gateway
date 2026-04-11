'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  vastListEndpoints, vastCreateEndpoint, vastDeleteEndpoint,
  vastListWorkerGroups, vastCreateWorkerGroup, vastDeleteWorkerGroup,
  type VastEndpoint, type VastWorkerGroup,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, CardFooter, Button,
  SectionHeader, StatusBadge, AlertBanner, KV, FormInput, Spinner,
  ConfirmModal, IconBox,
} from '@/components/ui';
import { CopyButton } from '@/components/ui/CopyButton';
import {
  Server, Plus, Trash2, RefreshCw, Users, Cpu, Info,
  ChevronDown, ChevronRight, Zap,
} from 'lucide-react';

// ── How It Works panel ────────────────────────────────────────────────────────

function HowItWorksPanel() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <button
          className="flex items-center justify-between w-full cursor-pointer"
          onClick={() => setOpen(o => !o)}
        >
          <div className="flex items-center gap-3">
            <IconBox icon={Info} color="#38bdf8" size="sm" />
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              Como funciona o Serverless do Vast.ai
            </span>
          </div>
          {open
            ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
        </button>
      </CardHeader>

      {open && (
        <CardBody>
          <div className="space-y-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div
                className="rounded-lg p-3 space-y-1 border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              >
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4" style={{ color: '#f59e0b' }} />
                  <span className="font-medium text-xs" style={{ color: 'var(--color-text)' }}>Endpoint</span>
                </div>
                <p className="text-xs">
                  Ponto de entrada com nome único. Define os limites de escala
                  (<code>max_workers</code>) e standby (<code>cold_workers</code>).
                  Gera uma API key própria para roteamento.
                </p>
              </div>

              <div
                className="rounded-lg p-3 space-y-1 border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              >
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4" style={{ color: '#a78bfa' }} />
                  <span className="font-medium text-xs" style={{ color: 'var(--color-text)' }}>Worker Group</span>
                </div>
                <p className="text-xs">
                  Define qual GPU recrutar para o endpoint (GPU RAM, search query).
                  Um endpoint pode ter múltiplos worker groups com GPUs diferentes.
                </p>
              </div>

              <div
                className="rounded-lg p-3 space-y-1 border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              >
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4" style={{ color: '#34d399' }} />
                  <span className="font-medium text-xs" style={{ color: 'var(--color-text)' }}>Workers (instâncias)</span>
                </div>
                <p className="text-xs">
                  GPUs reais recrutadas pelo Vast.ai. Escalam automaticamente
                  com base na carga. Se <code>cold_workers=0</code>, escala a zero
                  quando ocioso.
                </p>
              </div>
            </div>

            <div
              className="rounded-lg p-3 border text-xs space-y-2"
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', fontFamily: 'monospace' }}
            >
              <div style={{ color: 'var(--color-text-muted)' }}>Ciclo de vida típico:</div>
              <div>
                <span style={{ color: '#34d399' }}>Request chega</span>
                <span style={{ color: 'var(--color-text-muted)' }}> → routeRequest() → </span>
                <span style={{ color: '#f59e0b' }}>worker disponível?</span>
              </div>
              <div className="pl-4 space-y-1">
                <div><span style={{ color: '#34d399' }}>Sim (cold_workers &gt; 0)</span><span style={{ color: 'var(--color-text-muted)' }}> → ~30s boot (imagem cacheada no host)</span></div>
                <div><span style={{ color: '#f87171' }}>Não (cold_workers = 0)</span><span style={{ color: 'var(--color-text-muted)' }}> → recruta novo host → cold start (~44–323s)</span></div>
              </div>
              <div>
                <span style={{ color: '#38bdf8' }}>Idle por inactivity_timeout</span>
                <span style={{ color: 'var(--color-text-muted)' }}> → scale down para zero</span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {[
                { param: 'cold_workers', desc: 'Workers sempre ligados (standby). 0 = scale-to-zero.' },
                { param: 'max_workers', desc: 'Teto de workers simultâneos.' },
                { param: 'min_load', desc: 'Carga mínima target. Ajuda o scheduler a manter 1 worker ativo.' },
                { param: 'target_util', desc: 'Utilização alvo (0.9 = 10% de headroom para picos).' },
              ].map(({ param, desc }) => (
                <div key={param} className="rounded p-2 border" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
                  <code className="text-xs block mb-1" style={{ color: '#a78bfa' }}>{param}</code>
                  <span style={{ color: 'var(--color-text-muted)' }}>{desc}</span>
                </div>
              ))}
            </div>

          </div>
        </CardBody>
      )}
    </Card>
  );
}

// ── Create Endpoint form ──────────────────────────────────────────────────────

interface CreateEndpointFormProps {
  onCreated: () => void;
}

function CreateEndpointForm({ onCreated }: CreateEndpointFormProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    coldWorkers: 0,
    maxWorkers: 5,
    minLoad: 1,
    targetUtil: 0.9,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await vastCreateEndpoint({
        name: form.name.trim(),
        coldWorkers: form.coldWorkers,
        maxWorkers: form.maxWorkers,
        minLoad: form.minLoad,
        targetUtil: form.targetUtil,
      });
      setForm({ name: '', coldWorkers: 0, maxWorkers: 5, minLoad: 1, targetUtil: 0.9 });
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" />
        Novo Endpoint
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <IconBox icon={Plus} color="#34d399" size="sm" />
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>Criar Endpoint</span>
        </div>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <AlertBanner variant="error">{error}</AlertBanner>}

          <FormInput
            label="Nome"
            value={form.name}
            onChange={v => setForm(f => ({ ...f, name: v }))}
            placeholder="ex: babelcast-prod"
            required
          />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                cold_workers
              </label>
              <input
                type="number" min="0" max="10"
                value={form.coldWorkers}
                onChange={e => setForm(f => ({ ...f, coldWorkers: parseInt(e.target.value) || 0 }))}
                className="w-full px-2 py-1.5 text-sm rounded-md border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              />
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Workers em standby</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                max_workers
              </label>
              <input
                type="number" min="1" max="100"
                value={form.maxWorkers}
                onChange={e => setForm(f => ({ ...f, maxWorkers: parseInt(e.target.value) || 1 }))}
                className="w-full px-2 py-1.5 text-sm rounded-md border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              />
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Máximo simultâneo</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                min_load
              </label>
              <input
                type="number" min="0" max="100"
                value={form.minLoad}
                onChange={e => setForm(f => ({ ...f, minLoad: parseInt(e.target.value) || 0 }))}
                className="w-full px-2 py-1.5 text-sm rounded-md border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              />
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Carga mínima target</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                target_util
              </label>
              <input
                type="number" min="0.1" max="1.0" step="0.05"
                value={form.targetUtil}
                onChange={e => setForm(f => ({ ...f, targetUtil: parseFloat(e.target.value) || 0.9 }))}
                className="w-full px-2 py-1.5 text-sm rounded-md border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              />
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Utilização alvo 0–1</p>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" size="sm" loading={saving}>Criar</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }}>Cancelar</Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ── Add Worker Group form ─────────────────────────────────────────────────────

interface AddWorkerGroupFormProps {
  endpointId: number;
  onCreated: () => void;
  onCancel: () => void;
}

function AddWorkerGroupForm({ endpointId, onCreated, onCancel }: AddWorkerGroupFormProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [form, setForm] = useState({
    image: 'marcosremar/babelcast-subtitle',
    tag: 'latest',
    gpuRamGb: 24,
    maxWorkers: 3,
    coldWorkers: 0,
    searchParams: 'verified=true rentable=true rented=false',
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setStatusMsg('Resolvendo template…');
    try {
      await vastCreateWorkerGroup({
        endpointId,
        image: form.image.trim() || undefined,
        tag: form.tag.trim() || undefined,
        gpuRamGb: form.gpuRamGb,
        maxWorkers: form.maxWorkers,
        coldWorkers: form.coldWorkers,
        searchParams: `${form.searchParams} gpu_ram>=${form.gpuRamGb}`,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setStatusMsg(null);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 p-3 rounded-lg border space-y-3"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      {/* Docker image — auto-resolves template */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
            Imagem Docker
          </label>
          <input
            type="text"
            value={form.image}
            onChange={e => setForm(f => ({ ...f, image: e.target.value }))}
            className="w-full px-2 py-1.5 text-sm rounded-md border font-mono"
            style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            placeholder="marcosremar/babelcast-subtitle"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Tag</label>
          <input
            type="text"
            value={form.tag}
            onChange={e => setForm(f => ({ ...f, tag: e.target.value }))}
            className="w-full px-2 py-1.5 text-sm rounded-md border font-mono"
            style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            placeholder="latest"
          />
        </div>
      </div>
      <p className="text-xs -mt-1" style={{ color: 'var(--color-text-muted)' }}>
        Template criado automaticamente via <code style={{ color: '#a78bfa' }}>findOrCreateTemplate</code> — hosts com a imagem cacheada serão preferidos.
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>GPU RAM (GB)</label>
          <input
            type="number" min="8" max="80" step="8"
            value={form.gpuRamGb}
            onChange={e => setForm(f => ({ ...f, gpuRamGb: parseInt(e.target.value) || 24 }))}
            className="w-full px-2 py-1.5 text-sm rounded-md border"
            style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>max_workers</label>
          <input
            type="number" min="1" max="50"
            value={form.maxWorkers}
            onChange={e => setForm(f => ({ ...f, maxWorkers: parseInt(e.target.value) || 1 }))}
            className="w-full px-2 py-1.5 text-sm rounded-md border"
            style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>cold_workers</label>
          <input
            type="number" min="0" max="10"
            value={form.coldWorkers}
            onChange={e => setForm(f => ({ ...f, coldWorkers: parseInt(e.target.value) || 0 }))}
            className="w-full px-2 py-1.5 text-sm rounded-md border"
            style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Search params adicionais
        </label>
        <input
          type="text"
          value={form.searchParams}
          onChange={e => setForm(f => ({ ...f, searchParams: e.target.value }))}
          className="w-full px-2 py-1.5 text-sm rounded-md border font-mono"
          style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          placeholder="verified=true rentable=true rented=false"
        />
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <code className="text-xs" style={{ color: '#a78bfa' }}>gpu_ram&gt;={form.gpuRamGb}</code> é adicionado automaticamente.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" loading={saving}>Adicionar Worker Group</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancelar</Button>
        {saving && statusMsg && (
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{statusMsg}</span>
        )}
      </div>
    </form>
  );
}

// ── Endpoint card ─────────────────────────────────────────────────────────────

interface EndpointCardProps {
  endpoint: VastEndpoint;
  workerGroups: VastWorkerGroup[];
  onDelete: (id: number) => void;
  onDeleteWorkerGroup: (id: number) => void;
  onWorkerGroupCreated: () => void;
}

function EndpointCard({ endpoint, workerGroups, onDelete, onDeleteWorkerGroup, onWorkerGroupCreated }: EndpointCardProps) {
  const [showKey, setShowKey] = useState(false);
  const [addingWG, setAddingWG] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const myGroups = workerGroups.filter(wg => wg.endpointId === endpoint.id || wg.endpointName === endpoint.name);

  const stateVariant = endpoint.state === 'running' || endpoint.state === 'active'
    ? 'emerald'
    : endpoint.state === 'cold'
    ? 'sky'
    : 'gray';

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <IconBox icon={Server} color="#f59e0b" size="sm" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>
                    {endpoint.name}
                  </span>
                  <StatusBadge variant={stateVariant} dot>{endpoint.state || 'unknown'}</StatusBadge>
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  id={endpoint.id} · {myGroups.length} worker group{myGroups.length !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-colors flex-shrink-0"
              style={{ color: 'var(--color-text-muted)' }}
              title="Deletar endpoint"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </CardHeader>

        <CardBody>
          {/* Scaling config */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <KV label="cold_workers" value={String(endpoint.coldWorkers)} mono />
            <KV label="max_workers" value={String(endpoint.maxWorkers)} mono />
            <KV label="min_load" value={String(endpoint.minLoad)} mono />
            <KV label="target_util" value={endpoint.targetUtil.toFixed(2)} mono />
          </div>

          {/* API Key */}
          {endpoint.apiKey && (
            <div
              className="flex items-center justify-between p-2 rounded-md border mb-4"
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>API Key:</span>
                <code
                  className="text-xs font-mono truncate"
                  style={{ color: 'var(--color-text)' }}
                >
                  {showKey ? endpoint.apiKey : `${endpoint.apiKey.slice(0, 8)}${'•'.repeat(16)}`}
                </code>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setShowKey(s => !s)}
                  className="text-xs px-2 py-0.5 rounded cursor-pointer"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {showKey ? 'ocultar' : 'mostrar'}
                </button>
                <CopyButton text={endpoint.apiKey} />
              </div>
            </div>
          )}

          {/* Worker Groups */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Worker Groups
              </span>
              {!addingWG && (
                <button
                  onClick={() => setAddingWG(true)}
                  className="flex items-center gap-1 text-xs cursor-pointer"
                  style={{ color: '#34d399' }}
                >
                  <Plus className="w-3 h-3" /> Adicionar
                </button>
              )}
            </div>

            {myGroups.length === 0 && !addingWG && (
              <p className="text-xs py-2" style={{ color: 'var(--color-text-muted)' }}>
                Nenhum worker group. Adicione um para que o endpoint possa recrutar GPUs.
              </p>
            )}

            {myGroups.map(wg => (
              <div
                key={wg.id}
                className="flex items-center justify-between p-2 rounded-md border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              >
                <div className="flex items-center gap-3">
                  <Cpu className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#a78bfa' }} />
                  <div className="text-xs space-y-0.5">
                    <div style={{ color: 'var(--color-text)' }}>
                      id={wg.id} · {wg.gpuRamGb}GB RAM · max {wg.maxWorkers} workers
                    </div>
                    {wg.templateHash && (
                      <code className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        template: {wg.templateHash.slice(0, 12)}…
                      </code>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onDeleteWorkerGroup(wg.id)}
                  className="flex items-center justify-center w-6 h-6 rounded cursor-pointer flex-shrink-0"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Remover worker group"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}

            {addingWG && (
              <AddWorkerGroupForm
                endpointId={endpoint.id}
                onCreated={() => { setAddingWG(false); onWorkerGroupCreated(); }}
                onCancel={() => setAddingWG(false)}
              />
            )}
          </div>
        </CardBody>

        <CardFooter>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Criado {endpoint.createdAt ? new Date(endpoint.createdAt).toLocaleDateString('pt-BR') : '—'}
          </span>
        </CardFooter>
      </Card>

      <ConfirmModal
        open={confirmDelete}
        title="Deletar endpoint?"
        description={`O endpoint "${endpoint.name}" e todos os seus worker groups serão removidos permanentemente.`}
        confirmLabel="Deletar"
        variant="danger"
        onConfirm={() => { setConfirmDelete(false); onDelete(endpoint.id); }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

// ── Main Section ──────────────────────────────────────────────────────────────

export function VastServerlessSection() {
  const [endpoints, setEndpoints] = useState<VastEndpoint[]>([]);
  const [workerGroups, setWorkerGroups] = useState<VastWorkerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ep, wg] = await Promise.all([vastListEndpoints(), vastListWorkerGroups()]);
      setEndpoints(ep.endpoints);
      setWorkerGroups(wg.workerGroups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDeleteEndpoint(id: number) {
    setActionError(null);
    try {
      await vastDeleteEndpoint(id);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDeleteWorkerGroup(id: number) {
    setActionError(null);
    try {
      await vastDeleteWorkerGroup(id);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="p-6 space-y-5">
      <SectionHeader
        title="Vast.ai Serverless"
        subtitle="Gerenciar endpoints serverless e worker groups para escalonamento automático de GPUs"
      />

      <HowItWorksPanel />

      {error && (
        <AlertBanner variant="error">
          {error.includes('VAST_API_KEY') ? (
            <>VAST_API_KEY não configurada. Adicione em <strong>Config → API Keys</strong>.</>
          ) : error}
        </AlertBanner>
      )}

      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}

      {loading ? (
        <div className="flex justify-center py-12"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Header row */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium" style={{ color: 'var(--color-text-muted)' }}>
              {endpoints.length} endpoint{endpoints.length !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={load}
                className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer"
                style={{ color: 'var(--color-text-muted)' }}
                title="Atualizar"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <CreateEndpointForm onCreated={load} />
            </div>
          </div>

          {endpoints.length === 0 ? (
            <Card>
              <CardBody>
                <div className="flex flex-col items-center py-8 gap-3 text-center">
                  <IconBox icon={Server} color="#f59e0b" size="md" />
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                      Nenhum endpoint configurado
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                      Crie um endpoint para começar a usar o serverless do Vast.ai.
                    </p>
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : (
            <div className="space-y-4">
              {endpoints.map(ep => (
                <EndpointCard
                  key={ep.id}
                  endpoint={ep}
                  workerGroups={workerGroups}
                  onDelete={handleDeleteEndpoint}
                  onDeleteWorkerGroup={handleDeleteWorkerGroup}
                  onWorkerGroupCreated={load}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
