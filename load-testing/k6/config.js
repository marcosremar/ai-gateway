/**
 * Shared k6 configuration for all load test scenarios.
 */

export const GATEWAY_URL = __ENV.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
export const GATEWAY_API_KEY = __ENV.GATEWAY_API_KEY || 'gw_loadtest_2026';

export const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GATEWAY_API_KEY}`,
};

/** Standard pass/fail thresholds */
export const defaultThresholds = {
  http_req_duration: ['p(95)<10000', 'p(99)<20000'],  // p95 < 10s, p99 < 20s
  http_req_failed: ['rate<0.15'],                       // <15% error rate
  http_reqs: ['rate>1'],                                // >1 req/s throughput
};

/** Strict thresholds for smoke tests */
export const smokeThresholds = {
  http_req_duration: ['p(95)<5000'],
  http_req_failed: ['rate<0.05'],
};

/** Chat completion request body */
export function chatBody(msg, maxTokens = 5) {
  return JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: msg }],
    max_tokens: maxTokens,
  });
}

/** Translation via chat */
export function translateBody(text, source = 'fr', target = 'en') {
  return JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `Translate from ${source} to ${target}. Reply only with the translation.` },
      { role: 'user', content: text },
    ],
    max_tokens: 100,
  });
}
