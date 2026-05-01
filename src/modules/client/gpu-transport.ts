/**
 * GpuTransport — Abstraction for communicating with a GPU backend.
 *
 * Two implementations exist server-side:
 *  - SshGpuTransport: SCP audio → SSH+curl (for isolated clusters without exposed ports)
 *  - DirectGpuTransport: direct HTTP fetch (for endpoints with exposed ports or tunnels)
 */

import type { ChatMessage } from '../providers/types';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface GpuPipelineResponse {
  transcript: string;
  response: string;
  audioBase64: string;
  contentType: string;
  timing: {
    stt_ms: number;
    llm_ms: number;
    tts_ms: number;
    total_ms: number;
  };
}

export interface GpuHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  models?: {
    whisper?: boolean;
    llm?: boolean;
    tts?: boolean;
  };
  uptime_seconds?: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface GpuTransport {
  /** Send audio to the GPU pipeline and return the full response. */
  sendAudio(
    audio: Buffer,
    opts?: {
      systemPrompt?: string;
      history?: ChatMessage[];
      language?: string;
    },
  ): Promise<GpuPipelineResponse>;

  /** Health check — returns status or null if unreachable. */
  checkHealth(): Promise<GpuHealthResponse | null>;
}
