// Bug: autoTerminateGpu reads deployState AFTER resetDeployState() clears it
// After reset, deployState.deployId and deployState.gpuType are empty strings,
// so error categorization and event emission lose the original deploy context.

import { test, expect } from 'bun:test';

test('autoTerminateGpu should capture deployId before resetDeployState clears it', async () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../server/gpu-terminate.ts'),
    'utf-8'
  );

  // Find the standalone resetDeployState() call (not import)
  const lines = source.split('\n');
  let resetLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'resetDeployState();') {
      resetLineIdx = i;
      break;
    }
  }
  expect(resetLineIdx).toBeGreaterThan(0);

  // Check that deployId is captured before the reset call
  const beforeReset = lines.slice(0, resetLineIdx).join('\n');
  expect(beforeReset).toContain('deployState.deployId');
});

test('autoTerminateGpu should capture gpuType before resetDeployState clears it', async () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../server/gpu-terminate.ts'),
    'utf-8'
  );

  const lines = source.split('\n');
  let resetLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'resetDeployState();') {
      resetLineIdx = i;
      break;
    }
  }
  const beforeReset = lines.slice(0, resetLineIdx).join('\n');
  expect(beforeReset).toContain('deployState.gpuType');
});

test('autoTerminateGpu should use captured locals in error handlers after reset', async () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../server/gpu-terminate.ts'),
    'utf-8'
  );

  const lines = source.split('\n');
  let resetLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'resetDeployState();') {
      resetLineIdx = i;
      break;
    }
  }
  const afterReset = lines.slice(resetLineIdx).join('\n');

  // After resetDeployState, should NOT reference deployState.deployId in
  // categorizeDeployError — must use the captured local
  expect(afterReset).not.toContain('deployId: deployState.deployId');
  expect(afterReset).not.toContain('gpuType: deployState.gpuType');
});
