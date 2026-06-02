import type { IncomingMessage, ServerResponse } from 'http';
import { handleChatCompletions } from '../proxy/routes/chat-completions';
import { handleModelsWithDynamic } from '../proxy/routes/models';
import type { ProviderMapping, ProxyRequest } from '../proxy/types';

export interface GatewayMcpOptions {
  name?: string;
  version?: string;
  providers: ProviderMapping;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface GatewayEndpoint {
  method: string;
  path: string;
  category: string;
  description: string;
  destructive?: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_MCP_MAX_BODY_BYTES = 64 * 1024 * 1024;
const CANONICAL_CATEGORIES = [
  'gateway',
  'models',
  'chat',
  'audio',
  'speech',
  'images',
  'video',
  'threeD',
  'gpu',
  'fineTunes',
  'datasets',
  'bots',
  'dockerImages',
  'workloads',
  'config',
  'observability',
  'diagnostics',
] as const;

const GATEWAY_ENDPOINTS: GatewayEndpoint[] = [
  { method: 'GET', path: '/health', category: 'system', description: 'Gateway health and active connection counters.' },
  { method: 'GET', path: '/v1/models', category: 'inference', description: 'OpenAI-compatible model catalog.' },
  { method: 'POST', path: '/v1/chat/completions', category: 'inference', description: 'OpenAI-compatible chat completions.' },
  { method: 'POST', path: '/v1/embeddings', category: 'inference', description: 'OpenAI-compatible embeddings.' },
  { method: 'POST', path: '/v1/transcribe', category: 'inference', description: 'Speech-to-text transcription.' },
  { method: 'POST', path: '/v1/audio/transcriptions', category: 'inference', description: 'OpenAI-compatible audio transcription.' },
  { method: 'POST', path: '/v1/transcribe/ensemble', category: 'inference', description: 'Parallel multi-provider STT ensemble.' },
  { method: 'POST', path: '/v1/ensemble-transcribe', category: 'inference', description: 'Legacy ensemble STT alias.' },
  { method: 'POST', path: '/v1/translate', category: 'inference', description: 'Text translation through the gateway routing layer.' },
  { method: 'POST', path: '/v1/tts/preview', category: 'inference', description: 'TTS preview with gateway voice routing.' },
  { method: 'POST', path: '/v1/tts-preview', category: 'inference', description: 'Legacy TTS preview alias.' },
  { method: 'POST', path: '/v1/tts', category: 'inference', description: 'Legacy TTS alias.' },
  { method: 'GET', path: '/v1/tts/voices', category: 'inference', description: 'Voice catalog across configured TTS providers.' },
  { method: 'POST', path: '/v1/audio/speech', category: 'inference', description: 'OpenAI-compatible speech synthesis.' },
  { method: 'POST', path: '/v1/audio/speech/clone', category: 'inference', description: 'Voice-clone TTS via the active clone pod or configured upstream.' },
  { method: 'POST', path: '/v1/speech', category: 'pipeline', description: 'Full STT to LLM to TTS speech pipeline.' },
  { method: 'POST', path: '/v1/detect-language', category: 'inference', description: 'Language detection via LLM.' },
  { method: 'POST', path: '/v1/images/generate', category: 'inference', description: 'Image generation through gateway image routing.' },
  { method: 'POST', path: '/v1/images/generations', category: 'inference', description: 'OpenAI-compatible image generations alias.' },
  { method: 'POST', path: '/v1/images/inpaint', category: 'inference', description: 'Image inpainting.' },
  { method: 'POST', path: '/v1/video/generate', category: 'inference', description: 'Video generation via configured GPU/video backend.' },
  { method: 'POST', path: '/v1/diagrams/generate', category: 'inference', description: 'Manim diagram generation.' },
  { method: 'POST', path: '/v1/3d/generate', category: 'inference', description: 'Image-to-3D generation via TRELLIS.2 upstream.' },
  { method: 'POST', path: '/v1/audio/align', category: 'inference', description: 'WhisperX word-level forced alignment.' },
  { method: 'POST', path: '/v1/whiteboard/animate', category: 'inference', description: 'Whiteboard animation rendering.' },
  { method: 'GET', path: '/v1/search', category: 'inference', description: 'Search via configured search backend.' },
  { method: 'POST', path: '/v1/search', category: 'inference', description: 'Search via configured search backend.' },
  { method: 'GET', path: '/v1/analytics/system', category: 'observability', description: 'System analytics dashboard payload.' },
  { method: 'GET', path: '/v1/auto-swap/status', category: 'routing', description: 'Auto-swap routing status.' },
  { method: 'POST', path: '/v1/auto-swap/toggle', category: 'routing', description: 'Toggle latency-based provider auto-swap.' },
  { method: 'POST', path: '/v1/auto-swap/benchmark', category: 'routing', description: 'Run auto-swap benchmark.' },
  { method: 'GET', path: '/v1/playground/catalog', category: 'playground', description: 'Playground model catalog.' },
  { method: 'POST', path: '/v1/playground/stt', category: 'playground', description: 'Playground STT run.' },
  { method: 'POST', path: '/v1/playground/llm', category: 'playground', description: 'Playground LLM run.' },
  { method: 'POST', path: '/v1/playground/tts', category: 'playground', description: 'Playground TTS run.' },
  { method: 'POST', path: '/v1/playground/pipeline', category: 'playground', description: 'Playground full pipeline run.' },
  { method: 'POST', path: '/v1/gpu/deploy', category: 'gpu', description: 'Deploy a GPU instance through the gateway deploy lifecycle.', destructive: true },
  { method: 'POST', path: '/v1/gpu/deploy/validate', category: 'gpu', description: 'Validate a GPU deploy request without provisioning.' },
  { method: 'GET', path: '/v1/gpu/status', category: 'gpu', description: 'Current GPU deploy state.' },
  { method: 'POST', path: '/v1/gpu/keepalive', category: 'gpu', description: 'Keep the active GPU instance warm.' },
  { method: 'POST', path: '/v1/gpu/stop', category: 'gpu', description: 'Stop the active GPU instance.', destructive: true },
  { method: 'POST', path: '/v1/gpu/resume', category: 'gpu', description: 'Resume a stopped GPU instance.', destructive: true },
  { method: 'POST', path: '/v1/gpu/terminate', category: 'gpu', description: 'Terminate a GPU instance.', destructive: true },
  { method: 'GET', path: '/v1/gpu/logs', category: 'gpu', description: 'Active GPU logs.' },
  { method: 'GET', path: '/v1/gpu/inspect', category: 'gpu', description: 'Inspect the active GPU instance.' },
  { method: 'GET', path: '/v1/gpu/deploy-history', category: 'gpu', description: 'Recent GPU deployment history.' },
  { method: 'GET', path: '/v1/gpu/logs/events', category: 'gpu', description: 'GPU lifecycle event logs.' },
  { method: 'GET', path: '/v1/gpu/list', category: 'gpu', description: 'List active GPU instances across providers.' },
  { method: 'POST', path: '/v1/gpu/preflight', category: 'gpu', description: 'Run GPU preflight checks before deploy.' },
  { method: 'GET', path: '/v1/gpu/offers', category: 'gpu', description: 'Query current GPU market offers.' },
  { method: 'GET', path: '/v1/gpu/types', category: 'gpu', description: 'List supported GPU types.' },
  { method: 'GET', path: '/v1/gpu/catalog', category: 'gpu', description: 'GPU catalog and model compatibility metadata.' },
  { method: 'GET', path: '/v1/gpu/compatibility', category: 'gpu', description: 'GPU compatibility matrix.' },
  { method: 'GET', path: '/v1/gpu/reputation', category: 'gpu', description: 'GPU host/provider reputation scores.' },
  { method: 'GET', path: '/v1/gpu/my-location', category: 'gpu', description: 'Caller geolocation for latency scoring.' },
  { method: 'GET', path: '/v1/gpu/readiness/status', category: 'gpu', description: 'GPU readiness benchmarking status.' },
  { method: 'GET', path: '/v1/gpu/readiness/history', category: 'gpu', description: 'GPU readiness history.' },
  { method: 'POST', path: '/v1/gpu/readiness/reset', category: 'gpu', description: 'Reset GPU readiness benchmark state.' },
  { method: 'POST', path: '/v1/gpu/snapshot', category: 'gpu', description: 'Create a GPU snapshot.', destructive: true },
  { method: 'GET', path: '/v1/gpu/snapshot', category: 'gpu', description: 'List GPU snapshots.' },
  { method: 'POST', path: '/v1/gpu/snapshot/restore', category: 'gpu', description: 'Restore a GPU snapshot.', destructive: true },
  { method: 'DELETE', path: '/v1/gpu/snapshot', category: 'gpu', description: 'Delete a GPU snapshot.', destructive: true },
  { method: 'POST', path: '/v1/gpu/heartbeat', category: 'gpu', description: 'GPU pod heartbeat.' },
  { method: 'GET', path: '/v1/gpu/sweep', category: 'gpu', description: 'Sweep idle pods.' },
  { method: 'POST', path: '/v1/gpu/orphan-sweep', category: 'gpu', description: 'Terminate untracked gateway-owned instances.', destructive: true },
  { method: 'GET', path: '/v1/gpu/cost-audit', category: 'gpu', description: 'Audit GPU spend leaks.' },
  { method: 'GET', path: '/v1/gpu/lifecycle-logs', category: 'gpu', description: 'GPU lifecycle logs.' },
  { method: 'GET', path: '/v1/gpu/latency/settings', category: 'gpu', description: 'Latency test settings.' },
  { method: 'PATCH', path: '/v1/gpu/latency/settings', category: 'gpu', description: 'Update latency test settings.' },
  { method: 'POST', path: '/v1/gpu/latency/run', category: 'gpu', description: 'Trigger latency benchmark run.' },
  { method: 'PATCH', path: '/v1/gpu/latency/hosts', category: 'gpu', description: 'Update latency host list.' },
  { method: 'GET', path: '/v1/gpu/latency/hosts', category: 'gpu', description: 'List host latency data.' },
  { method: 'POST', path: '/v1/gpu/latency/probe', category: 'gpu', description: 'Probe host latency.' },
  { method: 'GET', path: '/v1/canary/status', category: 'gpu', description: 'Canary deployment status.' },
  { method: 'GET', path: '/v1/performance', category: 'observability', description: 'Performance profiling stats.' },
  { method: 'POST', path: '/v1/gpu/finetune/plan', category: 'fine-tuning', description: 'Plan fine-tuning before GPU spend.' },
  { method: 'POST', path: '/v1/gpu/finetune', category: 'fine-tuning', description: 'Start a fine-tuning job.', destructive: true },
  { method: 'GET', path: '/v1/gpu/finetune/status', category: 'fine-tuning', description: 'Read fine-tuning job status.' },
  { method: 'GET', path: '/v1/gpu/finetune/logs', category: 'fine-tuning', description: 'Read fine-tuning job logs.' },
  { method: 'POST', path: '/v1/gpu/finetune/cancel', category: 'fine-tuning', description: 'Cancel a fine-tuning job and clean up its GPU.', destructive: true },
  { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset', category: 'fine-tuning', description: 'Plan or run Kokoro dataset generation.' },
  { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset/plan', category: 'fine-tuning', description: 'Plan Kokoro dataset generation.' },
  { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset/run', category: 'fine-tuning', description: 'Run Kokoro dataset generation.', destructive: true },
  { method: 'GET', path: '/v1/gpu/vast/templates', category: 'vast', description: 'List Vast.ai templates.' },
  { method: 'POST', path: '/v1/gpu/vast/templates', category: 'vast', description: 'Create Vast.ai template.', destructive: true },
  { method: 'PUT', path: '/v1/gpu/vast/templates', category: 'vast', description: 'Update Vast.ai template.', destructive: true },
  { method: 'DELETE', path: '/v1/gpu/vast/templates', category: 'vast', description: 'Delete Vast.ai template.', destructive: true },
  { method: 'POST', path: '/v1/gpu/vast/templates/find-or-create', category: 'vast', description: 'Find or create Vast.ai template.', destructive: true },
  { method: 'GET', path: '/v1/gpu/vast/endpoints', category: 'vast', description: 'List Vast.ai serverless endpoints.' },
  { method: 'POST', path: '/v1/gpu/vast/endpoints', category: 'vast', description: 'Create Vast.ai serverless endpoint.', destructive: true },
  { method: 'DELETE', path: '/v1/gpu/vast/endpoints', category: 'vast', description: 'Delete Vast.ai serverless endpoint.', destructive: true },
  { method: 'POST', path: '/v1/gpu/vast/endpoints/logs', category: 'vast', description: 'Fetch Vast.ai serverless endpoint logs.' },
  { method: 'POST', path: '/v1/gpu/vast/endpoints/route', category: 'vast', description: 'Route traffic to a Vast.ai endpoint.' },
  { method: 'GET', path: '/v1/gpu/vast/workergroups', category: 'vast', description: 'List Vast.ai worker groups.' },
  { method: 'POST', path: '/v1/gpu/vast/workergroups', category: 'vast', description: 'Create Vast.ai worker group.', destructive: true },
  { method: 'PUT', path: '/v1/gpu/vast/workergroups', category: 'vast', description: 'Update Vast.ai worker group.', destructive: true },
  { method: 'DELETE', path: '/v1/gpu/vast/workergroups', category: 'vast', description: 'Delete Vast.ai worker group.', destructive: true },
  { method: 'GET', path: '/v1/config/providers', category: 'config', description: 'Read provider configuration.' },
  { method: 'POST', path: '/v1/config/providers', category: 'config', description: 'Update provider configuration.', destructive: true },
  { method: 'GET', path: '/v1/config/api-keys', category: 'config', description: 'Read configured API key status with masked values.' },
  { method: 'POST', path: '/v1/config/api-keys', category: 'config', description: 'Set provider API keys.', destructive: true },
  { method: 'POST', path: '/v1/config/profiles', category: 'config', description: 'Create an app/profile.', destructive: true },
  { method: 'DELETE', path: '/v1/config/profiles', category: 'config', description: 'Delete an app/profile.', destructive: true },
  { method: 'POST', path: '/v1/config/profiles/activate', category: 'config', description: 'Activate an app/profile.', destructive: true },
  { method: 'GET', path: '/v1/config/labs', category: 'config', description: 'Read labs flags.' },
  { method: 'POST', path: '/v1/config/labs', category: 'config', description: 'Update labs flags.', destructive: true },
  { method: 'GET', path: '/v1/apps', category: 'apps', description: 'List registered apps.' },
  { method: 'POST', path: '/v1/apps', category: 'apps', description: 'Register an app.', destructive: true },
  { method: 'POST', path: '/v1/bot/deploy', category: 'bots', description: 'Deploy a meeting bot.', destructive: true },
  { method: 'GET', path: '/v1/bot/status', category: 'bots', description: 'Read meeting bot status.' },
  { method: 'POST', path: '/v1/bot/join', category: 'bots', description: 'Join a meeting.', destructive: true },
  { method: 'POST', path: '/v1/bot/leave', category: 'bots', description: 'Leave a meeting.', destructive: true },
  { method: 'POST', path: '/v1/bot/terminate', category: 'bots', description: 'Terminate a bot.', destructive: true },
  { method: 'POST', path: '/v1/bot/stream-page', category: 'bots', description: 'Stream a web page into the meeting.', destructive: true },
  { method: 'POST', path: '/v1/bot/stop-stream', category: 'bots', description: 'Stop page streaming.', destructive: true },
  { method: 'GET', path: '/v1/bot/stream-status', category: 'bots', description: 'Page stream status.' },
  { method: 'POST', path: '/v1/bot/avatar/speak', category: 'bots', description: 'Make the bot avatar speak.' },
  { method: 'POST', path: '/v1/bot/avatar/animate-word', category: 'bots', description: 'Animate an avatar word.' },
  { method: 'POST', path: '/v1/bot/avatar/mood', category: 'bots', description: 'Set avatar mood.' },
  { method: 'GET', path: '/v1/bot/avatar/status', category: 'bots', description: 'Read avatar status.' },
  { method: 'GET', path: '/v1/docker/auth/me', category: 'images', description: 'Read current Docker builder GitHub user.' },
  { method: 'POST', path: '/v1/docker/auth', category: 'images', description: 'Start GitHub OAuth device flow.', destructive: true },
  { method: 'GET', path: '/v1/docker/auth/status', category: 'images', description: 'Poll GitHub OAuth device flow status.' },
  { method: 'DELETE', path: '/v1/docker/auth', category: 'images', description: 'Revoke Docker builder auth.', destructive: true },
  { method: 'POST', path: '/v1/docker/build', category: 'images', description: 'Start Docker image build.', destructive: true },
  { method: 'GET', path: '/v1/docker/builds', category: 'images', description: 'List Docker image builds.' },
  { method: 'GET', path: '/v1/docker/images', category: 'images', description: 'List ready Docker images.' },
  { method: 'GET', path: '/v1/docker/inspect', category: 'images', description: 'Inspect a Docker image.' },
  { method: 'POST', path: '/v1/docker/inspect', category: 'images', description: 'Inspect a Docker image.' },
  { method: 'GET', path: '/v1/docker-inspect', category: 'images', description: 'Docker inspect alias.' },
  { method: 'POST', path: '/v1/docker-inspect', category: 'images', description: 'Docker inspect alias.' },
  { method: 'GET', path: '/v1/workloads', category: 'compute', description: 'List workloads.' },
  { method: 'POST', path: '/v1/workloads', category: 'compute', description: 'Launch a workload.', destructive: true },
  { method: 'GET', path: '/v1/requests/log', category: 'observability', description: 'Request log.' },
  { method: 'GET', path: '/v1/service-stats', category: 'observability', description: 'Service statistics.' },
  { method: 'GET', path: '/metrics', category: 'observability', description: 'Prometheus metrics.' },
  { method: 'GET', path: '/v1/observability/turn-latency', category: 'observability', description: 'Recent turn latency records.' },
  { method: 'GET', path: '/v1/observability/turns', category: 'observability', description: 'Recent turn records.' },
  { method: 'GET', path: '/v1/observability/mute-state', category: 'observability', description: 'Bot mute strategy state.' },
  { method: 'POST', path: '/v1/observability/mute-state', category: 'observability', description: 'Update bot mute strategy.', destructive: true },
  { method: 'GET', path: '/v1/observability/otlp/status', category: 'observability', description: 'OTLP exporter status.' },
  { method: 'POST', path: '/v1/observability/otlp/flush', category: 'observability', description: 'Flush OTLP exporter.' },
  { method: 'GET', path: '/v1/errors/summary', category: 'observability', description: 'Error summary.' },
  { method: 'GET', path: '/v1/errors/alerts', category: 'observability', description: 'Error alerts.' },
  { method: 'POST', path: '/v1/errors/alerts/acknowledge', category: 'observability', description: 'Acknowledge error alerts.', destructive: true },
  { method: 'POST', path: '/v1/tools/dispatch', category: 'tools', description: 'Dispatch an internal AI Gateway tool.' },
  { method: 'POST', path: '/v1/agent/heartbeat', category: 'observability', description: 'GPU agent heartbeat.' },
  { method: 'GET', path: '/v1/agent/state', category: 'observability', description: 'GPU agent state.' },
  { method: 'POST', path: '/v1/benchmark/paths', category: 'observability', description: 'Full path benchmark.' },
  { method: 'POST', path: '/v1/benchmark/realtime', category: 'observability', description: 'Realtime TTFC benchmark.' },
  { method: 'GET', path: '/v1/diagnostics/scores', category: 'observability', description: 'Diagnostic scorecard.' },
  { method: 'POST', path: '/v1/diagnostics/cleanup', category: 'observability', description: 'Diagnostics cleanup.', destructive: true },
  { method: 'POST', path: '/v1/diagnostics/benchmark', category: 'observability', description: 'Diagnostics benchmark.' },
  { method: 'GET', path: '/v1/lightning/status', category: 'lightning', description: 'Lightning AI Studio status.' },
  { method: 'POST', path: '/v1/lightning/start', category: 'lightning', description: 'Start Lightning AI Studio.', destructive: true },
  { method: 'POST', path: '/v1/lightning/stop', category: 'lightning', description: 'Stop Lightning AI Studio.', destructive: true },
  { method: 'POST', path: '/v1/lightning/session/start', category: 'lightning', description: 'Start Lightning session.', destructive: true },
  { method: 'POST', path: '/v1/lightning/session/end', category: 'lightning', description: 'End Lightning session.', destructive: true },
];

const DYNAMIC_ENDPOINTS = [
  { method: 'GET', pattern: /^\/v1\/apps\/[^/]+$/, category: 'apps', description: 'Read app by name.' },
  { method: 'DELETE', pattern: /^\/v1\/apps\/[^/]+$/, category: 'apps', description: 'Delete app by name.', destructive: true },
  { method: 'GET', pattern: /^\/v1\/docker\/builds\/[^/]+$/, category: 'images', description: 'Read Docker build by ID.' },
  { method: 'GET', pattern: /^\/v1\/workloads\/[^/]+$/, category: 'compute', description: 'Read workload status.' },
  { method: 'DELETE', pattern: /^\/v1\/workloads\/[^/]+$/, category: 'compute', description: 'Terminate workload.', destructive: true },
  { method: 'POST', pattern: /^\/v1\/workloads\/[^/]+\/stop$/, category: 'compute', description: 'Stop workload.', destructive: true },
  { method: 'POST', pattern: /^\/v1\/workloads\/[^/]+\/start$/, category: 'compute', description: 'Start workload.', destructive: true },
  { method: 'POST', pattern: /^\/v1\/gpu\/snapshot\/[^/]+\/restore$/, category: 'gpu', description: 'Restore snapshot by ID.', destructive: true },
  { method: 'DELETE', pattern: /^\/v1\/gpu\/snapshot\/[^/]+$/, category: 'gpu', description: 'Delete snapshot by ID.', destructive: true },
];

const gatewayRequestSchema = {
  type: 'object',
  required: ['method', 'path'],
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', minLength: 1, description: 'Gateway path, for example /v1/gpu/status or /v1/gpu/finetune/plan.' },
    query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    body: { type: 'object', additionalProperties: true },
    bodyBase64: { type: 'string', description: 'Optional raw request body encoded as base64 for binary or multipart calls.' },
    contentType: { type: 'string', description: 'Content-Type for bodyBase64 or body. Defaults to application/json for JSON body.' },
  },
  additionalProperties: false,
};

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const bodySchema = { type: 'object', required: ['body'], properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false };
const optionalBodySchema = { type: 'object', properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false };
const querySchema = { type: 'object', properties: { query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } } }, additionalProperties: false };
const fixedGatewayRequestSchema = {
  type: 'object',
  properties: {
    query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    body: { type: 'object', additionalProperties: true },
    bodyBase64: { type: 'string', description: 'Optional raw request body encoded as base64 for binary or multipart calls.' },
    contentType: { type: 'string', description: 'Content-Type for bodyBase64 or body.' },
  },
  additionalProperties: false,
};

const canonicalTools = [
  {
    name: 'gateway.health',
    title: 'Gateway Health',
    description: 'Return basic AI Gateway MCP/server health.',
    inputSchema: emptySchema,
  },
  {
    name: 'gateway.endpoints.list',
    title: 'List Gateway Endpoints',
    description: 'List AI Gateway HTTP capabilities by canonical category.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CANONICAL_CATEGORIES, description: 'Optional canonical category filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gateway.request',
    title: 'Gateway Request',
    description: 'Call any allowlisted AI Gateway HTTP endpoint with the same Bearer auth as this MCP request.',
    inputSchema: gatewayRequestSchema,
  },
  { name: 'models.list', title: 'List Models', description: 'List OpenAI-compatible models exposed by AI Gateway.', inputSchema: emptySchema },
  {
    name: 'chat.complete',
    title: 'Chat Completion',
    description: 'Run a non-streaming chat completion through AI Gateway providers.',
    inputSchema: {
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', minLength: 1 },
        prompt: { type: 'string', minLength: 1 },
        system: { type: 'string' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxTokens: { type: 'integer', minimum: 1, maximum: 4096 },
      },
      additionalProperties: false,
    },
  },
  { name: 'audio.transcribe', title: 'Transcribe Audio', description: 'Transcribe audio via /v1/transcribe.', inputSchema: fixedGatewayRequestSchema },
  { name: 'audio.synthesize', title: 'Synthesize Audio', description: 'Synthesize speech audio via /v1/audio/speech.', inputSchema: bodySchema },
  { name: 'audio.voices.list', title: 'List Voices', description: 'List available TTS voices.', inputSchema: emptySchema },
  { name: 'speech.translate', title: 'Translate Speech', description: 'Run the full speech pipeline.', inputSchema: bodySchema },
  { name: 'images.generate', title: 'Generate Image', description: 'Generate images through gateway image routing.', inputSchema: bodySchema },
  { name: 'images.inpaint', title: 'Inpaint Image', description: 'Inpaint images through gateway image routing.', inputSchema: fixedGatewayRequestSchema },
  { name: 'video.generate', title: 'Generate Video', description: 'Generate video through configured GPU/video backend.', inputSchema: bodySchema },
  { name: 'threeD.generate', title: 'Generate 3D Asset', description: 'Generate a 3D asset via TRELLIS.2 upstream.', inputSchema: fixedGatewayRequestSchema },
  { name: 'gpu.status', title: 'GPU Status', description: 'Read current GPU deploy status.', inputSchema: emptySchema },
  { name: 'gpu.offers.list', title: 'GPU Offers', description: 'Query GPU market offers.', inputSchema: querySchema },
  { name: 'gpu.deploy.validate', title: 'Validate GPU Deploy', description: 'Validate GPU deploy without spending money.', inputSchema: bodySchema },
  { name: 'gpu.deploy.create', title: 'Create GPU Deploy', description: 'Deploy a GPU instance through the gateway lifecycle.', inputSchema: bodySchema },
  { name: 'gpu.deploy.stop', title: 'Stop GPU Deploy', description: 'Stop the active GPU instance.', inputSchema: optionalBodySchema },
  { name: 'gpu.deploy.resume', title: 'Resume GPU Deploy', description: 'Resume a stopped GPU instance.', inputSchema: optionalBodySchema },
  { name: 'gpu.deploy.terminate', title: 'Terminate GPU Deploy', description: 'Terminate a GPU instance.', inputSchema: optionalBodySchema },
  { name: 'fineTunes.plan', title: 'Plan Fine-Tune', description: 'Plan a fine-tuning job before GPU spend.', inputSchema: bodySchema },
  { name: 'fineTunes.create', title: 'Create Fine-Tune', description: 'Start a fine-tuning job.', inputSchema: bodySchema },
  {
    name: 'fineTunes.get',
    title: 'Get Fine-Tune',
    description: 'Read fine-tuning job status. Omitting jobId returns the latest visible job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, tail: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: 'fineTunes.logs',
    title: 'Fine-Tune Logs',
    description: 'Read fine-tuning logs. Omitting jobId returns the latest visible job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, tail: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
  { name: 'fineTunes.cancel', title: 'Cancel Fine-Tune', description: 'Cancel a fine-tuning job and clean up its GPU.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, additionalProperties: false } },
  { name: 'datasets.kokoro.plan', title: 'Plan Kokoro Dataset', description: 'Plan CPU fanout dataset generation for Kokoro fine-tuning.', inputSchema: optionalBodySchema },
  { name: 'datasets.kokoro.run', title: 'Run Kokoro Dataset', description: 'Run approved CPU fanout dataset generation for Kokoro fine-tuning.', inputSchema: optionalBodySchema },
  { name: 'bots.status', title: 'Bot Status', description: 'Read meeting bot status.', inputSchema: emptySchema },
  { name: 'bots.deploy', title: 'Deploy Bot', description: 'Deploy a meeting bot.', inputSchema: bodySchema },
  { name: 'bots.join', title: 'Join Meeting', description: 'Join a meeting.', inputSchema: bodySchema },
  { name: 'bots.leave', title: 'Leave Meeting', description: 'Leave a meeting.', inputSchema: optionalBodySchema },
  { name: 'dockerImages.list', title: 'List Docker Images', description: 'List ready Docker images.', inputSchema: emptySchema },
  { name: 'dockerImages.builds.list', title: 'List Docker Builds', description: 'List Docker image builds.', inputSchema: emptySchema },
  { name: 'dockerImages.build.create', title: 'Create Docker Build', description: 'Start a Docker image build.', inputSchema: bodySchema },
  { name: 'workloads.list', title: 'List Workloads', description: 'List workloads.', inputSchema: emptySchema },
  { name: 'workloads.create', title: 'Create Workload', description: 'Launch a workload.', inputSchema: bodySchema },
  { name: 'config.providers.get', title: 'Get Provider Config', description: 'Read provider configuration.', inputSchema: emptySchema },
  { name: 'config.providers.update', title: 'Update Provider Config', description: 'Update provider configuration.', inputSchema: bodySchema },
  { name: 'config.apiKeys.get', title: 'Get API Key Status', description: 'Read configured provider API key status with masked values.', inputSchema: emptySchema },
  { name: 'config.apiKeys.set', title: 'Set API Keys', description: 'Set provider API keys.', inputSchema: bodySchema },
  { name: 'observability.metrics', title: 'Prometheus Metrics', description: 'Read Prometheus metrics.', inputSchema: emptySchema },
  { name: 'observability.requests', title: 'Request Log', description: 'Read request log.', inputSchema: emptySchema },
  { name: 'observability.serviceStats', title: 'Service Stats', description: 'Read service statistics.', inputSchema: emptySchema },
  { name: 'diagnostics.scores', title: 'Diagnostic Scores', description: 'Read diagnostic scorecard.', inputSchema: emptySchema },
  { name: 'diagnostics.benchmark', title: 'Diagnostics Benchmark', description: 'Run diagnostics benchmark.', inputSchema: optionalBodySchema },
];

const legacyTools = [
  {
    name: 'gateway_health',
    title: 'Gateway Health',
    description: 'Deprecated alias for gateway.health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_gateway_endpoints',
    title: 'List Gateway Endpoints',
    description: 'Deprecated alias for gateway.endpoints.list.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter such as inference, gpu, fine-tuning, config, bots, compute, images, observability.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gateway_request',
    title: 'Gateway Request',
    description: 'Deprecated alias for gateway.request.',
    inputSchema: gatewayRequestSchema,
  },
  {
    name: 'list_models',
    title: 'List Models',
    description: 'Deprecated alias for models.list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'chat_completion',
    title: 'Chat Completion',
    description: 'Deprecated alias for chat.complete.',
    inputSchema: {
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', minLength: 1, description: 'Gateway model ID, for example llama-3.1-8b-instant' },
        prompt: { type: 'string', minLength: 1, description: 'User prompt to send to the selected model' },
        system: { type: 'string', description: 'Optional system instruction' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxTokens: { type: 'integer', minimum: 1, maximum: 4096 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gpu_status',
    title: 'GPU Status',
    description: 'Deprecated alias for gpu.status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gpu_offers',
    title: 'GPU Offers',
    description: 'Deprecated alias for gpu.offers.list.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } } },
      additionalProperties: false,
    },
  },
  {
    name: 'gpu_deploy_validate',
    title: 'Validate GPU Deploy',
    description: 'Deprecated alias for gpu.deploy.validate.',
    inputSchema: { type: 'object', required: ['body'], properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false },
  },
  {
    name: 'finetune_plan',
    title: 'Fine-Tune Plan',
    description: 'Deprecated alias for fineTunes.plan.',
    inputSchema: { type: 'object', required: ['body'], properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false },
  },
  {
    name: 'finetune_start',
    title: 'Start Fine-Tune',
    description: 'Deprecated alias for fineTunes.create.',
    inputSchema: { type: 'object', required: ['body'], properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false },
  },
  {
    name: 'finetune_status',
    title: 'Fine-Tune Status',
    description: 'Deprecated alias for fineTunes.get.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        tail: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'finetune_logs',
    title: 'Fine-Tune Logs',
    description: 'Deprecated alias for fineTunes.logs.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        tail: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'finetune_cancel',
    title: 'Cancel Fine-Tune',
    description: 'Deprecated alias for fineTunes.cancel.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'kokoro_dataset_plan',
    title: 'Kokoro Dataset Plan',
    description: 'Deprecated alias for datasets.kokoro.plan.',
    inputSchema: { type: 'object', properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false },
  },
  {
    name: 'kokoro_dataset_run',
    title: 'Run Kokoro Dataset',
    description: 'Deprecated alias for datasets.kokoro.run.',
    inputSchema: { type: 'object', properties: { body: { type: 'object', additionalProperties: true } }, additionalProperties: false },
  },
];

const tools = [...canonicalTools, ...legacyTools.map((tool) => ({
  ...tool,
  annotations: { deprecated: true },
}))];

const TOOL_ALIASES: Record<string, string> = {
  gateway_health: 'gateway.health',
  list_gateway_endpoints: 'gateway.endpoints.list',
  gateway_request: 'gateway.request',
  list_models: 'models.list',
  chat_completion: 'chat.complete',
  gpu_status: 'gpu.status',
  gpu_offers: 'gpu.offers.list',
  gpu_deploy_validate: 'gpu.deploy.validate',
  finetune_plan: 'fineTunes.plan',
  finetune_start: 'fineTunes.create',
  finetune_status: 'fineTunes.get',
  finetune_logs: 'fineTunes.logs',
  finetune_cancel: 'fineTunes.cancel',
  kokoro_dataset_plan: 'datasets.kokoro.plan',
  kokoro_dataset_run: 'datasets.kokoro.run',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function result(id: JsonRpcRequest['id'], value: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function textContent(text: string, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text }],
  };
}

function jsonTextContent(value: unknown, isError = false) {
  return textContent(JSON.stringify(value, null, 2), isError);
}

class McpHttpError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(status: number, code: number, message: string) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = Number(process.env.MCP_MAX_BODY_BYTES || DEFAULT_MCP_MAX_BODY_BYTES);
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new McpHttpError(413, -32600, `MCP request body too large (limit: ${maxBytes} bytes)`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function objectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizePath(path: string): string {
  if (/^https?:\/\//i.test(path)) throw new Error('path must be a gateway path, not a URL');
  if (path.startsWith('//')) throw new Error('path must be a gateway path, not a protocol-relative URL');
  const parsed = new URL(path.startsWith('/') ? path : `/${path}`, 'http://mcp.local');
  const normalized = parsed.pathname || '/';
  for (const segment of normalized.split('/')) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* findEndpoint will reject malformed paths */ }
    if (decoded === '..') throw new Error('path must not contain .. segments');
  }
  return normalized;
}

function findEndpoint(method: string, path: string) {
  const upper = method.toUpperCase();
  const exact = GATEWAY_ENDPOINTS.find((endpoint) => endpoint.method === upper && endpoint.path === path);
  if (exact) return exact;
  return DYNAMIC_ENDPOINTS.find((endpoint) => endpoint.method === upper && endpoint.pattern.test(path));
}

function canonicalCategoryForPath(pathOrPattern: string, fallback: string): string {
  if (pathOrPattern === '/health') return 'gateway';
  if (pathOrPattern === '/v1/models' || pathOrPattern.includes('/v1/playground/catalog')) return 'models';
  if (pathOrPattern.includes('/v1/chat/') || pathOrPattern.includes('/v1/playground/llm')) return 'chat';
  if (
    pathOrPattern.includes('/v1/transcribe') ||
    pathOrPattern.includes('/v1/audio/') ||
    pathOrPattern.includes('/v1/tts') ||
    pathOrPattern.includes('/v1/playground/stt') ||
    pathOrPattern.includes('/v1/playground/tts')
  ) return 'audio';
  if (
    pathOrPattern === '/v1/speech' ||
    pathOrPattern.includes('/v1/translate') ||
    pathOrPattern.includes('/v1/detect-language') ||
    pathOrPattern.includes('/v1/playground/pipeline')
  ) return 'speech';
  if (pathOrPattern.includes('/v1/images')) return 'images';
  if (pathOrPattern.includes('/v1/video')) return 'video';
  if (pathOrPattern.includes('/v1/3d')) return 'threeD';
  if (pathOrPattern.includes('/v1/gpu/finetune/kokoro-dataset')) return 'datasets';
  if (pathOrPattern.includes('/v1/gpu/finetune')) return 'fineTunes';
  if (pathOrPattern.includes('/v1/gpu/') || pathOrPattern.includes('/v1/canary')) return 'gpu';
  if (pathOrPattern.includes('/v1/bot/')) return 'bots';
  if (pathOrPattern.includes('/v1/docker')) return 'dockerImages';
  if (pathOrPattern.includes('/v1/workloads')) return 'workloads';
  if (pathOrPattern.includes('/v1/config') || pathOrPattern.includes('/v1/apps')) return 'config';
  if (pathOrPattern.includes('/v1/diagnostics')) return 'diagnostics';
  if (
    pathOrPattern === '/metrics' ||
    pathOrPattern.includes('/v1/observability') ||
    pathOrPattern.includes('/v1/requests') ||
    pathOrPattern.includes('/v1/service-stats') ||
    pathOrPattern.includes('/v1/errors') ||
    pathOrPattern.includes('/v1/agent') ||
    pathOrPattern.includes('/v1/benchmark') ||
    pathOrPattern.includes('/v1/performance') ||
    pathOrPattern.includes('/v1/analytics')
  ) return 'observability';
  if (fallback === 'compute') return 'workloads';
  if (fallback === 'images') return 'dockerImages';
  if (fallback === 'fine-tuning') return 'fineTunes';
  if (fallback === 'system') return 'gateway';
  if (fallback === 'apps') return 'config';
  if (fallback === 'vast') return 'gpu';
  if (fallback === 'routing') return 'gateway';
  if (fallback === 'playground') return 'gateway';
  if (fallback === 'tools') return 'diagnostics';
  if (fallback === 'lightning') return 'workloads';
  return fallback;
}

function endpointList(category?: string) {
  const exact = GATEWAY_ENDPOINTS
    .map((endpoint) => ({ ...endpoint, category: canonicalCategoryForPath(endpoint.path, endpoint.category) }))
    .filter((endpoint) => !category || endpoint.category === category);
  const dynamic = DYNAMIC_ENDPOINTS
    .map((endpoint) => ({
      method: endpoint.method,
      pathPattern: String(endpoint.pattern),
      category: canonicalCategoryForPath(String(endpoint.pattern), endpoint.category),
      description: endpoint.description,
      destructive: endpoint.destructive === true,
    }))
    .filter((endpoint) => !category || endpoint.category === category);
  return { categories: CANONICAL_CATEGORIES, endpoints: exact, dynamicEndpoints: dynamic };
}

function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      url.searchParams.set(key, String(value));
    }
  }
}

function normalizeGpuOffersQuery(query: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!query) return undefined;
  const normalized = { ...query };
  if (normalized.gpuTypes === undefined || normalized.gpuTypes === null || normalized.gpuTypes === '') {
    const alias = normalized.gpu ?? normalized.gpuType ?? normalized.gpuName;
    if (['string', 'number'].includes(typeof alias)) normalized.gpuTypes = alias;
  }
  return normalized;
}

function localBaseUrl(req: IncomingMessage, options: GatewayMcpOptions): string {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '');
  const port = req.socket.localPort || Number(process.env.PORT || 4000);
  return `http://127.0.0.1:${port}`;
}

