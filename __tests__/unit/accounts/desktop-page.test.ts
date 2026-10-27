import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { accountPageCsp, desktopPage, DESKTOP_RETURN_ORIGIN, loginPage } from '../../../src/accounts/pages';

const links = {
  home: 'https://ucast.me/', signup: '/signup', login: '/login', forgot: '/forgot', reset: '/reset', verify: '/verify', account: '/account',
  download: '/download', lang: 'en' as const,
};

describe('desktop login handoff', () => {
  it('posts the key to the app instead of putting it in the address when the app asks (post=1)', () => {
    const page = desktopPage(links);
    expect(page.html).toContain("q.get('post')==='1'");
    expect(page.html).toContain("f.method='POST'");
    expect(page.formAction).toBe(DESKTOP_RETURN_ORIGIN);
  });

  it('still redirects with the key in the query for apps that do not ask for a POST', () => {
    expect(desktopPage(links).html).toContain("'/?key='+encodeURIComponent(key)");
  });

  it('allows forms to the loopback only on the desktop page', () => {
    const desktop = desktopPage(links);
    expect(accountPageCsp(desktop.nonce, desktop.formAction)).toContain("form-action 'self' http://127.0.0.1:*");
    const login = loginPage(links);
    expect(accountPageCsp(login.nonce, login.formAction)).toContain("form-action 'self';");
  });
});

interface PageRun { requests: { path: string; method: string }[]; navigations: string[]; elements: Map<string, Record<string, unknown>>; click: (id: string) => Promise<void> }

async function openDesktopPage(query: string): Promise<PageRun> {
  const html = desktopPage(links).html;
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1];
  const clicks = new Map<string, () => void>();
  const run: PageRun = { requests: [], navigations: [], elements: new Map(), click: async (id) => { clicks.get(id)!(); await new Promise((resolve) => setTimeout(resolve, 20)); } };
  const element = (id: string) => {
    if (!run.elements.has(id)) run.elements.set(id, { id, className: '', textContent: '', hidden: false, addEventListener: (type: string, handler: () => void) => { if (type === 'click') clicks.set(id, handler); }, getAttribute: () => null });
    return run.elements.get(id)!;
  };
  const respond = (path: string, method: string) => {
    if (path === '/v1/account/me') return { emailVerified: true, csrfToken: 'csrf-token' };
    if (path === '/v1/account/keys' && method === 'POST') return { key: 'ucast_live_' + 'a'.repeat(40) };
    return {};
  };
  const context = {
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => ({ appendChild() {}, submit() { run.navigations.push('form'); } }), body: { appendChild() {} } },
    location: { search: query, pathname: '/desktop', replace: (url: string) => run.navigations.push(url) },
    fetch: async (path: string, init: { method?: string }) => {
      const method = init.method ?? 'GET';
      run.requests.push({ path, method });
      return { status: 200, ok: true, json: async () => respond(path, method) };
    },
    URLSearchParams, encodeURIComponent, JSON, Promise, String, parseInt, setTimeout, console,
  };
  runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return run;
}

describe('desktop login handoff needs a person', () => {
  it('H5: does not mint an API key just because a link was opened', async () => {
    const run = await openDesktopPage('?port=53999&state=abcdefgh12345&device=Teste&post=1');
    const mintedKeys = run.requests.filter((r) => r.path === '/v1/account/keys' && r.method === 'POST');
    expect(mintedKeys, 'a key was created before any click').toHaveLength(0);
    expect(run.navigations).toHaveLength(0);
  });

  it('shows which computer is asking and offers the confirm button', async () => {
    const run = await openDesktopPage('?port=53999&state=abcdefgh12345&device=Sala%20de%20aula&post=1');
    expect(String(run.elements.get('lead')!.textContent)).toContain('Sala de aula');
    expect(run.elements.get('ok')!.hidden).toBe(false);
  });

  it('after the click, mints exactly one key and sends it to the app', async () => {
    const run = await openDesktopPage('?port=53999&state=abcdefgh12345&device=Teste&post=1');
    await run.click('ok');
    const mintedKeys = run.requests.filter((r) => r.path === '/v1/account/keys' && r.method === 'POST');
    expect(mintedKeys).toHaveLength(1);
    expect(run.navigations).toEqual(['form']);
  });

  it('cuts a very long device name taken from the link', async () => {
    const run = await openDesktopPage('?port=53999&state=abcdefgh12345&device=' + 'x'.repeat(300));
    expect(String(run.elements.get('lead')!.textContent).length).toBeLessThan(300);
  });
});
