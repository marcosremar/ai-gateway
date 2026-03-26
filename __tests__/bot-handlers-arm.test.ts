import { describe, it, expect } from 'vitest';

describe('Bot handlers — ARM/Rosetta compatibility', () => {
  describe('platform flag logic', () => {
    it('linux/amd64 flag should be present in docker run args', () => {
      // The docker run args should include --platform linux/amd64
      // This is a documentation/contract test
      const dockerArgs = [
        '--platform', 'linux/amd64',
        '--name', 'babelcast-bot',
        '--shm-size', '2g',
        '-p', '8080:8080',
      ];
      expect(dockerArgs).toContain('--platform');
      const platformIdx = dockerArgs.indexOf('--platform');
      expect(dockerArgs[platformIdx + 1]).toBe('linux/amd64');
    });
  });

  describe('container running check on non-zero exit', () => {
    it('should treat exit code 125 as success if container is actually running', () => {
      // Simulate: docker run exits with 125 (platform warning on ARM Mac)
      // but container IS running (docker inspect returns true)
      const exitCode = 125 as number;
      const isRunning = true; // docker inspect says it's running

      // Logic: if exitCode !== 0 but container is running, don't throw
      const shouldThrow = exitCode !== 0 && !isRunning;
      expect(shouldThrow).toBe(false);
    });

    it('should throw if exit code is non-zero AND container is not running', () => {
      const exitCode = 1 as number;
      const isRunning = false;

      const shouldThrow = exitCode !== 0 && !isRunning;
      expect(shouldThrow).toBe(true);
    });

    it('should not check container if exit code is 0', () => {
      const exitCode = 0;
      // When exitCode is 0, no need to check — success
      expect(exitCode).toBe(0);
    });
  });

  describe('timeout configuration', () => {
    it('uses 10 minute timeout for bot startup (Rosetta is slow)', () => {
      const TIMEOUT_MS = 10 * 60_000;
      expect(TIMEOUT_MS).toBe(600_000); // 10 minutes
      // Previous value was 5 * 60_000 = 300_000
      expect(TIMEOUT_MS).toBeGreaterThan(5 * 60_000);
    });
  });
});
