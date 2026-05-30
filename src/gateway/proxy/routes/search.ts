import type { ProxyRequest, ProxyResponse } from '../types';

export async function handleSearch(req: ProxyRequest, searxngUrl?: string, searxngUser?: string, searxngPassword?: string): Promise<ProxyResponse> {
  const baseUrl = searxngUrl || process.env.SEARXNG_URL || '';
  const user = searxngUser || process.env.SEARXNG_USER || '';
  const password = searxngPassword || process.env.SEARXNG_PASSWORD || '';

  if (!baseUrl) {
    return { status: 404, body: { error: { message: 'Search not configured (SEARXNG_URL not set)', type: 'invalid_request_error' } } };
  }

  const body = req.body as Record<string, unknown> | null;
  const params = req.url.includes('?') ? new URL(req.url, 'http://localhost').searchParams : new URLSearchParams();

  const query = (body?.query as string) || params.get('q') || params.get('query') || '';
  if (!query) {
    return { status: 400, body: { error: { message: 'query parameter is required', type: 'invalid_request_error' } } };
  }

  const categories = (body?.categories as string) || params.get('categories') || undefined;
  const language = (body?.language as string) || params.get('language') || undefined;
  const maxResults = Number((body?.max_results as unknown) || params.get('max_results') || 10);

  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  if (categories) url.searchParams.set('categories', categories);
  if (language) url.searchParams.set('language', language);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (user && password) headers.Authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

  try {
    const res = await fetch(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { status: res.status, body: { error: { message: `SearXNG upstream error: ${txt.slice(0, 200)}`, type: 'upstream_error' } } };
    }
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    const results = (data.results || []).slice(0, maxResults).map((r: Record<string, unknown>) => ({
      title: (r.title as string) || '',
      url: (r.url as string) || '',
      snippet: String(r.content || '').slice(0, 300),
      engine: (r.engine as string) || '',
      score: (r.score as number) || 0,
    }));
    return {
      status: 200,
      body: { query, result_count: results.length, results },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 502, body: { error: { message: `Search failed: ${msg}`, type: 'upstream_error' } } };
  }
}
