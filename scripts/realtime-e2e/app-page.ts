import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { join, resolve } from 'path';
import { chromium, type Browser, type Page } from 'playwright';
import { freePort } from './local-cloud';

const ROOT = resolve(import.meta.dir, '../..');

async function readAll(req: IncomingMessage): Promise<Buffer> { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); }

export interface AppBackendOptions {
  gw: string;
  key: string;
  pageFile: string;
  config: (req: IncomingMessage) => Record<string, unknown>;
  files?: Record<string, { type: string; body: Buffer | string }>;
}

export async function startAppBackend(o: AppBackendOptions): Promise<{ url: string; close: () => void }> {
  const sdkBuild = await Bun.build({ entrypoints: [join(ROOT, 'sdk/browser/realtime/index.ts')], target: 'browser', format: 'esm' });
  if (!sdkBuild.success) throw new Error(`SDK build failed: ${sdkBuild.logs.join('\n')}`);
  const sdkJs = await sdkBuild.outputs[0].text();
  const page = `<!doctype html><meta charset="utf-8"><title>rt</title><body><script type="module" src="/page.js"></script>`;
  const pageJs = await Bun.file(join(import.meta.dir, o.pageFile)).text();
  const files: Record<string, { type: string; body: Buffer | string }> = {
    '/': { type: 'text/html', body: page }, '/sdk.js': { type: 'text/javascript', body: sdkJs }, '/page.js': { type: 'text/javascript', body: pageJs },
    '/meter.js': { type: 'text/javascript', body: await Bun.file(join(import.meta.dir, 'page-meter.js')).text() }, ...o.files,
  };
  async function relay(req: IncomingMessage, res: ServerResponse, path: string, withConfig = false): Promise<void> {
    let body = await readAll(req);
    if (withConfig) body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString() || '{}'), config: o.config(req) }));
    const headers: Record<string, string> = { Authorization: `Bearer ${o.key}`, 'Content-Type': String(req.headers['content-type'] ?? 'application/json') };
    if (req.headers.traceparent) headers.traceparent = String(req.headers.traceparent);
    const up = await fetch(`${o.gw}${path}`, { method: 'POST', headers, body });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!['content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    if (up.body) for await (const chunk of up.body) res.write(chunk);
    res.end();
  }
  const port = await freePort();
  const app = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && files[path]) { res.writeHead(200, { 'content-type': files[path].type }); res.end(files[path].body); return; }
    if (req.method === 'POST' && path === '/api/rt-session') { void relay(req, res, '/v1/realtime/sessions', true); return; }
    if (req.method === 'POST' && path === '/api/s2s') { void relay(req, res, '/v1/s2s'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => app.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface MicPageOptions {
  chrome: string;
  mic: string;
  url: string;
  readyFlag: string;
  log: (line: string) => void;
  extraArgs?: string[];
  browsers?: Browser[];
}

export async function openMicPage(o: MicPageOptions): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    executablePath: o.chrome,
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${o.mic}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', ...(o.extraArgs ?? []),
    ],
  });
  o.browsers?.push(browser);
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => o.log(`[page ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => o.log(`[page error] ${e.message}`));
  await page.goto(o.url);
  await page.waitForFunction((flag) => (window as unknown as Record<string, unknown>)[flag] === true, o.readyFlag);
  return { browser, page };
}
