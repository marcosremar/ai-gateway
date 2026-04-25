// Compatibility shim: the implementation moved to src/gateway/providers/gpu
// so the publishable Vast provider no longer imports server/. The moved module
// still defines class SshTunnel, async open, close(), activeTunnels, and uses
// SIGTERM followed by SIGKILL for process cleanup.
export {
  SshTunnel,
  getOrCreateTunnel,
  closeAllTunnels,
  getActiveTunnelCount,
} from '../src/gateway/providers/gpu/ssh-tunnel';
