/**
 * Bot Handlers — Modular Implementation
 *
 * Split from the original 1,271-line bot-handlers.ts into focused modules:
 * - bot-shared.ts: Constants, state utilities, helpers
 * - bot-deploy.ts: Pod deployment, cleanup, termination
 * - bot-meeting.ts: Join, leave, watchdog, idle shutdown
 * - bot-audio-pull.ts: WebSocket audio relay from cloud bot
 * - bot-proxy.ts: Status, streaming proxy, debug proxy
 */

// Shared constants and utilities
export { isPrivateUrl, isPrivateUrlResolved } from '../../ai-handlers';
export {
  BOT_POD_PREFIX,
  BOT_DOCKER_IMAGE,
  BOT_PORTS,
  BOT_LOCAL_CONTAINER,
  BOT_IDLE_SHUTDOWN_MS,
  setBotState,
  redactMeetingUrl,
  botHeaders,
} from './bot-shared';

// Deploy
export {
  cleanupBotPods,
  autoDeployBot,
  handleBotDeploy,
  handleBotTerminate,
} from './bot-deploy';

// Meeting
export {
  clearBotIdleTimer,
  scheduleBotIdleShutdown,
  handleBotJoin,
  handleBotLeave,
} from './bot-meeting';

// Audio Pull
export {
  startBotAudioPull,
  stopBotAudioPull,
} from './bot-audio-pull';

// Proxy
export {
  handleBotStatus,
  handleBotStreamPage,
  handleBotStopStream,
  handleBotStreamStatus,
  handleBotProxyBinary,
  handleBotProxy,
} from './bot-proxy';
