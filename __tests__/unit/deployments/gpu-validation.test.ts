import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { DeploymentController } from '../../../src/deployments/controller';
import { DECLARED_DEPLOYMENTS, DeclaredDeploymentReconciler } from '../../../src/deployments/declared';
import { contentCheck, type Call, type StageTarget } from '../../../src/deployments/gpu-probe';
import { GpuValidation, TRIAL_DEADLINE_MINUTES, VALIDATION_FAILS } from '../../../src/deployments/gpu-validation';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { MAX_GPU_PER_APP } from '../../../src/deployments/spec';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const OUTSIDE_CLASS = Date.parse('2026-10-14T10:00:00Z');
const IN_CLASS = Date.parse('2026-10-14T15:00:00Z');
const BEFORE_CLASS = Date.parse('2026-10-14T14:20:00Z');
const STAGES: StageTarget[] = [{ stage: 'stt', model: 'whisper' }, { stage: 'llm', model: 'llm' }, { stage: 'tts', model: 'tts' }];
const NEW_IMAGE = 'ghcr.io/marcosremar/speech-stack:20261101-0000';
const declared = DECLARED_DEPLOYMENTS.filter(d => d.name === 'parle-speech' || d.name === 'parle-speech-test');

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function setup(start = OUTSIDE_CLASS) {
  const clock = { t: start };
  const vast = Object.assign(new FakeCloud(() => clock.t, 'vast'), { marketPriced: true, price: 0.28 });
  let most = 0;
  const create = vast.createReplica.bind(vast);
  vast.createReplica = async (input) => {
    most = Math.max(most, vast.machines.size + 1);
    const m = await create(input);
    vast.machines.get(m.id)!.machine.zone = 'Prague, CZ';
    return { ...m, zone: 'Prague, CZ' };
  };
  const c = new DeploymentController({
    backends: { vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
    now: () => clock.t, maxGpuPerApp: MAX_GPU_PER_APP,
  });
  await c.init();
  controllers.push(c);
  clouds.push(vast);
  await new DeclaredDeploymentReconciler({ target: c, env: {}, declarations: declared }).reconcile();
  c.start();
  const checks: string[] = [];
  const answers: Array<string | null> = [];
  const v = new GpuValidation({
    controller: c, stages: name => (name === 'parle-speech' ? STAGES : []), now: () => clock.t,
    check: async (view, r) => { checks.push(`${view.name}:${r.machineType}`); return answers.length ? answers.shift()! : null; },
  });
  const tickAt = async (minutes: number) => { clock.t += minutes * MIN; await v.tick(); };
  return { c, vast, v, clock, checks, answers, tickAt, most: () => most };
}

const readyOn = (c: DeploymentController, name: string) => until(() => c.get(name)!.replicas.some(r => r.phase === 'ready'));
const typeOf = (v: GpuValidation, name: string, machineType: string) => v.view(name)!.types.find(t => t.machineType === machineType)!;

describe('GPU type validated on a real boot before production (owner, 15/10/2026)', () => {
  it('records a type only after the replica is ready, passed the content check and stayed ready 3 min', async () => {
    const { c, v, checks, answers, tickAt } = await setup();
    await c.setGpuType('parle-speech-test', 'H100 SXM', false, 'marcos');
    await c.warm('parle-speech-test', 1, 60);
    await v.tick();
    expect(checks).toEqual([]);
    await readyOn(c, 'parle-speech-test');
    answers.push(null, 'tts: áudio em silêncio (RMS 3)');
    await tickAt(0);
    await tickAt(1);
    expect(typeOf(v, 'parle-speech', 'H100 SXM').validated).toBeNull();
    for (const m of [1, 1, 1]) await tickAt(m);
    expect(typeOf(v, 'parle-speech', 'H100 SXM').validated).toBeNull();
    await tickAt(1);
    expect(typeOf(v, 'parle-speech', 'H100 SXM').validated).toMatchObject({ deployment: 'parle-speech-test', country: 'CZ' });
    expect(checks.every(x => x === 'parle-speech-test:H100 SXM')).toBe(true);
    expect(v.gpuTypeRefusal('parle-speech', 'H100 SXM')).toBeNull();
  });

  it('a new image tag needs a new validation; the RTX 3090 run of 14/10 is seeded for the image it ran', async () => {
    const { c, v } = await setup();
    expect(typeOf(v, 'parle-speech', 'RTX 3090').validated).toMatchObject({ country: 'CZ', checkMs: 1730, at: '2026-10-14T01:20:45.000Z' });
    expect(typeOf(v, 'parle-speech', 'H100 SXM').validated).toBeNull();
    await c.put('parle-speech', { image: NEW_IMAGE });
    await c.put('parle-speech-test', { image: NEW_IMAGE });
    expect(v.view('parle-speech')!.types.every(t => t.validated === null)).toBe(true);
    expect(v.gpuTypeRefusal('parle-speech', null)).toBeNull();
    expect(v.gpuTypeRefusal('parle-speech', 'RTX 3090')).toBeNull();
  });

  it('an unvalidated type is refused for production (409), passes with force, and the test copy takes any type', async () => {
    const { c, v } = await setup();
    const audit: Array<Record<string, unknown>> = [];
    const handler = createDeploymentRoutes({ controller: c, gpuValidation: v, isAdmin: () => true, userOf: () => 'marcos', audit: e => audit.push(e) });
    const put = (name: string, body: Record<string, unknown>) => call(handler, 'PUT', `/v1/deployments/${name}/gpu-type`, body);
    const refused = await put('parle-speech', { machineType: 'H100 SXM' });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain('H100 SXM ainda não validada nesta imagem');
    expect(c.get('parle-speech')!.gpuType!.current).toBe('RTX 3090');
    expect((await put('parle-speech-test', { machineType: 'H100 SXM' })).status).toBe(200);
    expect((await put('parle-speech', { machineType: 'L40S', force: true })).status).toBe(200);
    expect(c.get('parle-speech')!.gpuType).toMatchObject({ current: 'L40S', setBy: 'marcos' });
    expect((await put('parle-speech', { machineType: null })).status).toBe(200);
    expect(audit.map(e => [e.action, e.ok])).toEqual([
      ['deployments.gpu-type', false], ['deployments.gpu-type', true], ['deployments.gpu-type.force', true], ['deployments.gpu-type', true],
    ]);
    await expect(v.setGpuType('parle-speech', 'RTX 5090', false, 'marcos')).rejects.toThrow(/ainda não validada/);
  });

  it('«testar nesta GPU» is never refused for the hour (no class window, owner 24/10/2026), only while the app holds its one GPU', async () => {
    for (const at of [IN_CLASS, BEFORE_CLASS]) {
      const { v, c } = await setup(at);
      expect(v.trialRefusal(c.get('parle-speech')!, 'H100 SXM')).toBeNull();
    }
    const busy = await setup();
    busy.c.wake('parle-speech');
    await readyOn(busy.c, 'parle-speech');
    expect(busy.v.view('parle-speech')!.trialRefusal).toMatch(/a GPU do app está ocupada/);
    await expect(busy.v.startTrial('parle-speech', 'H100 SXM', 'marcos')).rejects.toThrow(/a GPU do app está ocupada/);
    expect(busy.vast.created.map(x => x.spec.name)).toEqual(['parle-speech']);
  });

  it('a trial boots the test copy on that type, never a second GPU, validates it and parks the copy back on its own type', async () => {
    const { c, vast, v, tickAt, most } = await setup();
    await expect(v.startTrial('parle-speech', 'RTX 3090', 'marcos')).rejects.toThrow(/já está validada nesta imagem/);
    await v.startTrial('parle-speech', 'H100 SXM', 'marcos');
    expect(v.view('parle-speech')!.trial).toMatchObject({ machineType: 'H100 SXM', deployment: 'parle-speech-test', by: 'marcos' });
    await expect(v.startTrial('parle-speech', 'L40S', 'marcos')).rejects.toThrow(/já há um teste em curso/);
    await readyOn(c, 'parle-speech-test');
    expect(vast.created.map(x => [x.spec.name, x.spec.machineType, x.spec.maxEurPerHour])).toEqual([['parle-speech-test', 'H100 SXM', 2.5]]);
    for (const m of [0, 1, 1, 1]) await tickAt(m);
    expect(typeOf(v, 'parle-speech', 'H100 SXM').validated).not.toBeNull();
    expect(v.view('parle-speech')!.trial).toBeNull();
    await until(() => vast.machines.size === 0);
    expect(c.get('parle-speech-test')!.gpuType!.current).toBe('RTX 3090');
    expect(most()).toBe(1);
    expect(v.gpuTypeRefusal('parle-speech', 'H100 SXM')).toBeNull();
  });

  it('a failed check is recorded with its reason and the copy parks; a boot that never gets ready fails at the deadline', async () => {
    const { c, vast, v, answers, tickAt } = await setup();
    await v.startTrial('parle-speech', 'L40S', 'marcos');
    await readyOn(c, 'parle-speech-test');
    answers.push(...Array(VALIDATION_FAILS).fill('stt: heard «» instead of «Bom dia.»'));
    for (let i = 0; i < VALIDATION_FAILS; i++) await tickAt(1);
    expect(typeOf(v, 'parle-speech', 'L40S')).toMatchObject({ validated: null, failed: { reason: 'stt: heard «» instead of «Bom dia.»', deployment: 'parle-speech-test' } });
    expect(Array.isArray(typeOf(v, 'parle-speech', 'L40S').failed!.lines)).toBe(true);
    await until(() => vast.machines.size === 0);
    expect(v.view('parle-speech')!.trial).toBeNull();

    await until(() => v.trialRefusal(c.get('parle-speech')!) === null);
    vast.bootMs = 60 * MIN;
    await v.startTrial('parle-speech', 'RTX 5090', 'marcos');
    await tickAt(TRIAL_DEADLINE_MINUTES - 1);
    expect(v.view('parle-speech')!.trial).not.toBeNull();
    await tickAt(1);
    expect(typeOf(v, 'parle-speech', 'RTX 5090').failed!.reason).toBe('não ficou pronta e estável em 40 min');
    expect(v.view('parle-speech')!.trial).toBeNull();
    expect(c.get('parle-speech-test')!.warm).toBeNull();
  });
});

describe('content check on the replica (the #146 probe, adapted)', () => {
  const tone = () => {
    const wav = Buffer.alloc(44 + 3200);
    wav.write('RIFF', 0);
    for (let i = 0; i < 1600; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), 44 + i * 2);
    return wav;
  };
  const replica = (answers: { heard?: string; said?: Buffer; reply?: string }): Call => async (path) => {
    if (path === '/v1/audio/speech') return new Response(new Uint8Array(answers.said ?? tone()), { headers: { 'content-type': 'audio/wav' } });
    if (path === '/v1/audio/transcriptions') return Response.json({ text: answers.heard ?? 'Bom dia.' });
    if (path === '/v1/chat/completions') return Response.json({ choices: [{ message: { content: answers.reply ?? 'ok' } }] });
    return new Response('not found', { status: 404 });
  };
  const stages: StageTarget[] = [{ stage: 'tts', model: 'tts', voice: 'br-f-03' }, { stage: 'stt', model: 'whisper' }, { stage: 'llm', model: 'llm' }];

  it('passes when the TTS speaks, the STT hears «bom dia» in it and the LLM answers «ok»', async () => {
    expect(await contentCheck(replica({}), stages)).toBeNull();
  });

  it('names the stage and what came back', async () => {
    expect(await contentCheck(replica({ said: Buffer.alloc(2000) }), stages)).toMatch(/^tts: áudio em silêncio/);
    expect(await contentCheck(replica({ heard: 'obrigado' }), stages)).toBe('stt: heard «obrigado» instead of «Bom dia.»');
    expect(await contentCheck(replica({ reply: 'hello' }), stages)).toBe('llm: answered «hello» instead of «ok»');
  });
});

function call(handler: ReturnType<typeof createDeploymentRoutes>, method: string, path: string, body: Record<string, unknown>) {
  return new Promise<{ status: number; body: string }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead: (s: number) => { status = s; return res; },
      end: (data?: string) => resolve({ status, body: data ?? '' }),
      on: () => res,
    } as unknown as ServerResponse;
    const req = Object.assign((async function* () { yield Buffer.from(JSON.stringify(body)); })(), {
      headers: { authorization: 'Bearer admin' }, url: path, socket: {},
    }) as unknown as IncomingMessage;
    handler(req, res, path, method);
  });
}
