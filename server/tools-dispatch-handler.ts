// ── Tool dispatch HTTP handler ──────────────────────────────────────────────
// POST /v1/tools/dispatch
//
// Body:
//   {
//     assistantMessage: { role: 'assistant', content: [
//       { type: 'tool_use', id, name, input },
//       ...
//     ] },
//     tools: [
//       // HTTP webhook tool — POSTs `input` as JSON, returns response text
//       { name: 'foo', kind: 'webhook', url: 'https://example.com/foo', timeoutMs?: 30000 },
//       // Echo tool (testing): returns the input verbatim as JSON string
//       { name: 'echo', kind: 'echo' },
//       // Inline tool — server-side closure (cannot be passed via HTTP body;
//       // only registered programmatically — kept for completeness)
//     ]
//   }
//
// Response:
//   {
//     toolMessage: { role: 'tool', content: [...tool_result blocks] } | null,
//     invoked: number,
//     errors: number,
//     timings: [{name, ms, ok}, ...]
//   }
//
// SSRF guard: webhook URLs validated against private/metadata ranges.

import type { IncomingMessage, ServerResponse } from 'http';
import { ToolDispatcher, type ToolHandler, type Message } from '../src/llm-context';
import { isPrivateUrlResolved } from '../src/gateway/pipeline/ssrf-protection';
import { makeBuiltin, listBuiltinTools, type BuiltinContext } from './tools-builtin';

type DispatchTool =
  | { name: string; kind: 'webhook'; url: string; timeoutMs?: number; headers?: Record<string, string> }
  | { name: string; kind: 'echo' }
  | { name: string; kind: 'builtin'; builtin: string };

/** Default builtin context — no read_file dirs allowed, conservative byte cap. */
const DEFAULT_BUILTIN_CTX: BuiltinContext = {
  allowedReadDirs: [],
  maxBytes: 256 * 1024,
};

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer | string) => { raw += chunk.toString(); });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  return raw;
}

export async function handleToolsDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: { assistantMessage?: Message; tools?: DispatchTool[] };
  try {
    const raw = await readBody(req);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!parsed.assistantMessage || parsed.assistantMessage.role !== 'assistant') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'assistantMessage with role:"assistant" required' }));
    return;
  }

  if (!Array.isArray(parsed.tools)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'tools array required' }));
    return;
  }

  // Build handlers from declarations.
  const handlers: ToolHandler[] = [];
  for (const t of parsed.tools) {
    if (t.kind === 'echo') {
      handlers.push({
        name: t.name,
        invoke: async (input) => JSON.stringify(input),
      });
      continue;
    }
    if (t.kind === 'builtin') {
      const handler = makeBuiltin(t.builtin, DEFAULT_BUILTIN_CTX);
      if (!handler) {
        const builtinName = t.builtin;
        handlers.push({
          name: t.name,
          invoke: async () => { throw new Error(`unknown builtin "${builtinName}"; available: ${listBuiltinTools().join(', ')}`); },
        });
        continue;
      }
      handlers.push({ ...handler, name: t.name });
      continue;
    }
    if (t.kind === 'webhook') {
      // SSRF guard — webhook URL is caller-supplied; reject private targets.
      if (await isPrivateUrlResolved(t.url)) {
        // Register a handler that always errors so the dispatcher reports it.
        const url = t.url;
        handlers.push({
          name: t.name,
          invoke: async () => { throw new Error(`webhook url ${url} resolves to a private/internal address (SSRF blocked)`); },
        });
        continue;
      }
      const url = t.url;
      const timeoutMs = t.timeoutMs ?? 30_000;
      const headers = t.headers ?? {};
      handlers.push({
        name: t.name,
        timeoutMs,
        invoke: async (input, ctx) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(input),
            signal: ctx.signal,
          });
          if (!response.ok) {
            const txt = await response.text().catch(() => '');
            throw new Error(`webhook ${response.status}: ${txt.slice(0, 200)}`);
          }
          return await response.text();
        },
      });
      continue;
    }
  }

  const dispatcher = new ToolDispatcher(handlers);
  const result = await dispatcher.run(parsed.assistantMessage);
  const toolMessage = dispatcher.resultsAsMessage(result);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    toolMessage,
    invoked: result.invoked,
    errors: result.errors,
    timings: result.timings,
  }));
}
