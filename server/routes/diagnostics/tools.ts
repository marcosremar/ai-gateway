/**
 * Tools discovery route — used by claudeme's aigateway-tools module to
 * inject the available gateway operations into the system prompt.
 *
 * Route:
 *   GET /api/tools  — returns { tools: AigatewayTool[] }
 *
 * The list is static (gateway operations don't change at runtime).
 * Claudeme caches the response for 5 min so this route is called at
 * most once per session.
 */

const TOOLS = [
  // GPU lifecycle
  { name: 'gpu_status',    category: 'gpu', description: 'Get status of the active GPU deploy (status, ssh, endpoint, step, message).' },
  { name: 'gpu_wait',      category: 'gpu', description: 'Block until active deploy is ready (polls /v1/gpu/status). Use after deploy instead of sleep loops.' },
  { name: 'gpu_deploy',    category: 'gpu', description: 'Deploy a Docker image to a GPU pod (POST /v1/gpu/deploy).' },
  { name: 'gpu_stop',      category: 'gpu', description: 'Pause the active pod, preserving disk (POST /v1/gpu/stop).' },
  { name: 'gpu_resume',    category: 'gpu', description: 'Resume a paused pod (POST /v1/gpu/resume).' },
  { name: 'gpu_terminate', category: 'gpu', description: 'Permanently destroy a pod (POST /v1/gpu/terminate).' },
  { name: 'gpu_list',      category: 'gpu', description: 'List all running pods across providers (GET /v1/gpu/list).' },
  { name: 'gpu_offers',    category: 'gpu', description: 'List available GPU offers from providers (GET /v1/gpu/offers).' },
  // Dev-mode (ai-gateway CLI)
  { name: 'gpu_dev_exec',     category: 'gpu-dev', description: 'Run a shell command inside the active dev pod via ai-gateway CLI. Use instead of raw SSH.' },
  { name: 'gpu_dev_sh',       category: 'gpu-dev', description: 'Open interactive SSH shell into dev pod via ai-gateway CLI.' },
  { name: 'gpu_dev_push',     category: 'gpu-dev', description: 'Upload a local file to the dev pod.' },
  { name: 'gpu_dev_pull',     category: 'gpu-dev', description: 'Download a file from the dev pod.' },
  { name: 'gpu_dev_snapshot', category: 'gpu-dev', description: 'Commit current pod state as a Docker image.' },
  { name: 'gpu_dev_serve',    category: 'gpu-dev', description: 'Tunnel a pod port to localhost.' },
  // Inference
  { name: 'inference_chat',    category: 'inference', description: 'Route a chat completion through the gateway (POST /v1/chat/completions).' },
  { name: 'inference_models',  category: 'inference', description: 'List available inference models (GET /v1/models).' },
] as const;

export function registerToolsRoutes(handlers: Record<string, Function>): void {
  handlers['GET /api/tools'] = (_req: unknown, res: any) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools: TOOLS }));
  };
}