function decodeBase64Arg(value: string): ArrayBuffer {
  const normalized = value.replace(/\s+/g, '');
  const validBase64 = normalized.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(normalized) &&
    !/=.*[^=]/.test(normalized);
  if (!validBase64) {
    throw new Error('bodyBase64 must be valid base64');
  }
  const decoded = Buffer.from(normalized, 'base64');
  const copy = new Uint8Array(decoded.length);
  copy.set(decoded);
  return copy.buffer;
}

function gatewayFailurePayload(endpoint: ReturnType<typeof findEndpoint>, path: string, method: string, message: string) {
  return {
    endpoint,
    status: 0,
    ok: false,
    method,
    path,
    error: {
      message,
      type: 'gateway_request_error',
    },
  };
}

async function gatewayRequest(req: IncomingMessage, args: Record<string, unknown>, options: GatewayMcpOptions) {
  const method = stringArg(args, 'method').toUpperCase();
  const rawPath = stringArg(args, 'path');
  const path = normalizePath(rawPath);
  const endpoint = findEndpoint(method, path);
  if (!endpoint) {
    throw new Error(`Endpoint is not exposed through MCP: ${method} ${path}`);
  }

  const query = optionalObjectArg(args, 'query');
  const url = new URL(path, localBaseUrl(req, options));
  if (rawPath.includes('?')) {
    const rawUrl = new URL(rawPath, 'http://mcp.local');
    rawUrl.searchParams.forEach((value, key) => url.searchParams.set(key, value));
  }
  appendQuery(url, query);

  const headers: Record<string, string> = {};
  const auth = req.headers.authorization;
  if (typeof auth === 'string') headers.Authorization = auth;

  let body: Blob | string | undefined;
  const bodyBase64 = args.bodyBase64;
  if (typeof bodyBase64 === 'string') {
    body = new Blob([decodeBase64Arg(bodyBase64)]);
    headers['Content-Type'] = typeof args.contentType === 'string' ? args.contentType : 'application/octet-stream';
  } else if (args.body !== undefined) {
    body = JSON.stringify(args.body);
    headers['Content-Type'] = typeof args.contentType === 'string' ? args.contentType : 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'DELETE' ? undefined : body,
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS),
    });
  } catch (fetchError) {
    const message = fetchError instanceof Error ? fetchError.message : 'Gateway request failed';
    return jsonTextContent(gatewayFailurePayload(endpoint, path, method, message), true);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const buffer = Buffer.from(await response.arrayBuffer());
  let responseBody: unknown = buffer.toString('utf8');
  if (contentType.includes('application/json')) {
    try { responseBody = JSON.parse(buffer.toString('utf8')); } catch { /* keep text */ }
  } else if (!/^text\//.test(contentType) && buffer.length > 0) {
    responseBody = { base64: buffer.toString('base64'), bytes: buffer.length };
  }

  return jsonTextContent({
    endpoint,
    status: response.status,
    ok: response.ok,
    contentType,
    body: responseBody,
  }, !response.ok);
}

