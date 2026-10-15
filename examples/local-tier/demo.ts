import { GatewayClient } from '../../sdk/node/gateway-client';
import type { ChatStream, Served } from '../../sdk/node/gateway-types';
import {
  createLocalTier, espeakPhonemizer, kokoroTts, webLlm, whisperStt,
  type GatewayLike, type LoadProgress, type Local, type LocalAdmission, type LocalStage, type LocalTier, type StagePolicy,
} from '../../sdk/browser/local/index';
import { clipToWav, encodeWav } from '../../sdk/browser/voice/turn-clip';

const CDN = {
  transformers: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js',
  kokoro: 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
  webLlm: 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm',
  espeak: 'https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.js',
  espeakWasm: 'https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.wasm',
};
const importUrl = (url: string) => import(url);

const STAGES: LocalStage[] = ['stt', 'tts', 'llm'];
const POLICIES: StagePolicy[] = ['local-first', 'gateway-first', 'gateway-only'];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value.trim();

for (const stage of STAGES) {
  const label = document.createElement('label');
  label.textContent = stage.toUpperCase();
  const select = document.createElement('select');
  select.id = `policy-${stage}`;
  for (const p of POLICIES) select.add(new Option(p, p));
  label.append(select);
  $('policies').append(label);
}

const beep = () => Float32Array.from({ length: 12_000 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 24_000));

function stubGateway(down: boolean): GatewayLike {
  const served: Served = { provider: down ? 'down' : 'stub', fallback: null, fallbackFrom: null };
  const check = () => { if (down) throw new Error('gateway down (demo)'); };
  return {
    transcribe: async () => { check(); return { text: '(stub transcript)', served }; },
    chat: async () => {
      check();
      return { id: 'stub', object: 'chat.completion', created: 0, model: 'stub', served,
        choices: [{ index: 0, message: { role: 'assistant', content: '(stub reply)' }, finish_reason: 'stop' }] };
    },
    chatStream: async (): Promise<ChatStream> => {
      check();
      return { served, finishReason: 'stop', usage: null, cancel: async () => {}, async *[Symbol.asyncIterator]() { yield '(stub reply)'; } };
    },
    speech: async () => { check(); return { body: new Blob([encodeWav(beep(), 24_000)]).stream(), contentType: 'audio/wav', served }; },
  };
}

function gateway(): GatewayLike {
  const mode = value('gw-mode');
  if (mode !== 'real') return stubGateway(mode === 'down');
  return new GatewayClient({ baseUrl: value('gw-url'), apiKey: value('gw-key') || undefined });
}

let tier: LocalTier;
let admission: LocalAdmission | null = null;
const progress: Partial<Record<LocalStage, LoadProgress>> = {};

function cell(row: HTMLTableRowElement, content: string | Node, className = '') {
  const td = row.insertCell();
  td.append(content);
  if (className) td.className = className;
}

function renderDevice() {
  const table = $<HTMLTableElement>('device');
  table.replaceChildren();
  if (!admission) return;
  const { caps, budgetMb, stages } = admission;
  const head = table.insertRow();
  cell(head, `WebGPU: ${caps.webgpu ? `yes (${caps.gpu ?? 'unknown'}${caps.shaderF16 ? ', f16' : ''})` : 'no'}`);
  cell(head, `mobile: ${caps.mobile}`);
  cell(head, `deviceMemory: ${caps.deviceMemoryGb ?? '?'} GB`);
  cell(head, `storage free: ${caps.storageFreeMb ?? '?'} MB`);
  cell(head, `budget: ${budgetMb} MB`);
  for (const stage of STAGES) {
    const a = stages[stage];
    const p = progress[stage];
    const row = table.insertRow();
    cell(row, stage.toUpperCase());
    cell(row, a.local ? `local on ${a.device} (${a.memoryMb} MB, ${a.downloadMb} MB download)` : `gateway: ${a.reason}`, a.local ? 'local' : 'gateway');
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = p?.progress ?? 0;
    cell(row, p ? bar : '');
    cell(row, p ? `${p.status}${p.loadMs === undefined ? '' : ` in ${Math.round(p.loadMs)} ms`}` : '');
    cell(row, p?.model ?? '');
  }
}

