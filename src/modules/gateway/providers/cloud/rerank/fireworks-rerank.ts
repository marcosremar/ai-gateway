/**
 * Fireworks Reranking Provider — direct HTTP.
 */

import type { RerankProvider, RerankRequest, RerankResponse } from './types';

const DEFAULT_MODEL = 'accounts/fireworks/models/rerank-v1';

export class FireworksRerankProvider implements RerankProvider {
  readonly name = 'Fireworks Rerank';
  private readonly envKey = 'FIREWORKS_API_KEY';

  isConfigured(): boolean {
    return !!process.env[this.envKey];
  }

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    const apiKey = process.env[this.envKey];
    if (!apiKey) throw new Error(`[Fireworks Rerank] ${this.envKey} is not set`);

    const model = req.model || DEFAULT_MODEL;
    const response = await fetch('https://api.fireworks.ai/inference/v1/rerank', {
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
      throw new Error(`[Fireworks Rerank] ${response.status}: ${text}`);
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

export const fireworksRerank = new FireworksRerankProvider();