async function callGateway(req: IncomingMessage, method: string, path: string, options: GatewayMcpOptions, body?: Record<string, unknown>, query?: Record<string, unknown>) {
  return gatewayRequest(req, {
    method,
    path,
    ...(body ? { body } : {}),
    ...(query ? { query } : {}),
  }, options);
}

async function callFixedGateway(req: IncomingMessage, method: string, path: string, options: GatewayMcpOptions, args: Record<string, unknown>) {
  return gatewayRequest(req, {
    ...args,
    method,
    path,
  }, options);
}

async function callTool(name: string, args: Record<string, unknown>, req: IncomingMessage, options: GatewayMcpOptions) {
  const toolName = TOOL_ALIASES[name] ?? name;

  if (toolName === 'gateway.health') {
    return jsonTextContent({
      status: 'ok',
      service: 'ai-gateway-mcp',
      exposedEndpoints: GATEWAY_ENDPOINTS.length + DYNAMIC_ENDPOINTS.length,
    });
  }

  if (toolName === 'gateway.endpoints.list') {
    const category = typeof args.category === 'string' ? args.category : undefined;
    return jsonTextContent(endpointList(category));
  }

  if (toolName === 'gateway.request') {
    return gatewayRequest(req, args, options);
  }

  if (toolName === 'models.list') {
    const response = await handleModelsWithDynamic(options.providers);
    return jsonTextContent(response.body, response.status >= 400);
  }

  if (toolName === 'chat.complete') {
    const model = stringArg(args, 'model');
    const prompt = stringArg(args, 'prompt');
    const system = typeof args.system === 'string' ? args.system : undefined;
    const temperature = typeof args.temperature === 'number' ? args.temperature : undefined;
    const maxTokens = typeof args.maxTokens === 'number' ? args.maxTokens : undefined;
    const messages = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user' as const, content: prompt },
    ];
    const proxyRequest: ProxyRequest = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      rawBody: Buffer.alloc(0),
      body: { model, messages, temperature, max_tokens: maxTokens, stream: false },
    };
    const response = await handleChatCompletions(
      proxyRequest,
      options.providers.chat ?? {},
      undefined,
      undefined,
      options.providers.chatFallbackChain,
      undefined,
      options.providers.chatDynamicRoutes,
    );
    return jsonTextContent(response.body, response.status >= 400);
  }

  if (toolName === 'audio.transcribe') return callFixedGateway(req, 'POST', '/v1/transcribe', options, args);
  if (toolName === 'audio.synthesize') return callGateway(req, 'POST', '/v1/audio/speech', options, objectArg(args, 'body'));
  if (toolName === 'audio.voices.list') return callGateway(req, 'GET', '/v1/tts/voices', options);
  if (toolName === 'speech.translate') return callGateway(req, 'POST', '/v1/speech', options, objectArg(args, 'body'));
  if (toolName === 'images.generate') return callGateway(req, 'POST', '/v1/images/generate', options, objectArg(args, 'body'));
  if (toolName === 'images.inpaint') return callFixedGateway(req, 'POST', '/v1/images/inpaint', options, args);
  if (toolName === 'video.generate') return callGateway(req, 'POST', '/v1/video/generate', options, objectArg(args, 'body'));
  if (toolName === 'threeD.generate') return callFixedGateway(req, 'POST', '/v1/3d/generate', options, args);
  if (toolName === 'gpu.status') return callGateway(req, 'GET', '/v1/gpu/status', options);
  if (toolName === 'gpu.offers.list') return callGateway(req, 'GET', '/v1/gpu/offers', options, undefined, normalizeGpuOffersQuery(optionalObjectArg(args, 'query')));
  if (toolName === 'gpu.deploy.validate') return callGateway(req, 'POST', '/v1/gpu/deploy/validate', options, objectArg(args, 'body'));
  if (toolName === 'gpu.deploy.create') return callGateway(req, 'POST', '/v1/gpu/deploy', options, objectArg(args, 'body'));
  if (toolName === 'gpu.deploy.stop') return callGateway(req, 'POST', '/v1/gpu/stop', options, optionalObjectArg(args, 'body') ?? {});
  if (toolName === 'gpu.deploy.resume') return callGateway(req, 'POST', '/v1/gpu/resume', options, optionalObjectArg(args, 'body') ?? {});
  if (toolName === 'gpu.deploy.terminate') return callGateway(req, 'POST', '/v1/gpu/terminate', options, optionalObjectArg(args, 'body') ?? {});
  if (toolName === 'fineTunes.plan') return callGateway(req, 'POST', '/v1/gpu/finetune/plan', options, objectArg(args, 'body'));
  if (toolName === 'fineTunes.create') return callGateway(req, 'POST', '/v1/gpu/finetune', options, objectArg(args, 'body'));
  if (toolName === 'fineTunes.get') {
    return callGateway(req, 'GET', '/v1/gpu/finetune/status', options, undefined, {
      ...(typeof args.jobId === 'string' ? { jobId: args.jobId } : {}),
      ...(typeof args.tail === 'number' ? { tail: args.tail } : {}),
    });
  }
  if (toolName === 'fineTunes.logs') {
    return callGateway(req, 'GET', '/v1/gpu/finetune/logs', options, undefined, {
      ...(typeof args.jobId === 'string' ? { jobId: args.jobId } : {}),
      ...(typeof args.tail === 'number' ? { tail: args.tail } : {}),
    });
  }
  if (toolName === 'fineTunes.cancel') {
    return callGateway(req, 'POST', '/v1/gpu/finetune/cancel', options, {
      ...(typeof args.jobId === 'string' ? { jobId: args.jobId } : {}),
    });
  }
  if (toolName === 'datasets.kokoro.plan') return callGateway(req, 'POST', '/v1/gpu/finetune/kokoro-dataset/plan', options, optionalObjectArg(args, 'body') ?? {});
  if (toolName === 'datasets.kokoro.run') return callGateway(req, 'POST', '/v1/gpu/finetune/kokoro-dataset/run', options, optionalObjectArg(args, 'body') ?? {});
  if (toolName === 'bots.status') return callGateway(req, 'GET', '/v1/bot/status', options);
  if (toolName === 'bots.deploy') return callGateway(req, 'POST', '/v1/bot/deploy', options, objectArg(args, 'body'));
  if (toolName === 'bots.join') return callGateway(req, 'POST', '/v1/bot/join', options, objectArg(args, 'body'));
  if (toolName === 'bots.leave') return callGateway(req, 'POST', '/v1/bot/leave', options, optionalObjectArg(args, 'body') ?? {});
  if (toolName === 'dockerImages.list') return callGateway(req, 'GET', '/v1/docker/images', options);
  if (toolName === 'dockerImages.builds.list') return callGateway(req, 'GET', '/v1/docker/builds', options);
  if (toolName === 'dockerImages.build.create') return callGateway(req, 'POST', '/v1/docker/build', options, objectArg(args, 'body'));
  if (toolName === 'workloads.list') return callGateway(req, 'GET', '/v1/workloads', options);
  if (toolName === 'workloads.create') return callGateway(req, 'POST', '/v1/workloads', options, objectArg(args, 'body'));
  if (toolName === 'config.providers.get') return callGateway(req, 'GET', '/v1/config/providers', options);
  if (toolName === 'config.providers.update') return callGateway(req, 'POST', '/v1/config/providers', options, objectArg(args, 'body'));
  if (toolName === 'config.apiKeys.get') return callGateway(req, 'GET', '/v1/config/api-keys', options);
  if (toolName === 'config.apiKeys.set') return callGateway(req, 'POST', '/v1/config/api-keys', options, objectArg(args, 'body'));
  if (toolName === 'observability.metrics') return callGateway(req, 'GET', '/metrics', options);
  if (toolName === 'observability.requests') return callGateway(req, 'GET', '/v1/requests/log', options);
  if (toolName === 'observability.serviceStats') return callGateway(req, 'GET', '/v1/service-stats', options);
  if (toolName === 'diagnostics.scores') return callGateway(req, 'GET', '/v1/diagnostics/scores', options);
  if (toolName === 'diagnostics.benchmark') return callGateway(req, 'POST', '/v1/diagnostics/benchmark', options, optionalObjectArg(args, 'body') ?? {});

  throw new Error(`Unknown tool: ${name}`);
}