async function apply() {
  tier = createLocalTier({
    gateway: gateway(),
    policy: Object.fromEntries(STAGES.map(s => [s, value(`policy-${s}`) as StagePolicy])),
    budgetMb: value('budget') === 'auto' ? undefined : Number(value('budget')),
    models: {
      stt: whisperStt({ loadTransformers: () => importUrl(CDN.transformers) }),
      tts: kokoroTts({ loadKokoro: () => importUrl(CDN.kokoro), phonemize: espeakPhonemizer(() => importUrl(CDN.espeak).then(m => m.default), CDN.espeakWasm) }),
      llm: webLlm({ loadWebLlm: () => importUrl(CDN.webLlm) }),
    },
    onProgress: (p) => { progress[p.stage] = p; renderDevice(); },
  });
  for (const s of STAGES) delete progress[s];
  admission = await tier.admission();
  renderDevice();
}

let callCount = 0;
function logCall(stage: LocalStage, result: Local & { served: Served }, ms: number, summary: string) {
  const row = $<HTMLTableElement>('calls').tBodies[0]!.insertRow(0);
  cell(row, String(++callCount));
  cell(row, stage);
  cell(row, result.servedBy, result.servedBy);
  cell(row, result.reason ?? '');
  cell(row, String(Math.round(ms)));
  cell(row, result.served.provider ?? '');
  cell(row, summary);
}

function logError(stage: LocalStage, err: unknown) {
  const row = $<HTMLTableElement>('calls').tBodies[0]!.insertRow(0);
  cell(row, String(++callCount));
  cell(row, stage);
  cell(row, 'failed', 'gateway');
  cell(row, err instanceof Error ? err.message : String(err));
}

async function levels(blob: Blob) {
  const audio = await new OfflineAudioContext(1, 1, 24_000).decodeAudioData(await blob.arrayBuffer());
  const samples = audio.getChannelData(0);
  let peak = 0;
  let energy = 0;
  for (const x of samples) { peak = Math.max(peak, Math.abs(x)); energy += x * x; }
  return { seconds: audio.duration.toFixed(2), peak: peak.toFixed(3), rms: Math.sqrt(energy / samples.length).toFixed(4), silent: peak < 1e-3 };
}

async function speak(): Promise<Blob | null> {
  const started = performance.now();
  try {
    const result = await tier.speak({ model: 'parle-tts', input: value('text'), voice: value('voice'), fallback_voice: 'pf_dora', language: value('lang') });
    const blob = await new Response(result.body).blob();
    const ms = performance.now() - started;
    $<HTMLAudioElement>('player').src = URL.createObjectURL(blob);
    const l = await levels(blob);
    logCall('tts', result, ms, `${l.seconds} s audio, peak ${l.peak}, rms ${l.rms}${l.silent ? ' SILENT' : ''}`);
    return blob;
  } catch (err) { logError('tts', err); return null; }
}

async function transcribe(clip: Blob) {
  const started = performance.now();
  try {
    const result = await tier.transcribe({ file: clip, model: 'parle-stt', language: value('lang') });
    const logprob = typeof result.avg_logprob === 'number' ? ` (avg logprob ${result.avg_logprob.toFixed(2)})` : '';
    logCall('stt', result, performance.now() - started, `«${result.text}»${logprob}`);
  } catch (err) { logError('stt', err); }
}

async function record(): Promise<Blob> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.ondataavailable = e => parts.push(e.data);
  const stopped = new Promise(r => { recorder.onstop = r; });
  recorder.start();
  await new Promise(r => setTimeout(r, 4_000));
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  const clip = new Blob(parts, { type: recorder.mimeType });
  return (await clipToWav(clip, new AudioContext())) ?? clip;
}

async function chat() {
  const started = performance.now();
  const reply = $('reply');
  reply.textContent = '';
  try {
    const stream = await tier.chatStream({ model: 'parle-llm', max_tokens: 80, temperature: 0.3, messages: [
      { role: 'system', content: 'Você é o atendente de uma padaria no Rio de Janeiro. Responda em uma frase curta, em português do Brasil.' },
      { role: 'user', content: value('text') },
    ] });
    let firstMs: number | null = null;
    for await (const delta of stream) {
      firstMs ??= performance.now() - started;
      reply.textContent += delta;
    }
    logCall('llm', stream, performance.now() - started, `first token ${Math.round(firstMs ?? 0)} ms: «${reply.textContent}»`);
  } catch (err) { logError('llm', err); }
}

function busy(id: string, run: () => Promise<unknown>) {
  $(id).addEventListener('click', async () => {
    const button = $<HTMLButtonElement>(id);
    button.disabled = true;
    try { await run(); } finally { button.disabled = false; }
  });
}

busy('apply', apply);
busy('prefetch', () => tier.prefetch());
busy('speak', speak);
busy('roundtrip', async () => { const clip = await speak(); if (clip) await transcribe(clip); });
busy('record', async () => transcribe(await record()));
busy('chat', chat);
void apply();
