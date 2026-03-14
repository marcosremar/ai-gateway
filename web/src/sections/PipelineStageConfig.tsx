'use client';

import { Mic, Bot, Volume2 } from 'lucide-react';
import type { PipelineChainEntry } from './provider-types';
import { STAGE_ACCENTS } from './provider-types';
import FallbackChainList from './FallbackChainList';

interface PipelineStageConfigProps {
  pipelineStt: PipelineChainEntry[];
  setPipelineStt: (chain: PipelineChainEntry[]) => void;
  pipelineLlm: PipelineChainEntry[];
  setPipelineLlm: (chain: PipelineChainEntry[]) => void;
  pipelineTts: PipelineChainEntry[];
  setPipelineTts: (chain: PipelineChainEntry[]) => void;
}

export default function PipelineStageConfig({
  pipelineStt, setPipelineStt,
  pipelineLlm, setPipelineLlm,
  pipelineTts, setPipelineTts,
}: PipelineStageConfigProps) {
  const stages: {
    key: 'stt' | 'llm' | 'tts';
    title: string;
    subtitle: string;
    icon: typeof Mic;
    chain: PipelineChainEntry[];
    setChain: (chain: PipelineChainEntry[]) => void;
  }[] = [
    {
      key: 'stt', title: 'STT', subtitle: 'Speech-to-Text', icon: Mic,
      chain: pipelineStt, setChain: setPipelineStt,
    },
    {
      key: 'llm', title: 'LLM', subtitle: 'Translation', icon: Bot,
      chain: pipelineLlm, setChain: setPipelineLlm,
    },
    {
      key: 'tts', title: 'TTS', subtitle: 'Text-to-Speech', icon: Volume2,
      chain: pipelineTts, setChain: setPipelineTts,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      {stages.map((stage) => {
        const StageIcon = stage.icon;
        const accent = STAGE_ACCENTS[stage.key];

        return (
          <div
            key={stage.key}
            className="rounded-xl border p-4 transition-all"
            style={{
              borderColor: `color-mix(in srgb, ${accent.dot} 25%, var(--color-border))`,
              background: 'var(--color-surface)',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: `color-mix(in srgb, ${accent.dot} 15%, transparent)` }}
                >
                  <StageIcon className="w-4 h-4" style={{ color: accent.iconColor }} />
                </div>
                <div>
                  <h4 className="text-sm font-semibold">{stage.title}</h4>
                  <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{stage.subtitle}</p>
                </div>
              </div>
              {stage.chain.length > 1 && (
                <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
                  {stage.chain.length} providers
                </span>
              )}
            </div>

            <FallbackChainList
              stage={stage.key}
              chain={stage.chain}
              setChain={stage.setChain}
              accent={accent}
            />
          </div>
        );
      })}
    </div>
  );
}
