/**
 * Ramp to 100 VUs: The main load test for 100 concurrent users.
 *
 * Stages: 0→20 (1min) → 50 (1min) → 100 (2min) → sustain 100 (5min) → ramp down (1min)
 *
 * Run: k6 run load-testing/k6/ramp-100.js
 * Or:  bun run test:k6:100
 *
 * With JSON output: k6 run --out json=load-testing/results/ramp-100.json load-testing/k6/ramp-100.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { GATEWAY_URL, headers, defaultThresholds, chatBody, translateBody } from './config.js';

// Custom metrics
const chatLatency = new Trend('chat_latency', true);
const translateLatency = new Trend('translate_latency', true);
const rateLimited = new Counter('rate_limited');
const serverErrors = new Counter('server_errors');

export const options = {
  stages: [
    { duration: '1m', target: 20 },   // ramp to 20
    { duration: '1m', target: 50 },   // ramp to 50
    { duration: '2m', target: 100 },  // ramp to 100
    { duration: '5m', target: 100 },  // sustain 100
    { duration: '1m', target: 0 },    // ramp down
  ],
  thresholds: {
    ...defaultThresholds,
    chat_latency: ['p(95)<15000'],
    translate_latency: ['p(95)<15000'],
    rate_limited: ['count<100'],
    server_errors: ['count<20'],
  },
};

export default function () {
  const vuId = __VU;
  const scenario = vuId % 3; // distribute across endpoints

  if (scenario === 0 || scenario === 1) {
    // 66% chat requests
    const res = http.post(
      `${GATEWAY_URL}/v1/chat/completions`,
      chatBody(`VU${vuId}: reply OK`, 5),
      { headers, timeout: '30s' },
    );

    chatLatency.add(res.timings.duration);

    check(res, {
      'chat: status 200': (r) => r.status === 200,
      'chat: has content': (r) => {
        try { return JSON.parse(r.body).choices[0].message.content.length > 0; } catch { return false; }
      },
    });

    if (res.status === 429) rateLimited.add(1);
    if (res.status >= 500) serverErrors.add(1);

  } else {
    // 33% translation requests
    const res = http.post(
      `${GATEWAY_URL}/v1/chat/completions`,
      translateBody(`Bonjour le monde VU${vuId}`),
      { headers, timeout: '30s' },
    );

    translateLatency.add(res.timings.duration);

    check(res, {
      'translate: status 200': (r) => r.status === 200,
    });

    if (res.status === 429) rateLimited.add(1);
    if (res.status >= 500) serverErrors.add(1);
  }

  sleep(Math.random() * 2 + 1); // 1-3s think time between requests
}
