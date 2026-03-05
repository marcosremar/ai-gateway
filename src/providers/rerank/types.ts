/**
 * Reranking provider types.
 */

export interface RerankRequest {
  query: string;
  documents: string[];
  model?: string;
  topN?: number;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
  document?: string;
}

export interface RerankResponse {
  results: RerankResult[];
  model: string;
}

export interface RerankProvider {
  readonly name: string;
  rerank(req: RerankRequest): Promise<RerankResponse>;
  isConfigured(): boolean;
}
