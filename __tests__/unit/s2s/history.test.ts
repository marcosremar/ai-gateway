import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { runComposite, type ChatMessage, type StageClient } from '../../../src/s2s/composite';
import { estimateTokens, fitHistory } from '../../../src/s2s/history';
import { fakeStages } from './_fakes';

interface Case { name: string; system: string | null; history: ChatMessage[]; user: string; max_tokens: number; ctx: number; harder?: boolean; kept: number[] }
const vectors = JSON.parse(readFileSync(join(__dirname, '../../../docs/s2s-history-vectors.json'), 'utf8')) as { cases: Case[] };

const SYSTEM = 'Speak only Brazilian Portuguese. Plain text only, no emojis, no stage directions. Answer in about 6-8 words. '.repeat(24);
const PERSONA: ChatMessage = { role: 'system', content: 'Persona: Lúcia, 52 anos, dona da padaria da esquina.' };
const LEARNER = ['Bom dia, eu queria um pão francês, por favor.', 'Quanto custa?', 'Não entendi, pode repetir mais devagar?',
  "Bonjour, je voudrais deux croissants et une baguette bien cuite, s'il vous plaît, et aussi un café crème."];
const CLERK = ['Bom dia! O pão francês custa cinquenta centavos.', 'Custa três reais e cinquenta.',
  'Claro. O pão custa cinquenta centavos. Você quer quantos pães? Hoje também tem pão de queijo quentinho e bolo de fubá.'];

function strictStages(ctx: number, bytesPerToken: number) {
  const { stages } = fakeStages({ heard: 'Quanto custa?', reply: 'Custa três reais.' });
  const seen: Array<ChatMessage[] | null> = [];
  const strict: StageClient = {
    ...stages,
    async chatStream(messages, cfg, signal, hedgeMs) {
      const prompt = messages.reduce((n, m) => n + 4 + Math.ceil(Buffer.byteLength(m.content) / bytesPerToken), 0);
      if (prompt + (cfg.max_tokens ?? 160) > ctx) {
        seen.push(null);
        throw new Error(`llm HTTP 400: request (${prompt} tokens) exceeds the available context size (${ctx} tokens)`);
      }
      seen.push(messages);
      return stages.chatStream(messages, cfg, signal, hedgeMs);
    },
  };
  return { strict, seen };
}

const wholePairs = (messages: ChatMessage[]): boolean => {
  const roles = messages.slice(1).filter(m => m.role !== 'system').map(m => m.role);
  return roles.every((role, i) => role === (i % 2 ? 'assistant' : 'user')) && roles[roles.length - 1] === 'user';
};

async function turn(stages: StageClient, system: string, messages: ChatMessage[]) {
  const events: Array<{ type: string }> = [];
  await runComposite({
    stages, audio: new Uint8Array([1]), contentType: 'audio/webm', config: { system, messages, voice: 'v', language: 'pt' },
    signal: new AbortController().signal, emitEvent: e => events.push(e), emitAudio: () => {}, skipDeadline: true,
  });
  return events;
}

describe('fitHistory', () => {
  for (const c of vectors.cases) {
    it(`matches the replica's fit_history: ${c.name}`, () => {
      const kept = fitHistory(c.system ?? undefined, c.history, c.user, c.max_tokens, c.ctx, c.harder);
      expect(kept).toEqual(c.kept.map(i => c.history[i]));
    });
  }

  it('estimates 3 UTF-8 bytes per token plus 8 per message', () => {
    expect(estimateTokens('ééé')).toBe(10);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('runComposite history', () => {
  it('65 turns never overflow a 2048-token model; system prompt, system messages and whole newest pairs stay', async () => {
    const { strict, seen } = strictStages(2048, 3.6);
    let history: ChatMessage[] = [PERSONA];
    for (let i = 0; i < 65; i++) {
      const events = await turn(strict, SYSTEM, history);
      expect(events[events.length - 1].type).toBe('done');
      history = [...history, { role: 'user', content: LEARNER[i % 4] }, { role: 'assistant', content: CLERK[i % 3] }];
    }
    const sent = seen as ChatMessage[][];
    expect(seen).toHaveLength(65);
    expect(seen).not.toContain(null);
    expect(sent.every(m => m[0].content === SYSTEM && m.includes(PERSONA) && wholePairs(m))).toBe(true);
    expect(sent[64].slice(-3, -1).map(m => m.content)).toEqual([LEARNER[63 % 4], CLERK[63 % 3]]);
    const cuts = sent.slice(1).filter((next, i) => !sent[i].slice(0, -1).every((m, at) => m.content === next[at].content)).length;
    expect(cuts).toBeGreaterThanOrEqual(1);
    expect(cuts).toBeLessThanOrEqual(8);
  }, 30_000);

  it('a 400 for context is asked again once with half the room, before any sound', async () => {
    const { strict, seen } = strictStages(2048, 1.2);
    const history = [PERSONA, ...Array.from({ length: 12 }, (_, i) => [
      { role: 'user', content: LEARNER[i % 4] }, { role: 'assistant', content: CLERK[i % 3] },
    ]).flat()];
    const events = await turn(strict, SYSTEM.slice(0, 1500), history);
    expect(events[events.length - 1].type).toBe('done');
    expect(seen[0]).toBeNull();
    expect(seen).toHaveLength(2);
    const again = seen[1] as ChatMessage[];
    expect(again[0].content).toBe(SYSTEM.slice(0, 1500));
    expect(again.includes(PERSONA) && wholePairs(again) && again.length < 27).toBe(true);
  });
});
