/** Error thrown when a boot pipeline stage exceeds its timeout */
export class StageTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;
  constructor(stage: string, timeoutMs: number) {
    super(`Stage "${stage}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'StageTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/** Wrap a promise with a hard timeout. Rejects with StageTimeoutError on expiry. */
export function withStageTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
