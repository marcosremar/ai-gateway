/**
 * Modal REST API handlers — pure business logic for listing/stopping Modal apps.
 * Extracted from src/app/api/users/modal-apps/route.ts and modal-stop/route.ts.
 */
import type { HandlerResult } from './types';
import { ok, err } from './types';

const MODAL_API_BASE = process.env.MODAL_API_BASE || 'https://api.modal.com/v1';

const APP_STATE: Record<number, string> = {
  1: 'ephemeral',
  2: 'detached',
  3: 'deployed',
  4: 'stopping',
  5: 'stopped',
  6: 'initializing',
  7: 'disabled',
  8: 'detached',
  9: 'derived',
};

interface ModalApp {
  app_id: string;
  name: string;
  description?: string;
  state: number;
  n_running_tasks?: number;
  created_at?: string;
  stopped_at?: string;
  web_url?: string;
}

interface NormalizedApp {
  appId: string;
  name: string;
  description: string;
  state: number | undefined;
  stateLabel: string;
  nRunningTasks: number;
  createdAt: string | null;
  stoppedAt: string | null;
  webUrl: string;
  webUrls: { fn: string; url: string }[];
}

const STATE_PRIORITY: Record<string, number> = {
  deployed: 0,
  ephemeral: 1,
  initializing: 2,
  stopped: 3,
  detached: 4,
  disabled: 5,
  unknown: 6,
};

/**
 * List Modal apps using Basic auth credentials.
 */
export async function handleModalApps(
  tokenId: string,
  tokenSecret: string,
): Promise<HandlerResult> {
  if (!tokenId || !tokenSecret) {
    return err('Token ID e Token Secret sao obrigatorios');
  }

  const credentials = Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
  const headers = {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(`${MODAL_API_BASE}/apps`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        return ok({
          connected: false,
          error: 'Credenciais invalidas. Verifique o Token ID e Token Secret.',
        });
      }
      return ok({
        connected: false,
        error: `Erro ao conectar com Modal: ${res.status} ${text}`,
      });
    }

    let data: Record<string, unknown>;
    try {
      data = await res.json() as Record<string, unknown>;
    } catch {
      return ok({
        connected: false,
        error: 'Resposta inválida da API do Modal (não é JSON).',
      });
    }

    // Modal API may return apps under different keys
    const rawApps: ModalApp[] = (
      Array.isArray(data.apps) ? data.apps :
      Array.isArray(data.items) ? data.items :
      Array.isArray(data) ? data : []
    ) as ModalApp[];

    const normalized: NormalizedApp[] = rawApps.map((app) => ({
      appId: app.app_id,
      name: app.name || app.description || '',
      description: app.description || app.name || '',
      state: app.state,
      stateLabel: APP_STATE[app.state] ?? 'unknown',
      nRunningTasks: app.n_running_tasks ?? 0,
      createdAt: app.created_at ?? null,
      stoppedAt: app.stopped_at ?? null,
      webUrl: app.web_url ?? '',
      webUrls: app.web_url ? [{ fn: 'web', url: app.web_url }] : [],
    }));

    // Deduplicate by name — keep deployed over stopped
    const byName = new Map<string, NormalizedApp>();
    for (const app of normalized) {
      const existing = byName.get(app.name);
      if (!existing) {
        byName.set(app.name, app);
      } else {
        const better =
          (app.stateLabel === 'deployed' && existing.stateLabel !== 'deployed') ||
          (app.stateLabel === existing.stateLabel && (app.createdAt ?? '') > (existing.createdAt ?? ''));
        if (better) byName.set(app.name, app);
      }
    }

    const apps = Array.from(byName.values()).sort(
      (a, b) => (STATE_PRIORITY[a.stateLabel] ?? 99) - (STATE_PRIORITY[b.stateLabel] ?? 99),
    );

    return ok({
      connected: true,
      apps,
      totalCount: rawApps.length,
      deployedCount: apps.filter((a) => a.stateLabel === 'deployed').length,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = message.includes('timeout') || message.includes('abort');
    const isNetwork = message.includes('fetch') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND');
    const friendlyMsg = isTimeout
      ? 'A API do Modal demorou demais para responder. Tente novamente.'
      : isNetwork
        ? 'Não foi possível conectar à API do Modal. Verifique sua conexão.'
        : `Erro ao conectar com Modal: ${message}`;
    return ok({ connected: false, error: friendlyMsg });
  }
}

/**
 * Stop a Modal app by appId using Basic auth credentials.
 */
export async function handleModalStop(
  appId: string,
  tokenId: string,
  tokenSecret: string,
): Promise<HandlerResult> {
  if (!appId || !tokenId || !tokenSecret) {
    return err('appId, tokenId, and tokenSecret are required');
  }

  const credentials = Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');

  const res = await fetch(`${MODAL_API_BASE}/apps/${appId}/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { status: 502, body: { success: false, error: `Modal API error ${res.status}: ${text}` } };
  }

  return ok({ success: true, appId });
}
