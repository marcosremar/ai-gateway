/**
 * Tests for the Silero worker (sdk/browser/voice/silero-worker-client.ts + silero-worker-host.ts) and the classifier
 * itself (silero.ts) over a fake onnxruntime. Silero left the main thread because scoring there opened 100–260 ms gaps
 * between game frames on a cloud phone (parle, 30/09/2026); the client only exchanges messages.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSileroVad,
  loadSileroWorker,
  serveSileroWorker,
  type OnnxWasmRuntime,
  type SileroWorkerReply,
  type SileroWorkerRequest,
  type WorkerLike,
} from '../../sdk/browser/voice/index';

/** A fake worker answering like the real one: one stateful classifier per `id`. */
class FakeSileroWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<SileroWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: SileroWorkerRequest[] = [];
  private seen = new Map<number, number>();

  constructor(private readonly mode: 'ok' | 'fail' | 'silent' = 'ok') {}

  postMessage(message: SileroWorkerRequest): void {
    this.sent.push(message);
    queueMicrotask(() => this.answer(message));
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(): void {
    this.onerror?.({ message: 'boom', preventDefault: () => {} } as ErrorEvent);
  }

  private reply(message: SileroWorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<SileroWorkerReply>);
  }

  private answer(message: SileroWorkerRequest): void {
    if (this.mode === 'silent') return;
    if (message.kind === 'init') return this.reply(this.mode === 'ok' ? { kind: 'ready', loadMs: 5 } : { kind: 'failed', error: 'no model' });
    if (message.kind === 'open') {
      this.seen.set(message.id, 0);
      return this.reply({ kind: 'opened', id: message.id });
    }
    if (message.kind === 'reset') {
      this.seen.set(message.id, 0);
      return;
    }
    const count = (this.seen.get(message.id) ?? 0) + 1;
    this.seen.set(message.id, count);
    this.reply({ kind: 'probability', seq: message.seq, value: message.id * 10 + count });
  }
}

const OPTS = { modelUrl: 'https://x/silero_vad.onnx', wasmUrl: 'https://x/ort.wasm' };
const frame = () => new Float32Array(512).fill(0.1);

/**
 * A fake onnxruntime whose "model" returns, as probability, how many frames it saw since the last reset (read from the
 * LSTM state it carries), and echoes the context it received — enough to check state and context threading.
 */
function fakeOrt() {
  const inputs: Float32Array[] = [];
  class Tensor {
    constructor(readonly type: string, readonly data: Float32Array | BigInt64Array, readonly dims: readonly number[]) {}
  }
  const ort = {
    env: { wasm: {} as { numThreads?: number; wasmPaths?: unknown } },
    Tensor,
    InferenceSession: {
      create: async () => ({
        run: async (feeds: Record<string, { data: unknown }>) => {
          const input = feeds.input!.data as Float32Array;
          inputs.push(input);
          const state = Float32Array.from(feeds.state!.data as Float32Array);
          state[0]! += 1;
          return { output: { data: Float32Array.from([state[0]!]) }, stateN: { data: state } };
        },
      }),
    },
  };
  return { ort: ort as unknown as OnnxWasmRuntime, inputs };
}

describe('Silero classifier', () => {
  it('threads LSTM state and the 64-sample context between frames; reset clears both', async () => {
    const { ort, inputs } = fakeOrt();
    const vad = await createSileroVad(ort, new Uint8Array([1]));
    const a = Float32Array.from({ length: 512 }, (_, i) => i);
    expect(await vad.probability(a)).toBe(1);
    expect(await vad.probability(new Float32Array(512))).toBe(2);
    expect(inputs[0]!.length).toBe(576);
    expect(Array.from(inputs[0]!.slice(0, 64))).toEqual(new Array(64).fill(0));
    expect(Array.from(inputs[1]!.slice(0, 64))).toEqual(Array.from(a.slice(448)));
    vad.reset();
    expect(await vad.probability(new Float32Array(512))).toBe(1);
    expect(Array.from(inputs[2]!.slice(0, 64))).toEqual(new Array(64).fill(0));
  });
});

