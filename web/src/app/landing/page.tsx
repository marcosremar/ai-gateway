'use client';

import React from 'react';
import Link from 'next/link';

export default function LandingPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#09090b',
        color: '#fafafa',
        fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {/* Nav */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 2rem',
          height: '3.5rem',
          borderBottom: '1px solid #27272a',
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'rgba(9,9,11,0.85)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <div
            style={{
              width: '1.75rem',
              height: '1.75rem',
              borderRadius: '0.5rem',
              background: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '-0.02em' }}>AI</span>
          </div>
          <span style={{ fontWeight: 700, fontSize: '0.875rem', letterSpacing: '-0.02em' }}>AI Gateway</span>
        </div>

        <nav style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <a
            href="https://github.com/marcosomma/ai-gateway"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '0.375rem 0.875rem',
              borderRadius: '0.5rem',
              fontSize: '0.8125rem',
              fontWeight: 500,
              color: '#a1a1aa',
              textDecoration: 'none',
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#fafafa'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#a1a1aa'; }}
          >
            GitHub
          </a>
          <Link
            href="/"
            style={{
              padding: '0.375rem 1rem',
              borderRadius: '0.5rem',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: '#fff',
              textDecoration: 'none',
              background: '#059669',
              transition: 'background 150ms',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#047857'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#059669'; }}
          >
            Open Dashboard
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: '7rem 2rem 5rem',
          textAlign: 'center',
        }}
      >
        {/* Background glow */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(16,185,129,0.12), transparent)',
          }}
        />

        {/* Badge */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.3rem 0.875rem',
            borderRadius: '9999px',
            border: '1px solid rgba(16,185,129,0.25)',
            background: 'rgba(16,185,129,0.07)',
            marginBottom: '2rem',
            fontSize: '0.75rem',
            fontWeight: 600,
            color: '#10b981',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: '0.4rem',
              height: '0.4rem',
              borderRadius: '50%',
              background: '#10b981',
              boxShadow: '0 0 6px #10b981',
            }}
          />
          Self-Hosted &bull; Open Source &bull; Production-Ready
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 1.05,
            margin: '0 auto 1.5rem',
            maxWidth: '820px',
            background: 'linear-gradient(180deg, #fafafa 60%, #71717a 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          AI Infrastructure,<br />Under Your Control
        </h1>

        {/* Subtitle */}
        <p
          style={{
            fontSize: 'clamp(1rem, 2vw, 1.25rem)',
            color: '#71717a',
            maxWidth: '600px',
            margin: '0 auto 2.5rem',
            lineHeight: 1.65,
          }}
        >
          Self-hosted AI infrastructure. GPU-accelerated speech translation,
          multi-provider routing, and production-grade reliability — all in one gateway.
        </p>

        {/* CTA */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.75rem',
              borderRadius: '0.625rem',
              fontSize: '0.9375rem',
              fontWeight: 700,
              color: '#fff',
              background: '#059669',
              textDecoration: 'none',
              transition: 'background 150ms, transform 100ms',
              boxShadow: '0 0 0 1px rgba(16,185,129,0.3), 0 4px 24px rgba(16,185,129,0.15)',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.background = '#047857';
              el.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.background = '#059669';
              el.style.transform = 'translateY(0)';
            }}
          >
            Open Dashboard
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <a
            href="https://github.com/marcosomma/ai-gateway"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.75rem',
              borderRadius: '0.625rem',
              fontSize: '0.9375rem',
              fontWeight: 600,
              color: '#a1a1aa',
              background: 'transparent',
              border: '1px solid #27272a',
              textDecoration: 'none',
              transition: 'border-color 150ms, color 150ms',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.borderColor = '#3f3f46';
              el.style.color = '#fafafa';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.borderColor = '#27272a';
              el.style.color = '#a1a1aa';
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </section>

      {/* Stats row */}
      <section
        style={{
          padding: '0 2rem 5rem',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '1px',
            background: '#27272a',
            borderRadius: '0.875rem',
            overflow: 'hidden',
            maxWidth: '640px',
            width: '100%',
            border: '1px solid #27272a',
          }}
        >
          {[
            { value: '< 100ms', label: 'Avg latency' },
            { value: '10+', label: 'GPU providers' },
            { value: 'STT · LLM · TTS', label: 'Pipeline stages' },
          ].map((stat) => (
            <div
              key={stat.label}
              style={{
                background: '#131316',
                padding: '1.5rem 1rem',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: 'clamp(1.1rem, 2.5vw, 1.4rem)',
                  fontWeight: 800,
                  letterSpacing: '-0.03em',
                  color: '#10b981',
                  marginBottom: '0.25rem',
                }}
              >
                {stat.value}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#71717a', fontWeight: 500 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Feature cards */}
      <section style={{ padding: '0 2rem 6rem', maxWidth: '1100px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 3.5vw, 2.25rem)',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              marginBottom: '0.75rem',
            }}
          >
            Everything you need to ship AI
          </h2>
          <p style={{ color: '#71717a', fontSize: '1rem', maxWidth: '480px', margin: '0 auto' }}>
            A complete stack for running AI workloads in production without vendor lock-in.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '1rem',
          }}
        >
          {/* Card 1 — GPU Management */}
          <FeatureCard
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            }
            title="GPU Management"
            description="Spin up and tear down GPU workers across RunPod, Vast.ai, TensorDock, and Modal from a single interface. Auto-swap on failure, standby pools, and cost-aware scheduling."
            tags={['RunPod', 'Vast.ai', 'TensorDock', 'Modal']}
            accent="#6366f1"
          />

          {/* Card 2 — Multi-Provider Routing */}
          <FeatureCard
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                <path d="m4.22 4.22 2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
              </svg>
            }
            title="Multi-Provider Routing"
            description="Intelligently route requests across OpenAI, Anthropic, local models, and custom endpoints. Automatic failover, load balancing, and latency-aware provider selection."
            tags={['Failover', 'Load Balancing', 'Profiles', 'API Keys']}
            accent="#10b981"
          />

          {/* Card 3 — Real-time Translation */}
          <FeatureCard
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 2a9 9 0 0 1 9 9v2a9 9 0 0 1-9 9" /><path d="M3 13v-2a9 9 0 0 1 9-9" />
                <path d="M12 22a9 9 0 0 1-9-9" /><path d="M8 12h.01M12 12h.01M16 12h.01" />
              </svg>
            }
            title="Real-time Translation"
            description="End-to-end Speech-to-Speech pipeline: STT transcription, LLM translation, and TTS synthesis in a single low-latency flow. Streaming support with Playground for live testing."
            tags={['STT', 'LLM', 'TTS', 'Streaming']}
            accent="#f59e0b"
          />
        </div>
      </section>

      {/* Bottom CTA */}
      <section
        style={{
          textAlign: 'center',
          padding: '5rem 2rem',
          borderTop: '1px solid #27272a',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'radial-gradient(ellipse 60% 70% at 50% 100%, rgba(16,185,129,0.08), transparent)',
          }}
        />
        <p style={{ fontSize: '0.8125rem', color: '#10b981', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '1rem' }}>
          Ready to deploy?
        </p>
        <h2
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 3rem)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            marginBottom: '1.25rem',
            maxWidth: '520px',
            margin: '0 auto 1.25rem',
          }}
        >
          Your AI stack, your rules.
        </h2>
        <p
          style={{
            color: '#71717a',
            maxWidth: '420px',
            margin: '0 auto 2.5rem',
            lineHeight: 1.65,
          }}
        >
          Open the dashboard to configure providers, manage GPU workers, and monitor your pipeline in real time.
        </p>
        <Link
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.875rem 2rem',
            borderRadius: '0.625rem',
            fontSize: '1rem',
            fontWeight: 700,
            color: '#fff',
            background: '#059669',
            textDecoration: 'none',
            boxShadow: '0 0 0 1px rgba(16,185,129,0.3), 0 8px 32px rgba(16,185,129,0.2)',
            transition: 'background 150ms',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#047857'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = '#059669'; }}
        >
          Open Dashboard &rarr;
        </Link>
      </section>

      {/* Footer */}
      <footer
        style={{
          borderTop: '1px solid #27272a',
          padding: '1.5rem 2rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '1.25rem',
              height: '1.25rem',
              borderRadius: '0.3rem',
              background: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.55rem' }}>AI</span>
          </div>
          <span style={{ fontSize: '0.8125rem', color: '#52525b', fontWeight: 500 }}>
            AI Gateway &mdash; v1.0.0
          </span>
        </div>
        <span style={{ fontSize: '0.75rem', color: '#3f3f46' }}>
          Self-hosted &bull; MIT License
        </span>
      </footer>
    </div>
  );
}

