/**
 * OpenRouter Reranking Provider — direct HTTP (not OpenAI-compat).
 */

import type { RerankProvider, RerankRequest, RerankResponse } from './types';

const DEFAULT_MODEL = 'cohere/rerank-v3.5';

export class OpenRouterRerankProvider implements RerankProvider {
  readonly name = 'OpenRouter Rerank';
  private readonly envKey = 'OPENROUTER_API_KEY';

  isConfigured(): boolean {
    return !!process.env[this.envKey];
  }

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    const apiKey = process.env[this.envKey];
    if (!apiKey) throw new Error(`[OpenRouter Rerank] ${this.envKey} is not set`);

    const model = req.model || DEFAULT_MODEL;
    const response = await fetch('https://openrouter.ai/api/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        query: req.query,
        documents: req.documents,
        ...(req.topN !== undefined && { top_n: req.topN }),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`[OpenRouter Rerank] ${response.status}: ${text}`);
    }

    const data = await response.json() as {
      results: Array<{ index: number; relevance_score: number; document?: { text: string } }>;
      model: string;
    };

    return {
      results: data.results.map((r) => ({
        index: r.index,
        relevanceScore: r.relevance_score,
        document: r.document?.text,
      })),
      model: data.model || model,
    };
  }
}

export const openrouterRerank = new OpenRouterRerankProvider();
