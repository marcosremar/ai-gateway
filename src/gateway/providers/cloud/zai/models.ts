import type { ModelInfo } from '../types';

/**
 * Z.AI GLM model catalog.
 * Vision-capable models accept OpenAI-style multimodal `content` arrays
 * with `{ type: 'image_url', image_url: { url } }` parts.
 */
export const ZAI_LLM_MODELS: ModelInfo[] = [
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    description: 'Flagship 200K-context reasoning model with tool use (Z.AI)',
    capability: 'llm',
    isDefault: true,
    metadata: { maxContext: 200_000, supportsTools: true, supportsVision: false },
  },
  {
    id: 'glm-4.5',
    name: 'GLM-4.5',
    description: 'Previous-gen GLM text model (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 128_000, supportsTools: true, supportsVision: false },
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5 Air',
    description: 'Fast / cheap GLM variant for high-throughput tasks (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 128_000, supportsTools: true, supportsVision: false },
  },
  {
    id: 'glm-4.5v',
    name: 'GLM-4.5V',
    description: 'Vision-language model — accepts text + image_url inputs (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 64_000, supportsTools: true, supportsVision: true },
  },
  // The 4.7/5 family is text-only on the coding plan — multimodal payloads
  // return error 1210. Useful for high-throughput JSON / structured prompts
  // that don't need vision.
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    description: 'GLM-4.7 reasoning text model (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 200_000, supportsTools: true, supportsVision: false },
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    description: 'GLM-5 next-gen reasoning text model (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 200_000, supportsTools: true, supportsVision: false },
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5 Turbo',
    description: 'GLM-5 fast / cheap text variant (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 128_000, supportsTools: true, supportsVision: false },
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    description: 'GLM-5.1 text model (Z.AI)',
    capability: 'llm',
    metadata: { maxContext: 200_000, supportsTools: true, supportsVision: false },
  },
];

/** Subset of ZAI_LLM_MODELS that accept image inputs. */
export const ZAI_VISION_MODELS: ModelInfo[] = ZAI_LLM_MODELS.filter(
  (m) => (m.metadata as { supportsVision?: boolean } | undefined)?.supportsVision === true,
);