async function handleSingleMessage(message: JsonRpcRequest, req: IncomingMessage, options: GatewayMcpOptions) {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return error(message.id, -32600, 'Invalid JSON-RPC request');
  }

  if (message.method === 'initialize') {
    return result(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: options.name ?? 'ai-gateway',
        version: options.version ?? '1.0.0',
      },
    });
  }

  if (message.method === 'tools/list') {
    return result(message.id, { tools });
  }

  if (message.method === 'tools/call') {
    if (message.params !== undefined && !isRecord(message.params)) {
      return error(message.id, -32602, 'params must be an object');
    }
    const params = message.params ?? {};
    const name = params.name;
    if (typeof name !== 'string') return error(message.id, -32602, 'params.name must be a string');
    if (params.arguments !== undefined && !isRecord(params.arguments)) {
      return error(message.id, -32602, 'params.arguments must be an object');
    }
    const args = params.arguments ?? {};
    try {
      return result(message.id, await callTool(name, args, req, options));
    } catch (toolError) {
      const messageText = toolError instanceof Error ? toolError.message : 'Tool failed';
      return result(message.id, {
        isError: true,
        content: [{ type: 'text', text: messageText }],
      });
    }
  }

  if (message.id === undefined || message.id === null) {
    return null;
  }
  return error(message.id, -32601, `Method not found: ${message.method}`);
}

export function createGatewayMcpHandler(options: GatewayMcpOptions) {
  return async function handleGatewayMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, error(null, -32000, 'MCP endpoint accepts POST requests only.'));
      return;
    }

    try {
      const payload = await readJson(req);
      if (Array.isArray(payload) && payload.length === 0) {
        sendJson(res, 400, error(null, -32600, 'Invalid JSON-RPC batch'));
        return;
      }
      const messages = Array.isArray(payload) ? payload : [payload];
      const responses = [];
      for (const item of messages) {
        if (!item || typeof item !== 'object') {
          responses.push(error(null, -32600, 'Invalid JSON-RPC request'));
          continue;
        }
        const response = await handleSingleMessage(item as JsonRpcRequest, req, options);
        if (response) responses.push(response);
      }

      if (responses.length === 0) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, Array.isArray(payload) ? responses : responses[0]);
    } catch (parseError) {
      if (parseError instanceof McpHttpError) {
        sendJson(res, parseError.status, error(null, parseError.code, parseError.message));
        return;
      }
      if (parseError instanceof SyntaxError) {
        sendJson(res, 400, error(null, -32700, 'Parse error'));
        return;
      }
      sendJson(res, 500, error(null, -32603, 'Internal MCP server error'));
    }
  };
}
