/**
 * Messages between the main thread and the Silero worker (`serveSileroWorker`, `silero-worker-host.ts`). Each open
 * detector has its own classifier (`id`) with its LSTM state inside the worker; frames of one `id` arrive and are
 * scored in order, and a `reset` is queued after the frames that preceded it.
 */
export type SileroWorkerRequest =
  | { kind: 'init'; modelUrl: string; wasmUrl: string }
  | { kind: 'open'; id: number }
  | { kind: 'frame'; id: number; seq: number; frame: Float32Array }
  | { kind: 'reset'; id: number };

export type SileroWorkerReply =
  | { kind: 'ready'; loadMs: number }
  | { kind: 'failed'; error: string }
  | { kind: 'opened'; id: number }
  | { kind: 'openFailed'; id: number; error: string }
  | { kind: 'probability'; seq: number; value: number }
  | { kind: 'frameFailed'; seq: number; error: string };
