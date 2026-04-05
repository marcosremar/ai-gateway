/**
 * Spike Test: Sudden traffic spike to test resilience and recovery.
 *
 * Pattern: 10 VUs baseline → spike to 100 → back to 10
 * Tests circuit breaker recovery and degradation manager transitions.
 *
 * Run: k6 run load-testing/k6/spike.js
 * Or:  bun run test:k6:spike
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { GATEWAY_URL, headers, chatBody } from './config.js';

const serverErrors = new Counter('server_errors');

export const options = {
  stages: [
    { duration: '2m', target: 10 },   // baseline
    { duration: '30s', target: 100 },  // spike up
    { duration: '1m', target: 100 },   // sustain spike
    { duration: '30s', target: 10 },   // spike down
    { duration: '2m', target: 10 },    // recovery baseline
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.25'],       // allow up to 25% during spike
    server_errors: ['count<30'],           // but limit 5xx errors
    http_req_duration: ['p(95)<20000'],    // relaxed during spike
  },
};

export default function () {
  const res = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    chatBody(`Spike VU${__VU} iter${__ITER}: reply OK`, 5),
    { headers, timeout: '30s' },
  );

  check(res, {
    'status is not 5xx': (r) => r.status < 500,
    'status is 200': (r) => r.status === 200,
  });

  if (res.status >= 500) serverErrors.add(1);

  sleep(Math.random() * 1.5 + 0.5); // 0.5-2s think time
}
