export interface CeilingTurn {
  client: string;
  speechEnd: number | null;
  firstLoud: number | null;
  events: Array<{ type: string; at: number; [k: string]: unknown }>;
}

const openerOf = (t: CeilingTurn) => t.events.find(e => e.type === 'opener' && e.state === 'start');

export function firstSoundMs(t: CeilingTurn): number | null {
  return t.firstLoud !== null && t.speechEnd !== null ? t.firstLoud - t.speechEnd : null;
}

export function firstReplyAudioMs(t: CeilingTurn): number | null {
  const opener = openerOf(t);
  if (!opener) return firstSoundMs(t);
  const reply = t.events.find(e => e.type === (t.client === 's2s' ? 'first_audio' : 'audio_start'));
  if (!reply || t.speechEnd === null) return null;
  return Math.max(reply.at, opener.at + (typeof opener.audio_ms === 'number' ? opener.audio_ms : 0)) - t.speechEnd;
}

export function ceilingReport(turns: CeilingTurn[], limitMs: number) {
  const sounds = turns.map(firstSoundMs).filter((x): x is number => x !== null);
  const over = (ms: number) => sounds.filter(x => x > ms).length;
  const pct = (n: number) => (sounds.length ? Math.round((1000 * n) / sounds.length) / 10 : 0);
  const max = sounds.length ? Math.round(Math.max(...sounds)) : null;
  return {
    limitMs, turnsWithSound: sounds.length, max, over2000Pct: pct(over(2000)), over2500Pct: pct(over(2500)), over3000Pct: pct(over(3000)),
    overLimit: over(limitMs), openers: turns.filter(openerOf).length, clientOpeners: turns.filter(t => openerOf(t)?.local === true).length, deadlineMissed: turns.filter(t => t.events.some(e => e.type === 'deadline_missed')).length,
    ok: max !== null && max <= limitMs,
  };
}
