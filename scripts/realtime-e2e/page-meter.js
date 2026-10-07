const THRESHOLD = 0.02;
const POLL_MS = 5;
const MERGE_MS = 40;

export const epoch = () => performance.timeOrigin + performance.now();
const rawConnect = AudioNode.prototype.connect;
let shared = null;

export function makeMeter() {
  const taps = [];
  const spans = [];
  const stats = { polls: 0, maxGapMs: 0, windowMs: 0, taps: 0 };
  let last = 0;
  let open = null;
  setInterval(() => {
    const t = epoch();
    const gap = last ? Math.round(t - last) : 0;
    stats.maxGapMs = Math.max(stats.maxGapMs, gap);
    last = t;
    stats.polls++;
    if (open) open.endGap = gap;
    open = null;
    for (const tap of taps) {
      tap.an.getFloatTimeDomainData(tap.buf);
      let s = 0;
      for (const v of tap.buf) s += v * v;
      if (Math.sqrt(s / tap.buf.length) <= THRESHOLD) continue;
      const cur = spans[spans.length - 1];
      const start = t - POLL_MS / 2;
      const end = t - tap.windowMs + POLL_MS / 2;
      if (cur && start - cur.end <= MERGE_MS) cur.end = Math.max(cur.end, end);
      else spans.push({ start, end: Math.max(start, end), startGap: gap, endGap: 0 });
      open = spans[spans.length - 1];
      return;
    }
  }, POLL_MS);
  const add = (ctx, node) => {
    const an = ctx.createAnalyser();
    an.fftSize = 2 ** Math.round(Math.log2(ctx.sampleRate * 0.02));
    an.smoothingTimeConstant = 0;
    rawConnect.call(node, an);
    const windowMs = (an.fftSize / ctx.sampleRate) * 1000;
    taps.push({ an, buf: new Float32Array(an.fftSize), windowMs });
    stats.windowMs = Math.round(windowMs * 10) / 10;
    stats.taps = taps.length;
  };
  return {
    add, spans, stats,
    stream(stream) {
      shared ??= new AudioContext();
      void shared.resume().catch(() => {});
      add(shared, shared.createMediaStreamSource(stream));
    },
    loudAt: (t) => spans.some((s) => s.start <= t && s.end >= t),
    firstAfter: (t, until = Infinity) => spans.find((s) => s.start >= t && s.start < until) ?? null,
    loudMs: (from, until) => Math.round(spans.reduce((n, s) => n + Math.max(0, Math.min(s.end, until) - Math.max(s.start, from)), 0)),
  };
}

export const output = makeMeter();
AudioNode.prototype.connect = function connect(dest, ...rest) {
  if (dest instanceof AudioDestinationNode) output.add(this.context, this);
  return rawConnect.call(this, dest, ...rest);
};

export function playRemote(stream) {
  if (!stream) return;
  const el = new Audio();
  el.srcObject = stream;
  el.muted = true;
  void el.play().catch(() => {});
  output.stream(stream);
}

export function audible(turn, events, until) {
  const overlap = output.loudAt(turn.ref) || output.loudAt(turn.ref - 100);
  const span = overlap ? null : output.firstAfter(turn.ref, until);
  const first = span?.start ?? null;
  const at = (pred) => events.find((e) => e.at >= turn.at && e.at < until && pred(e))?.at ?? null;
  const received = at((e) => e.type === 'audio_start');
  const vadEnd = at((e) => e.type === 'vad' && e.state === 'end' && e.at >= turn.ref);
  const ms = (t) => (t === null ? null : Math.round(t - turn.ref));
  return {
    overlap, firstLoud: first, meterErrorMs: Math.max(span?.startGap ?? 0, turn.refGap ?? 0, POLL_MS), audioMs: overlap ? -1 : output.loudMs(turn.ref, until),
    audibleMs: ms(first), receivedMs: ms(received), heardAfterReceivedMs: first === null || received === null ? null : Math.round(first - received),
    audibleFromVadEndMs: first === null || vadEnd === null ? null : Math.round(first - vadEnd),
  };
}
