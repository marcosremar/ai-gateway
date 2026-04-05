/**
 * Soak Test: Sustained moderate load to detect memory leaks and degradation.
 *
 * 30 VUs for 15 minutes with periodic health checks.
 *
 * Run: k6 run load-testing/k6/soak.js
 * Or:  bun run test:k6:soak
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { GATEWAY_URL, headers, chatBody } from './config.js';

const chatLatency = new Trend('chat_latency', true);
const healthFailures = new Counter('health_failures');

export const options = {
  stages: [
    { duration: '1m', target: 30 },    // ramp up
    { duration: '15m', target: 30 },   // sustain
    { duration: '1m', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.15'],
    chat_latency: ['p(95)<15000'],
    health_failures: ['count<5'],
    http_req_duration: ['p(95)<15000', 'p(99)<25000'],
  },
};

export default function () {
  const vuId = __VU;

  // Every 10th iteration per VU, do a health check instead
  if (__ITER % 10 === 0) {
    const health = http.get(`${GATEWAY_URL}/health`, { headers, timeout: '10s' });
    const healthy = check(health, {
      'health: status 200': (r) => r.status === 200,
    });
    if (!healthy) healthFailures.add(1);
    sleep(1);
    return;
  }

  // Normal chat request
  const res = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    chatBody(`Soak VU${vuId} iter${__ITER}: reply OK`, 5),
    { headers, timeout: '30s' },
  );

  chatLatency.add(res.timings.duration);

  check(res, {
    'chat: status 200': (r) => r.status === 200,
    'chat: not 5xx': (r) => r.status < 500,
  });

  sleep(Math.random() * 2 + 1); // 1-3s think time
}
