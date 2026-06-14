/**
 * Optimization suite 09 — CLI / SDK / DX — WAVE 4.
 *
 * Fourth batch of localized, low-risk fixes from docs/optimizations/09-cli-sdk-dx.md
 * NOT covered by waves 1-3. All backed by pure helpers in `cli/cli-helpers.ts` and
 * `src/sdk/client.ts` so they unit-test without importing `bin/ai-gateway.ts`
 * (which runs `main()` at module load).
 *
 *   CLI helpers (cli/cli-helpers.ts):
 *     - #810  shell completion generation            (parseCompletionShell, generateCompletionScript)
 *     - #813  live TTS voices normaliser             (normalizeVoices)
 *     - #819  `media test` --json summary            (buildMediaTestSummary)
 *     - #820  native 16kHz silence WAV (no python3)  (makeSilenceWav)
 *     - #844  dedicated cost/spend summary           (buildCostSummary)
 *     - #848  idle/auto-stop reassurance note        (idleStopNote)
 *     - #849  zombie-pod cost annotation             (annotateZombieCost)
 *     - #850  sibling-binary discoverability         (listSiblingBinaries)
 *     - #891  scripting contract (exit codes + json) (describeScriptingContract)
 *     - #899  Ctrl-C clean-exit payload              (buildInterruptExit, EXIT_SIGINT)
 *     - #900  deploy poller timeout vs completion    (classifyDeployPollOutcome)
 *
 *   SDK (src/sdk/client.ts + types.ts):
 *     - #825  unified error normaliser               (normalizeGatewayError)
 *     - #831  streaming chat async-iterator          (parseSSEChunk, chatStream)
 *     - #832  workload pagination async-iterator     (listAllWorkloads)
 *     - #840  AbortSignal threaded through methods    (pipeline/chat signal)
 *     - #877  rich ensemble transcription result     (transcribeEnsemble)
 *
 * Unit-only — no network. `fetch` is mocked for the live SDK tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseCompletionShell,
  generateCompletionScript,
  normalizeVoices,
  buildMediaTestSummary,
  makeSilenceWav,
  buildCostSummary,
  idleStopNote,
  DEFAULT_IDLE_STOP_MIN,
  DEFAULT_AUTO_DESTROY_HOURS,
  annotateZombieCost,
  listSiblingBinaries,
  describeScriptingContract,
  buildInterruptExit,
  EXIT_SIGINT,
  classifyDeployPollOutcome,
  EXIT_USAGE,
  EXIT_RUNTIME,
} from '../../cli/cli-helpers';
import {
  GatewaySDK,
  parseSSEChunk,
  normalizeGatewayError,
} from '../../src/sdk/client';
import { GatewayError } from '../../src/sdk/types';

// ════════════════════════════════════════════════════════════════════════════
// CLI helpers (pure)
// ════════════════════════════════════════════════════════════════════════════

// ── #810: shell completion ────────────────────────────────────────────────────

describe('parseCompletionShell (#810)', () => {
  it('accepts bash/zsh/fish case-insensitively', () => {
    expect(parseCompletionShell('bash')).toEqual({ value: 'bash' });
    expect(parseCompletionShell('ZSH')).toEqual({ value: 'zsh' });
    expect(parseCompletionShell(' fish ')).toEqual({ value: 'fish' });
  });
  it('rejects unknown/empty shells', () => {
    expect('error' in parseCompletionShell('powershell')).toBe(true);
    expect('error' in parseCompletionShell(undefined)).toBe(true);
  });
});

describe('generateCompletionScript (#810)', () => {
  const cmds = ['chat', 'gpu', 'balance'];
  it('emits a bash complete -F script listing the commands', () => {
    const s = generateCompletionScript('bash', cmds);
    expect(s).toContain('complete -F');
    expect(s).toContain('chat gpu balance');
    expect(s).toContain('ai-gateway');
  });
  it('emits a zsh #compdef header and a fish per-command list', () => {
    expect(generateCompletionScript('zsh', cmds)).toContain('#compdef ai-gateway');
    const fish = generateCompletionScript('fish', cmds);
    expect(fish.split('\n')).toHaveLength(cmds.length);
    expect(fish).toContain("-a 'gpu'");
  });
  it('honours a custom program name', () => {
    expect(generateCompletionScript('bash', cmds, 'aigw')).toContain('complete -F _aigw aigw');
  });
});

// ── #813: live voices normaliser ──────────────────────────────────────────────

describe('normalizeVoices (#813)', () => {
  it('normalises object + string voices and de-dupes by id', () => {
    const v = normalizeVoices([
      { id: 'ryan', name: 'Ryan', language: 'English', gender: 'male' },
      'leah',
      { id: 'ryan', name: 'Ryan dup' }, // dup id dropped
      { name: 'Tara' },                  // id falls back to name
    ]);
    expect(v.map(x => x.id)).toEqual(['ryan', 'leah', 'Tara']);
    expect(v[0]).toEqual({ id: 'ryan', name: 'Ryan', language: 'English', gender: 'male' });
    expect(v[1]).toEqual({ id: 'leah', name: 'leah' });
  });
  it('returns [] for a missing/garbage payload (caller falls back)', () => {
    expect(normalizeVoices(undefined)).toEqual([]);
    expect(normalizeVoices({ not: 'an array' })).toEqual([]);
    expect(normalizeVoices([null, 42, ''])).toEqual([]);
  });
});

// ── #819: media test --json summary ───────────────────────────────────────────

describe('buildMediaTestSummary (#819)', () => {
  it('exit 0 + ok:true when both pass', () => {
    const r = buildMediaTestSummary({ image: true, audio: true });
    expect(r.json).toEqual({ image: true, audio: true, ok: true });
    expect(r.exitCode).toBe(0);
  });
  it('exit non-zero + ok:false when any fails', () => {
    const r = buildMediaTestSummary({ image: true, audio: false });
    expect(r.json.ok).toBe(false);
    expect(r.exitCode).toBe(EXIT_RUNTIME);
  });
});

// ── #820: native silence WAV ──────────────────────────────────────────────────

describe('makeSilenceWav (#820)', () => {
  it('produces a valid RIFF/WAVE header at the requested rate + length', () => {
    const wav = makeSilenceWav(1, 16_000);
    // 44-byte header + 16000 samples * 2 bytes
    expect(wav.length).toBe(44 + 16_000 * 2);
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...wav.slice(start, start + len));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(36, 4)).toBe('data');
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(dv.getUint16(20, true)).toBe(1);      // PCM
    expect(dv.getUint16(22, true)).toBe(1);      // mono
    expect(dv.getUint32(24, true)).toBe(16_000); // sample rate
    expect(dv.getUint16(34, true)).toBe(16);     // bits per sample
  });
  it('is pure silence (all sample bytes zero)', () => {
    const wav = makeSilenceWav(0.1, 8_000);
    expect(wav.slice(44).every(b => b === 0)).toBe(true);
  });
  it('falls back to sane defaults for bad input', () => {
    const wav = makeSilenceWav(-5, 0);
    expect(wav.length).toBe(44 + 16_000 * 2); // 1s @ 16kHz default
  });
});

// ── #844: cost / spend summary ────────────────────────────────────────────────

describe('buildCostSummary (#844)', () => {
  it('sums burn and projects daily/monthly', () => {
    const s = buildCostSummary({
      instanceHourly: [0.5, 0.25, 0],   // the 0 is ignored
      dailySpendUsd: 3.2,
      balances: { runpod: 10, vast: 5.5 },
    });
    expect(s.hourlyBurnUsd).toBe(0.75);
    expect(s.runningInstances).toBe(2);
    expect(s.projectedDailyUsd).toBe(18);   // 0.75 * 24
    expect(s.projectedMonthlyUsd).toBe(540); // 0.75 * 24 * 30
    expect(s.dailySpendUsd).toBe(3.2);
    expect(s.totalBalanceUsd).toBe(15.5);
  });
  it('handles no instances / no balances', () => {
    const s = buildCostSummary({ instanceHourly: [] });
    expect(s.hourlyBurnUsd).toBe(0);
    expect(s.runningInstances).toBe(0);
    expect(s.projectedMonthlyUsd).toBe(0);
    expect(s.totalBalanceUsd).toBe(0);
    expect(s.dailySpendUsd).toBe(0);
  });
});

// ── #848: idle/auto-stop note ─────────────────────────────────────────────────

describe('idleStopNote (#848)', () => {
  it('mentions the default idle + destroy windows', () => {
    const note = idleStopNote();
    expect(note).toContain(`${DEFAULT_IDLE_STOP_MIN}m`);
    expect(note).toContain(`${DEFAULT_AUTO_DESTROY_HOURS}h`);
    expect(note.toLowerCase()).toContain('auto-stop');
  });
  it('reflects custom windows', () => {
    expect(idleStopNote(30, 4)).toContain('30m idle');
    expect(idleStopNote(30, 4)).toContain('4h later');
  });
});

// ── #849: zombie-pod cost annotation ──────────────────────────────────────────

describe('annotateZombieCost (#849)', () => {
  it('computes hourly + daily burn and a warning', () => {
    const a = annotateZombieCost(0.4);
    expect(a).not.toBeNull();
    expect(a!.hourlyUsd).toBe(0.4);
    expect(a!.dailyUsd).toBe(9.6); // 0.4 * 24
    expect(a!.warning).toContain('$0.40/hr');
    expect(a!.warning).toContain('ZOMBIE');
  });
  it('returns null when cost is unknown/zero', () => {
    expect(annotateZombieCost(0)).toBeNull();
    expect(annotateZombieCost(undefined)).toBeNull();
    expect(annotateZombieCost('n/a')).toBeNull();
  });
});

// ── #850: sibling-binary discoverability ──────────────────────────────────────

describe('listSiblingBinaries (#850)', () => {
  it('lists the cost-audit binary with a summary', () => {
    const bins = listSiblingBinaries();
    expect(bins.some(b => b.name === 'ai-gateway-cost-audit')).toBe(true);
    expect(bins.every(b => b.summary.length > 0)).toBe(true);
  });
});

// ── #891: scripting contract ──────────────────────────────────────────────────

describe('describeScriptingContract (#891)', () => {
  it('documents the exit-code scheme', () => {
    const c = describeScriptingContract(['services', 'logs']);
    const codes = Object.fromEntries(c.exitCodes.map(e => [e.code, e.meaning]));
    expect(codes[0]).toBe('success');
    expect(codes[EXIT_USAGE]).toContain('usage');
    expect(codes[EXIT_RUNTIME]).toContain('runtime');
    expect(codes[130]).toContain('interrupted');
  });
  it('returns the json-capable command list sorted', () => {
    const c = describeScriptingContract(['logs', 'gpu list', 'balance']);
    expect(c.jsonCommands).toEqual(['balance', 'gpu list', 'logs']);
  });
});

// ── #899: Ctrl-C clean exit ───────────────────────────────────────────────────

describe('buildInterruptExit (#899)', () => {
  it('flushes a newline and exits 130', () => {
    const r = buildInterruptExit();
    expect(r.flush).toBe('\n');
    expect(r.exitCode).toBe(EXIT_SIGINT);
    expect(EXIT_SIGINT).toBe(130);
    expect(r.summary).toBeUndefined();
  });
  it('passes a non-empty summary through', () => {
    expect(buildInterruptExit('aborted after 3 tokens').summary).toBe('aborted after 3 tokens');
    expect(buildInterruptExit('   ').summary).toBeUndefined();
  });
});

// ── #900: deploy poll outcome ─────────────────────────────────────────────────

describe('classifyDeployPollOutcome (#900)', () => {
  it('reports ready / error terminal states', () => {
    expect(classifyDeployPollOutcome('ready', false)).toMatchObject({ outcome: 'ready', exitCode: 0 });
    expect(classifyDeployPollOutcome('error', true)).toMatchObject({ outcome: 'error', exitCode: EXIT_RUNTIME });
  });
  it('distinguishes an exhausted poll loop as a non-zero timeout', () => {
    const r = classifyDeployPollOutcome('booting', true);
    expect(r.outcome).toBe('timeout');
    expect(r.exitCode).toBe(EXIT_RUNTIME);
    expect(r.message.toLowerCase()).toContain('still deploying');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SDK pure helpers
// ════════════════════════════════════════════════════════════════════════════

// ── #831: SSE chunk parser ────────────────────────────────────────────────────

describe('parseSSEChunk (#831)', () => {
  it('extracts a content delta from a data: line', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hel"}}]}';
    expect(parseSSEChunk(line)).toEqual({ content: 'Hel', usage: undefined });
  });
  it('recognises the [DONE] sentinel', () => {
    expect(parseSSEChunk('data: [DONE]')).toEqual({ done: true });
  });
  it('surfaces a usage-only final chunk', () => {
    const line = 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}';
    expect(parseSSEChunk(line)).toEqual({
      content: undefined,
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
  });
  it('returns null for non-data / blank / malformed lines', () => {
    expect(parseSSEChunk(': keep-alive')).toBeNull();
    expect(parseSSEChunk('')).toBeNull();
    expect(parseSSEChunk('data: {not json')).toBeNull();
    expect(parseSSEChunk('data: {"choices":[{"delta":{}}]}')).toBeNull(); // no content/usage
  });
});

// ── #825: unified error normaliser ────────────────────────────────────────────

describe('normalizeGatewayError (#825)', () => {
  it('reads the src/sdk GatewayError fields', () => {
    const e = new GatewayError('boom', 503, '/v1/x', false, 'CREDIT_EXHAUSTED', false);
    const n = normalizeGatewayError(e);
    expect(n).toEqual({
      message: 'boom',
      statusCode: 503,
      endpoint: '/v1/x',
      code: 'CREDIT_EXHAUSTED',
      retryable: false,
      isNetworkError: false,
    });
  });
  it('flags a status-0 error as a network error', () => {
    const n = normalizeGatewayError(new GatewayError('down', 0, '/health', true));
    expect(n.statusCode).toBe(0);
    expect(n.isNetworkError).toBe(true);
  });
  it('falls back gracefully for a plain Error / non-error', () => {
    const n = normalizeGatewayError(new Error('plain'));
    expect(n.message).toBe('plain');
    expect(n.statusCode).toBe(0);
    expect(n.isNetworkError).toBe(true);
    expect(normalizeGatewayError('weird').message).toBe('weird');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SDK live behaviour (mocked fetch)
// ════════════════════════════════════════════════════════════════════════════

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Build a fake text/event-stream Response from SSE lines. */
function sseResponse(lines: string[]): Response {
  const body = lines.map(l => `${l}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('GatewaySDK live behaviour (mocked fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── #831: chatStream over a mocked SSE body ─────────────────────────────────

  it('#831 chatStream yields content deltas then a done chunk', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
    ]));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const out: string[] = [];
    let sawDone = false;
    for await (const chunk of gw.chatStream([{ role: 'user', content: 'hi' }])) {
      if (chunk.content) out.push(chunk.content);
      if (chunk.done) sawDone = true;
    }
    expect(out.join('')).toBe('Hello');
    expect(sawDone).toBe(true);
    // request body asked for stream:true
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).stream).toBe(true);
  });

  it('#831 chatStream degrades to a single chunk for a non-SSE response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: 'buffered reply' } }],
    }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const chunks: string[] = [];
    for await (const c of gw.chatStream([{ role: 'user', content: 'hi' }])) {
      if (c.content) chunks.push(c.content);
    }
    expect(chunks).toEqual(['buffered reply']);
  });

  // ── #877: rich ensemble transcription ───────────────────────────────────────

  it('#877 transcribeEnsemble returns consensus + per-provider results', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      consensus: 'bonjour le monde',
      providers: {
        groq: { text: 'bonjour le monde', latency_ms: 120 },
        openai: { text: 'bonjour le mond', latency_ms: 210 },
      },
      used_providers: 2,
      latency_ms: 230,
      corrected: 'Bonjour le monde',
      correction_applied: true,
    }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const r = await gw.transcribeEnsemble(new Uint8Array([1, 2, 3]), { language: 'fr', llmCorrect: true });
    expect(r.consensus).toBe('bonjour le monde');
    expect(r.usedProviders).toBe(2);
    expect(r.latencyMs).toBe(230);
    expect(r.providers.groq).toEqual({ provider: 'groq', text: 'bonjour le monde', latencyMs: 120 });
    expect(r.corrected).toBe('Bonjour le monde');
    expect(r.correctionApplied).toBe(true);
    // llm_correct + language passed through as query params
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('llm_correct=true');
    expect(String(calledUrl)).toContain('language=fr');
  });

  it('#877 transcribeEnsemble tolerates a minimal payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: 'hi' }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const r = await gw.transcribeEnsemble(new Uint8Array([0]));
    expect(r.consensus).toBe('hi'); // falls back to `text`
    expect(r.providers).toEqual({});
    expect(r.correctionApplied).toBe(false);
  });

  // ── #832: workload pagination iterator ──────────────────────────────────────

  it('#832 listAllWorkloads walks pages until the total is covered', async () => {
    const mk = (id: string) => ({ id, type: 'gpu', name: id, status: 'running', provider: 'runpod', costPerHr: 0, metadata: {}, createdAt: 0, updatedAt: 0 });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ workloads: [mk('a'), mk('b')], total: 3, limit: 2, offset: 0 }))
      .mockResolvedValueOnce(jsonResponse({ workloads: [mk('c')], total: 3, limit: 2, offset: 2 }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const ids: string[] = [];
    for await (const w of gw.listAllWorkloads({ pageSize: 2 })) ids.push(w.id);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // second page requested with offset=2
    expect(String(fetchMock.mock.calls[1][0])).toContain('offset=2');
  });

  it('#832 listAllWorkloads stops on an empty first page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workloads: [], total: 0, limit: 100, offset: 0 }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const ids: string[] = [];
    for await (const w of gw.listAllWorkloads()) ids.push(w.id);
    expect(ids).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── #840: AbortSignal threaded through public methods ───────────────────────

  it('#840 pipeline forwards an AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      transcription: 't', response: 'r', audio_base64: '', content_type: 'audio/wav',
      timing: { total_ms: 1, used_gpu: false },
    }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const ac = new AbortController();
    await gw.pipeline(new Uint8Array([1]), { signal: ac.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('#840 an already-aborted signal rejects the call', async () => {
    // Real fetch honours an aborted signal; emulate that with the mock.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    });
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', maxRetries: 0 });
    const ac = new AbortController();
    ac.abort();
    await expect(gw.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal })).rejects.toBeTruthy();
  });
});
