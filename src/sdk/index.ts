/**
 * @ai-gateway/sdk — HTTP SDK for consuming the BabelCast AI Gateway REST API.
 *
 * TypeScript client:
 *   import { GatewaySDK } from '@ai-gateway/sdk';
 *   const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
 *
 * Python client (mirror):
 *   from gateway_sdk import GatewaySDK
 *   gw = GatewaySDK(base_url="http://localhost:4000")
 */

export {
  GatewaySDK,
  // Pure, testable helpers also usable standalone.
  resolveBaseUrlFromEnv,
  parseMetrics,
  generateRequestId,
  isRetryableNetworkError,
  parseGatewayErrorBody,
  validatePollOptions,
  classifyGpuPollState,
  type PrometheusSample,
  type PollOptions,
} from './client';
export {
  GatewayError,
  type GatewayConfig,
  type TranscribeResponse,
  type TranslateResponse,
  type PipelineResponse,
  type PipelineOptions,
  type PipelineTiming,
  type GpuStatus,
  type DeployOptions,
  type DeployResponse,
} from './types';
