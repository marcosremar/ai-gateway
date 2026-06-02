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

export { GatewaySDK } from './client';
export {
  GatewayError,
  type GatewayConfig,
  type TranscribeResponse,
  type TranslateResponse,
  type PipelineResponse,
  type PipelineOptions,
  type GpuStatus,
  type DeployOptions,
  type DeployResponse,
  type FinetuneGateConfig,
  type FinetuneR2Config,
  type FinetuneHfSyncConfig,
  type FinetuneJobOptions,
  type FinetuneJobResponse,
  type FinetuneJobStatus,
} from './types';
