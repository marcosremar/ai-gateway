/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'publishable-code-must-not-import-server',
      severity: 'error',
      comment: 'src/ and sdk/ are publishable surfaces; server/ is the thin delivery layer.',
      from: { path: '^(src|sdk)(/|$)' },
      to: { path: '^server(/|$)' },
    },
    {
      name: 'publishable-code-must-not-import-web',
      severity: 'error',
      comment: 'Next.js and UI delivery concerns stay in web/.',
      from: { path: '^(src|sdk)(/|$)' },
      to: { path: '^web(/|$)' },
    },
    {
      name: 'web-must-not-import-server',
      severity: 'error',
      comment: 'web/src talks to the Gateway API; it must not import server internals.',
      from: { path: '^web/src(/|$)' },
      to: { path: '^server(/|$)' },
    },
    {
      name: 'web-may-only-import-browser-sdk-from-src',
      severity: 'error',
      comment: 'web/src may import src/browser only; other Gateway interactions go through HTTP/WebSocket clients.',
      from: { path: '^web/src(/|$)' },
      to: { path: '^src/(?!browser(/|$))' },
    },
    {
      name: 'server-must-not-import-web',
      severity: 'error',
      comment: 'server/ and web/ are independent delivery layers.',
      from: { path: '^server(/|$)' },
      to: { path: '^web(/|$)' },
    },
  ],
  options: {
    doNotFollow: {
      path: '^(node_modules|dist|coverage|\\.next|\\.stryker-tmp)(/|$)',
    },
    exclude: {
      path: '^(dist|coverage|node_modules|\\.next|__tests__)(/|$)',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      archi: {
        collapsePattern: 'node_modules/[^/]+',
      },
    },
  },
};
