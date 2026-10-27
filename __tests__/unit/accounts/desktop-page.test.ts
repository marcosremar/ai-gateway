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
