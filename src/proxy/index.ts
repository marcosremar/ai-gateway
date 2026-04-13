export { createProxyServer, startProxy } from './server';
export { validateAuth } from './middleware/auth';
export { RateLimiter } from './middleware/rate-limit';
export {
  RequestCoalescer,
  coalesce,
  coalesceInflightCount,
} from './middleware/request-coalescer';
export type { ProxyConfig, ProviderMapping, ProxyRequest, ProxyResponse, ProxyRoute } from './types';
