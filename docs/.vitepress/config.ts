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
      { text: 'Architecture', link: '/decisions/' },
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
      {
        text: 'Architecture Decisions',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/decisions/' },
          { text: '001 Framework-Agnostic', link: '/decisions/001-framework-agnostic-design' },
          { text: '002 Lib vs Service Split', link: '/decisions/002-lib-vs-service-architecture' },
          { text: '003 Transport Policy', link: '/decisions/003-transport-policy' },
          { text: '004 Pino Over Winston', link: '/decisions/004-why-pino-over-winston' },
          { text: '005 tsup Over esbuild', link: '/decisions/005-why-tsup-over-esbuild' },
          { text: '006 Provider Fallback', link: '/decisions/006-provider-fallback-strategy' },
          { text: '007 GPU Autoscaler Tier', link: '/decisions/007-gpu-autoscaler-tier-design' },
          { text: '008 Speech Pipeline', link: '/decisions/008-speech-pipeline-design' },
        ],
      },
      {
        text: 'ADRs (GPU & Infrastructure)',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/adr/' },
          { text: '001 GPU Cascade Order', link: '/adr/ADR-001-gpu-cascade-order' },
          { text: '002 LRU Translation Cache', link: '/adr/ADR-002-lru-translation-cache' },
          { text: '003 Circuit Breakers', link: '/adr/ADR-003-per-stage-circuit-breakers' },
          { text: '004 Request Racing', link: '/adr/ADR-004-request-racing-gpu-cloud' },
          { text: '005 SnapGPU/CRIU', link: '/adr/ADR-005-snapgpu-criu-policy' },
          { text: '006 Warmth Tracking', link: '/adr/ADR-006-per-stage-warmth-tracking' },
          { text: '007 P95 Latency Demotion', link: '/adr/ADR-007-p95-latency-demotion' },
          { text: '008 Hybrid Routing', link: '/adr/ADR-008-hybrid-routing-gpu-cloud' },
          { text: '009 Provider Cooldown', link: '/adr/ADR-009-provider-cooldown-tracking' },
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
