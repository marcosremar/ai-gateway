import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'AI Gateway',
  description: 'Speech pipeline + GPU autoscaler for TypeScript — STT → LLM → TTS with multi-tier failover',
  // base: '/ai-gateway/',  // uncomment for GitHub Pages (github.io/ai-gateway/)
  //                         // leave commented for Cloudflare Pages / custom domain

  head: [
    ['link', { rel: 'icon', href: '/ai-gateway/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Integration', link: '/guide/integration' },
      { text: 'API Reference', link: '/api/sdk' },
      { text: 'GitHub', link: 'https://github.com/marcosremar/ai-gateway' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Integration Patterns', link: '/guide/integration' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'AI Providers & Fallback', link: '/guide/providers' },
          { text: 'GPU Management', link: '/guide/gpu' },
          { text: 'SnapGPU Cold Start', link: '/guide/snapgpu' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'TypeScript SDK', link: '/api/sdk' },
          { text: 'HTTP API', link: '/api/http' },
          { text: 'Configuration', link: '/api/config' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/marcosremar/ai-gateway' },
    ],

    footer: {
      message: 'Part of the Parle platform.',
    },

    search: { provider: 'local' },
  },
})