/* ─── Feature Card ─────────────────────────────────────────────── */

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  tags: string[];
  accent: string;
}

function FeatureCard({ icon, title, description, tags, accent }: FeatureCardProps) {
  return (
    <div
      style={{
        background: '#131316',
        border: '1px solid #27272a',
        borderRadius: '0.875rem',
        padding: '1.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        transition: 'border-color 150ms, box-shadow 150ms',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = '#3f3f46';
        el.style.boxShadow = `0 0 0 1px ${accent}18, 0 8px 24px rgba(0,0,0,0.3)`;
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = '#27272a';
        el.style.boxShadow = 'none';
      }}
    >
      {/* Icon box */}
      <div
        style={{
          width: '2.5rem',
          height: '2.5rem',
          borderRadius: '0.625rem',
          background: `${accent}15`,
          border: `1px solid ${accent}25`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: accent,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>

      <div>
        <h3
          style={{
            fontSize: '1rem',
            fontWeight: 700,
            letterSpacing: '-0.01em',
            marginBottom: '0.5rem',
          }}
        >
          {title}
        </h3>
        <p style={{ fontSize: '0.875rem', color: '#71717a', lineHeight: 1.6 }}>
          {description}
        </p>
      </div>

      {/* Tags */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: 'auto' }}>
        {tags.map((tag) => (
          <span
            key={tag}
            style={{
              padding: '0.2rem 0.625rem',
              borderRadius: '9999px',
              fontSize: '0.7rem',
              fontWeight: 600,
              background: '#1a1a1f',
              border: '1px solid #27272a',
              color: '#52525b',
              letterSpacing: '0.02em',
            }}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}
