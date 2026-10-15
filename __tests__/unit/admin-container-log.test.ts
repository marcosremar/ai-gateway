import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createAdminPage } from '../../src/admin-page';
import { renderGpuDetail } from '../../src/admin-page/pages';
import type { ContainerLogView } from '../../src/deployments/container-logs';
import { demoContainerLog, demoSnapshot } from '../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const ADMIN_KEY = 'gw_admin_0123456789abcdef0123';
const PARLE_KEY = 'gw_parle_0123456789abcdef0123';
const BABEL_KEY = 'gw_babel_0123456789abcdef0123';
const LEAKED = 'scw-secret-value-9f8e7d6c5b4a';
const opts = { now: NOW, csrf: 'c', actor: 'marcos', message: null, app: null };
const view = (over: Partial<ContainerLogView> = {}, lines = ['INFO: ready']): ContainerLogView => ({
  reason: null, pending: false, log: { deployment: 'babelcast-3090', replicaId: '31544017', at: NOW - 60_000, lines, error: null }, ...over,
});
const detail = (name: string, c: ContainerLogView | null) => renderGpuDetail('n', demoSnapshot(NOW), name, opts, c)!;

const open: Server[] = [];
afterEach(async () => { while (open.length) await new Promise(r => open.pop()!.close(r)); });

async function panel() {
  const asked: string[] = [];
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  createAdminPage({
    actorOf: (key) => (key === ADMIN_KEY ? { name: 'marcos', app: null } : key === PARLE_KEY ? { name: 'parle', app: 'parle' } : key === BABEL_KEY ? { name: 'babelcast', app: 'babelcast' } : null),
    snapshot: () => demoSnapshot(NOW),
    park: async () => {},
    probe: async () => {},
    secrets: () => [ADMIN_KEY, PARLE_KEY, BABEL_KEY, LEAKED],
    containerLog: async (name) => { asked.push(name); return view({}, ['INFO: ready', `token ${LEAKED}`]); },
    now: () => NOW,
  }).mount(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  open.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (key: string) => {
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams({ key }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  };
  const get = (path: string, cookie: string) => fetch(base + path, { redirect: 'manual', headers: { Cookie: cookie } });
  return { asked, signIn, get };
}

describe('«Log do contêiner» on the GPU detail page', () => {
  it('shows the lines under their replica and read time, next to the gateway extract', () => {
    const html = detail('babelcast-3090', view({}, ['INFO: ready', 'Loading model <b>']));
    expect(html).toContain('<h2>Log do contêiner</h2>');
    expect(html).toContain('réplica 31544017 · lido às 11:59 · nova leitura após 12:04');
    expect(html).toContain('<pre class="log">INFO: ready\nLoading model &#60;b&#62;</pre>');
    expect(html.indexOf('Extrato do log')).toBeLessThan(html.indexOf('Log do contêiner'));
    expect(html).not.toContain('o log do contêiner não é buscado');
  });

  it('says why when there is nothing to show', () => {
    expect(detail('babelcast-3090', view({ pending: true, log: null }))).toContain('Pedido à Vast: o log chega em alguns segundos. Recarregue a página.');
    expect(detail('babelcast-3090', view({ reason: 'no-replica', log: null }))).toContain('Nenhuma réplica na Vast agora: não há contêiner para ler.');
    expect(detail('speech-stack', { reason: 'unsupported', pending: false, log: null })).toContain('A Scaleway não entrega o log da máquina pela API');
    expect(detail('babelcast-3090', null)).toContain('Log do contêiner indisponível agora.');
    expect(detail('babelcast-3090', view({}, []))).toContain('O contêiner ainda não escreveu nada.');
  });

  it('marks a failed read, a refresh in progress and a replica already released', () => {
    const failed = view();
    failed.log = { ...failed.log!, lines: [], error: 'vast PUT /instances/request_logs/31544017/: HTTP 429' };
    expect(detail('babelcast-3090', failed)).toMatch(/Falhou ao buscar na Vast<\/span> vast PUT \/instances\/request_logs\/31544017\/: HTTP 429 · nova busca ao abrir a página após 12:04/);
    expect(detail('babelcast-3090', view({ pending: true }))).toContain('lido às 11:59 · atualizando');
    expect(detail('babelcast-3090', view({ reason: 'no-replica' }))).toContain('réplica 31544017 (já liberada)');
  });

  it('asks the hook only for a GPU the session may open, and redacts what it returns', async () => {
    const p = await panel();
    const admin = await p.signIn(ADMIN_KEY);
    const html = await (await p.get('/admin/gpus/babelcast-3090', admin)).text();
    expect(html).toContain('INFO: ready');
    expect(html).toContain('token [segredo]');
    expect(html).not.toContain(LEAKED);
    expect(p.asked).toEqual(['babelcast-3090']);
    const parle = await p.signIn(PARLE_KEY);
    expect((await p.get('/admin/gpus/babelcast-3090', parle)).status).toBe(404);
    expect(p.asked).toEqual(['babelcast-3090']);
    const babel = await p.signIn(BABEL_KEY);
    expect((await p.get('/admin/gpus/babelcast-3090', babel)).status).toBe(200);
    expect(p.asked).toEqual(['babelcast-3090', 'babelcast-3090']);
    expect((await p.get('/admin/gpus/babelcast-3090', '')).status).toBe(200);
    expect(p.asked).toHaveLength(2);
  });

  it('the demo shows fake lines for the Vast GPU and the Scaleway reason elsewhere', () => {
    expect(detail('babelcast-3090', demoContainerLog('babelcast-3090', NOW))).toContain('Uvicorn running on http://127.0.0.1:8010');
    expect(detail('speech-stack', demoContainerLog('speech-stack', NOW))).toContain('A Scaleway não entrega o log da máquina pela API');
  });
});
