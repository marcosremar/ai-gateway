import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderCredentials, InstanceSpec } from '@ai-gateway/gpu-providers/types';

// Mock child_process before importing ModalClient
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: mockExec,
  execFile: mockExec,
}));
vi.mock('util', async () => {
  const actual = await vi.importActual('util');
  return {
    ...actual as object,
    promisify: () => mockExec,
  };
});

// Import after mocks
const { ModalClient } = await import('@ai-gateway/gpu-providers/modal-client');

const creds: ProviderCredentials = { apiKey: 'ak-abc123:ts-secret456' };

describe('ModalClient', () => {
  let client: InstanceType<typeof ModalClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ModalClient({ workspace: 'test-workspace' });
  });

  // ── Constants ────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('providerId is modal', () => {
      expect(client.providerId).toBe('modal');
    });

    it('bootTimeSecs is 10', () => {
      expect(client.bootTimeSecs).toBe(10);
    });
  });

  // ── discoverInstance ──────────────────────────────────────────────────

  describe('discoverInstance', () => {
    it('prefers running instance (has tasks)', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-1', Description: 'parle-ultralight', State: 'deployed', Tasks: '0' },
          { 'App ID': 'ap-2', Description: 'parle-other', State: 'deployed', Tasks: '3' },
        ]),
        stderr: '',
      });

      const result = await client.discoverInstance(creds, []);
      expect(result).not.toBeNull();
      expect(result!.instanceId).toBe('ap-2');
      expect(result!.status).toBe('running');
    });

    it('normalizes "deployed" to "running" when endpoint exists', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-3', Description: 'my-app', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await client.discoverInstance(creds, []);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('running');
    });

    it('filters by name when gpuTypes[0] provided', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-10', Description: 'parle-ultralight', State: 'deployed', Tasks: '0' },
          { 'App ID': 'ap-11', Description: 'other-app', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await client.discoverInstance(creds, ['parle-ultralight']);
      expect(result).not.toBeNull();
      expect(result!.instanceId).toBe('ap-10');
    });

    it('returns null when no matching instances', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([]),
        stderr: '',
      });

      expect(await client.discoverInstance(creds, [])).toBeNull();
    });
  });

  // ── createInstance ─────────────────────────────────────────────────────

  describe('createInstance', () => {
    it('requires dockerImage (deploy file path)', async () => {
      await expect(
        client.createInstance({ gpuTypes: [] }, creds),
      ).rejects.toThrow('requires spec.dockerImage');
    });

    it('deploys via modal deploy and returns instance', async () => {
      // Deploy command
      mockExec.mockResolvedValueOnce({
        stdout: 'Created web function web => https://test-workspace--parle-ultralight-web.modal.run',
        stderr: '',
      });
      // listInstances (JSON mode)
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-new', Description: 'parle-ultralight', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await client.createInstance(
        { gpuTypes: ['parle-ultralight'], dockerImage: 'modal_ultralight.py' },
        creds,
      );
      expect(result.status).toBe('deployed');
      expect(result.endpoint).toContain('modal.run');
    });

    it('builds fallback URL on deploy', async () => {
      // Deploy with no URL in output
      mockExec.mockResolvedValueOnce({
        stdout: 'App deployed successfully',
        stderr: '',
      });
      // listInstances
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([]),
        stderr: '',
      });

      const result = await client.createInstance(
        { gpuTypes: [], dockerImage: 'modal_test.py' },
        creds,
      );
      expect(result.endpoint).toContain('test-workspace');
      expect(result.endpoint).toContain('modal.run');
    });
  });

  // ── start/stop/deleteInstance ──────────────────────────────────────────

  describe('startInstance', () => {
    it('verifies app exists (via listInstances)', async () => {
      // listInstances → getInstanceStatus
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-x', Description: 'my-app', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      await expect(client.startInstance('ap-x', creds)).resolves.toBeUndefined();
    });

    it('throws if app not found', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([]),
        stderr: '',
      });

      await expect(client.startInstance('ap-missing', creds)).rejects.toThrow('not found');
    });
  });

  describe('stopInstance', () => {
    it('calls modal app stop', async () => {
      mockExec.mockResolvedValueOnce({ stdout: 'Stopped', stderr: '' });
      await client.stopInstance('ap-1', creds);
      expect(mockExec).toHaveBeenCalledWith(
        'python3',
        ['-m', 'modal', 'app', 'stop', 'ap-1'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('throws on CLI error', async () => {
      mockExec.mockRejectedValueOnce(new Error('Permission denied'));
      await expect(client.stopInstance('ap-1', creds)).rejects.toThrow('stop failed');
    });
  });

  describe('deleteInstance', () => {
    it('delegates to stopInstance', async () => {
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await client.deleteInstance('ap-1', creds);
      expect(mockExec).toHaveBeenCalledWith(
        'python3',
        expect.arrayContaining(['modal', 'app', 'stop', 'ap-1']),
        expect.anything(),
      );
    });
  });

  // ── listInstances ─────────────────────────────────────────────────────

  describe('listInstances', () => {
    it('parses JSON output', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-a', Description: 'app-a', State: 'deployed', Tasks: '2' },
          { 'App ID': 'ap-b', Description: 'app-b', State: 'stopped', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(2);
      expect(result[0].instanceId).toBe('ap-a');
      expect(result[0].status).toBe('running'); // tasks > 0
      expect(result[1].instanceId).toBe('ap-b');
      expect(result[1].status).toBe('stopped');
    });

    it('falls back to table output when --json fails', async () => {
      // First call (--json) fails
      mockExec.mockRejectedValueOnce(new Error('Unknown flag: --json'));
      // Second call (table output)
      mockExec.mockResolvedValueOnce({
        stdout: [
          '┌──────────────┬────────────────────┬──────────┬───────┐',
          '│ App ID       │ Description        │ State    │ Tasks │',
          '├──────────────┼────────────────────┼──────────┼───────┤',
          '│ ap-table1    │ table-app          │ deployed │ 0     │',
          '└──────────────┴────────────────────┴──────────┴───────┘',
        ].join('\n'),
        stderr: '',
      });

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(1);
      expect(result[0].instanceId).toBe('ap-table1');
      expect(result[0].instanceName).toBe('table-app');
    });

    it('returns empty on CLI error', async () => {
      mockExec.mockRejectedValueOnce(new Error('modal not found'));
      mockExec.mockRejectedValueOnce(new Error('modal not found'));

      const result = await client.listInstances(creds);
      expect(result).toEqual([]);
    });

    it('builds endpoint URLs for non-stopped apps', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-e', Description: 'my-app', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await client.listInstances(creds);
      expect(result[0].endpoint).toBe('https://test-workspace--my-app-web.modal.run');
    });

    it('normalizes numeric Modal app states from JSON output', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { app_id: 'ap-num', description: 'numeric-app', state: 3, n_running_tasks: 0 },
        ]),
        stderr: '',
      });

      const result = await client.listInstances(creds);
      expect(result[0].status).toBe('deployed');
      expect(result[0].endpoint).toBe('https://test-workspace--numeric-app-web.modal.run');
    });

    it('stopped apps have empty endpoint', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-s', Description: 'dead-app', State: 'stopped', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await client.listInstances(creds);
      expect(result[0].endpoint).toBe('');
    });
  });

  // ── getInstanceStatus ─────────────────────────────────────────────────

  describe('getInstanceStatus', () => {
    it('returns status from list', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-status', Description: 'test', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      expect(await client.getInstanceStatus('ap-status', creds)).toBe('deployed');
    });

    it('returns null when not found', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([]),
        stderr: '',
      });

      expect(await client.getInstanceStatus('ap-missing', creds)).toBeNull();
    });
  });

  // ── Workspace resolution ──────────────────────────────────────────────

  describe('workspace', () => {
    it('uses provided workspace', async () => {
      const c = new ModalClient({ workspace: 'my-ws' });
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { 'App ID': 'ap-1', Description: 'app', State: 'deployed', Tasks: '0' },
        ]),
        stderr: '',
      });

      const result = await c.listInstances(creds);
      expect(result[0].endpoint).toContain('my-ws');
    });
  });
});
