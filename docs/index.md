---
layout: home

hero:
  name: "AI Gateway"
  text: "Speech pipeline + GPU autoscaler"
  tagline: "STT → LLM → TTS with multi-tier failover, predictive warmup, and sub-8s cold starts via SnapGPU."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Integration Patterns
      link: /guide/integration
    - theme: alt
      text: GitHub
      link: https://github.com/marcosremar/ai-gateway

features:
  - icon: 🎙️
    title: Transparent Speech API
    details: Single POST /v1/speech endpoint handles the full STT → LLM → TTS pipeline. GPU vs cloud routing is hidden from the caller.

  - icon: 🚀
    title: Multi-tier GPU Autoscaler
    details: Cascades through RunPod → Vast.ai → Modal with health checks, idle watchdog, and cost monitoring. Auto-stops after 15 min idle.

  - icon: 🔁
    title: Provider Fallback Chains
    details: Declarative failover over 8+ providers (OpenAI, Groq, Fireworks, OpenRouter, Modal, self-hosted) with cooldown and credit-exhaustion tracking.

  - icon: ❄️
    title: SnapGPU Cold Start
    details: "Three tiers: T1 cold boot (48s) → T2 warm restart (18s) → T3 CRIU restore (~8s). Docker layer caching and CRIU snapshots eliminate image pull and model reload."

  - icon: 🔮
    title: Predictive Warmup
    details: ML-based usage prediction pre-boots GPUs before demand spikes. Auto-started at gateway creation.

  - icon: 💰
    title: Spend Tracking
    details: Per-request cost estimation, budget alerts, and provider spend monitoring across all providers.
---