describe('Silero in a worker: client', () => {
  it('each classifier has its own state in the worker and reset is queued after the frames', async () => {
    const worker = new FakeSileroWorker();
    const backend = await loadSileroWorker(OPTS, () => worker);
    expect(backend.where).toBe('worker');
    expect(worker.sent[0]).toEqual({ kind: 'init', ...OPTS });
    const a = await backend.create();
    const b = await backend.create();
    expect(await a.probability(frame())).toBe(11);
    expect(await a.probability(frame())).toBe(12);
    expect(await b.probability(frame())).toBe(21);
    a.reset();
    expect(await a.probability(frame())).toBe(11);
    expect(await b.probability(frame())).toBe(22);
  });

  it('a worker that dies rejects what is pending and what comes after', async () => {
    const worker = new FakeSileroWorker();
    const backend = await loadSileroWorker(OPTS, () => worker);
    const a = await backend.create();
    worker.crash();
    await expect(a.probability(frame())).rejects.toThrow(/silero.workerError/);
    await expect(backend.create()).rejects.toThrow(/silero.workerError/);
    expect(worker.terminated).toBe(true);
  });

  it('a worker that does not come up rejects the load (speech falls back to the main thread)', async () => {
    await expect(loadSileroWorker(OPTS, () => new FakeSileroWorker('fail'))).rejects.toThrow('no model');
    await expect(loadSileroWorker(OPTS, () => new FakeSileroWorker('silent'), 10)).rejects.toThrow('silero.workerTimeout');
    await expect(loadSileroWorker(OPTS, () => { throw new Error('no Worker'); })).rejects.toThrow('no Worker');
  });
});

describe('Silero in a worker: host', () => {
  afterEach(() => vi.unstubAllGlobals());

  function host() {
    const { ort } = fakeOrt();
    const replies: SileroWorkerReply[] = [];
    const scope = {
      onmessage: null as ((event: MessageEvent<SileroWorkerRequest>) => void) | null,
      postMessage: (message: SileroWorkerReply) => void replies.push(message),
    };
    serveSileroWorker(scope, ort);
    const send = (message: SileroWorkerRequest) => scope.onmessage!({ data: message } as MessageEvent<SileroWorkerRequest>);
    return { ort, replies, send };
  }

  it('configures one WASM thread, loads the model, scores per classifier in arrival order', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    const { ort, replies, send } = host();
    send({ kind: 'init', ...OPTS });
    send({ kind: 'open', id: 1 });
    send({ kind: 'frame', id: 1, seq: 1, frame: frame() });
    send({ kind: 'frame', id: 1, seq: 2, frame: frame() });
    send({ kind: 'reset', id: 1 });
    send({ kind: 'frame', id: 1, seq: 3, frame: frame() });
    send({ kind: 'frame', id: 9, seq: 4, frame: frame() });
    await vi.waitFor(() => expect(replies).toHaveLength(6));
    expect(ort.env.wasm).toEqual({ numThreads: 1, wasmPaths: { wasm: OPTS.wasmUrl } });
    expect(replies[0]).toMatchObject({ kind: 'ready' });
    expect(replies.slice(1)).toEqual([
      { kind: 'opened', id: 1 },
      { kind: 'probability', seq: 1, value: 1 },
      { kind: 'probability', seq: 2, value: 2 },
      { kind: 'probability', seq: 3, value: 1 },
      { kind: 'frameFailed', seq: 4, error: 'silero.unknownClassifier 9' },
    ]);
  });

  it('open before a loaded model fails; a model that does not download fails init', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    const { replies, send } = host();
    send({ kind: 'open', id: 1 });
    send({ kind: 'init', ...OPTS });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[0]).toEqual({ kind: 'openFailed', id: 1, error: 'Error: silero.notReady' });
    expect(replies[1]).toEqual({ kind: 'failed', error: 'Error: offline' });
  });
});
