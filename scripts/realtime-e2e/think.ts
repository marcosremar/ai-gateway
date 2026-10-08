export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseThink(raw: string | undefined): [number, number] | null {
  const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(raw ?? '');
  if (!m || Number(m[2]) < Number(m[1])) return null;
  return [Number(m[1]), Number(m[2])];
}

export function nextAfterListening(turn: { firstLoud: number | null; audioMs: number }, thinkS: [number, number], rand: () => number, now: number): number {
  const heard = turn.firstLoud === null ? now : Math.max(now, turn.firstLoud + turn.audioMs);
  return heard + (thinkS[0] + rand() * (thinkS[1] - thinkS[0])) * 1000;
}
