/**
 * Smoke Test: Quick validation that all endpoints are responding.
 *
 * Run: k6 run load-testing/k6/smoke.js
 * Or:  bun run test:k6:smoke
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { GATEWAY_URL, headers, smokeThresholds, chatBody } from './config.js';

export const options = {
  vus: 3,
  duration: '30s',
  thresholds: smokeThresholds,
};

export default function () {
  // Health check
  const health = http.get(`${GATEWAY_URL}/health`, { headers, timeout: '10s' });
  check(health, {
    'health: status 200': (r) => r.status === 200,
    'health: is healthy': (r) => {
      try { return JSON.parse(r.body).status === 'ok'; } catch { return false; }
    },
  });

  sleep(0.5);

  // Chat completion
  const chat = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    chatBody('Reply with exactly: PONG'),
    { headers, timeout: '15s' },
  );
  check(chat, {
    'chat: status 200': (r) => r.status === 200,
    'chat: has content': (r) => {
      try { return JSON.parse(r.body).choices[0].message.content.length > 0; } catch { return false; }
    },
  });

  sleep(1);
}
