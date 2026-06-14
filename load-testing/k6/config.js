/**
 * Shared k6 configuration for all load test scenarios.
 */

export const GATEWAY_URL = __ENV.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';

// No hardcoded default — never commit bearer tokens (#997). Provide the key at
// runtime: `k6 run -e GATEWAY_API_KEY=... smoke.js`.
export const GATEWAY_API_KEY = __ENV.GATEWAY_API_KEY || '';

if (!GATEWAY_API_KEY) {
  throw new Error(
    'GATEWAY_API_KEY is required. Pass it via the environment, e.g. ' +
      '`k6 run -e GATEWAY_API_KEY=<key> load-testing/k6/smoke.js`.',
  );
}

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
