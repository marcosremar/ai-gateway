/**
 * Z.AI (Zhipu) Provider — LLM (text + vision).
 * OpenAI-compatible API at https://api.z.ai/api/paas/v4
 * Models: GLM-4.6 (text), GLM-4.5V (vision), GLM-4.5, GLM-4.5-Air.
 */

import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';

// Default to the Coding-plan endpoint (bundled in subscription, includes
// GLM-4.6 + GLM-4.5V). The pay-per-use PaaS endpoint is at /api/paas/v4 and
// requires account balance — opt in via ZAI_API_BASE.
const BASE_URL = process.env.ZAI_API_BASE || 'https://api.z.ai/api/coding/paas/v4';

export const zaiLLM = new OpenAICompatLLMProvider({
  providerId: 'zai',
  baseURL: BASE_URL,
  envKey: 'ZAI_API_KEY',
  defaultModel: process.env.ZAI_DEFAULT_MODEL || 'glm-4.6',
});

export { ZAI_LLM_MODELS, ZAI_VISION_MODELS } from './models';
