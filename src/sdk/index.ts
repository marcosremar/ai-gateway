/**
 * @deprecated Legacy, kept until the next major. Use `GatewayClient` from `@parle/ai-gateway/client` (sdk/node/gateway-client.ts) for HTTP, and `@parle/ai-gateway/voice` (sdk/browser/voice) in the browser.
 *
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
} from './types';
