import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import OpenAI from 'openai';
import { onRailway } from '../../../../deployments/real-machines';
import { isPrivateUrl } from '../../../pipeline/ssrf-protection';
import type { LLMProvider, ProviderId, STTProvider, TTSProvider } from '../types';
import { OpenAICompatLLMProvider, type OpenAICompatLLMConfig } from './openai-compat-llm';
import { OpenAICompatSTTProvider } from './openai-compat-stt';
import { OpenAICompatTTSProvider } from './openai-compat-tts';

type Env = Record<string, string | undefined>;
type Address = { address: string; family: number };
export interface LocalLinkDeps { lookupAll?: (host: string) => Promise<Address[]>; fetchImpl?: typeof fetch }
export interface LocalLinkSpec { baseUrl: string; model: string; apiKeyEnv?: string }

export const OPENAI_COMPATIBLE = 'openai-compatible';
const LOCAL_LINK_TIMEOUT_MS = 60_000;
export const LOCAL_LINK_MAX_BYTES = 50 * 1024 * 1024;

export function parseLinkBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, '');
}

export const isLinkKeyEnv = (name: unknown): name is string => typeof name === 'string' && /^LOCAL_[A-Z0-9_]+$/.test(name);

export function localLinkId(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  return `local:${url.host}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/${model}`;
}

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
const allowList = (env: Env) => (env.LOCAL_LINK_ALLOW ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const unchecked = (url: URL, env: Env) => !onRailway(env) || allowList(env).includes(hostOf(url));
const privateReason = (host: string) =>
  `${host} is a private, loopback, link-local or metadata address (the published gateway reaches one only when LOCAL_LINK_ALLOW names its host)`;
const refused = (reason: string) => Object.assign(new Error(`local link refused: ${reason}`), { gatewayCode: 'blocked' });
const tooLarge = () => Object.assign(new Error(`local link answer above ${LOCAL_LINK_MAX_BYTES} bytes`), { gatewayCode: 'too_large' });
const ipUrl = ({ address, family }: Address) => `http://${family === 6 ? `[${address}]` : address}/`;

export function localLinkRefusal(baseUrl: string, env: Env): string | null {
  const url = new URL(baseUrl);
  return unchecked(url, env) || !isPrivateUrl(url.href) ? null : privateReason(hostOf(url));
}

async function publicAddress(url: URL, lookupAll: NonNullable<LocalLinkDeps['lookupAll']>): Promise<Address | null> {
  const host = hostOf(url);
  if (isPrivateUrl(url.href)) throw refused(privateReason(host));
  if (isIP(host)) return null;
  const addresses = await lookupAll(host).catch(() => []);
  if (!addresses.length) throw refused(`${host} does not resolve`);
  const bad = addresses.find(a => isPrivateUrl(ipUrl(a)));
  if (bad) throw refused(`${host} resolves to ${bad.address}; ${privateReason(host)}`);
  return addresses[0]!;
}

function capped(res: Response): Response {
  if (Number(res.headers.get('content-length') ?? 0) > LOCAL_LINK_MAX_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return res;
  let seen = 0;
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > LOCAL_LINK_MAX_BYTES) controller.error(tooLarge());
      else controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function localLinkFetch(env: Env, deps: LocalLinkDeps = {}): typeof fetch {
  const lookupAll = deps.lookupAll ?? ((host: string) => lookup(host, { all: true }));
  const fetchImpl = deps.fetchImpl ?? fetch;
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (!unchecked(url, env)) {
      const pinned = await publicAddress(url, lookupAll);
      if (pinned && url.protocol === 'http:') {
        headers.set('host', url.host);
        url.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
      }
    }
    return capped(await fetchImpl(url, { ...init, headers, redirect: 'error' }));
  }) as typeof fetch;
}

class LocalLinkClient {
  private client: OpenAI | null = null;
  private key = '';
  private readonly fetchImpl: typeof fetch;
  constructor(readonly spec: LocalLinkSpec, private readonly env: Env, deps: LocalLinkDeps) { this.fetchImpl = localLinkFetch(env, deps); }
  configured(): boolean { return !this.spec.apiKeyEnv || Boolean(this.env[this.spec.apiKeyEnv]); }
  get(): OpenAI {
    const key = (this.spec.apiKeyEnv && this.env[this.spec.apiKeyEnv]) || 'local';
    if (!this.client || key !== this.key) {
      this.key = key;
      this.client = new OpenAI({ apiKey: key, baseURL: this.spec.baseUrl, maxRetries: 0, timeout: LOCAL_LINK_TIMEOUT_MS, fetch: this.fetchImpl });
    }
    return this.client;
  }
}

class LocalLLM extends OpenAICompatLLMProvider {
  constructor(private readonly link: LocalLinkClient, config: OpenAICompatLLMConfig) { super(config); }
  protected override getClient(): OpenAI { return this.link.get(); }
  override isConfigured(): boolean { return this.link.configured(); }
}

class LocalSTT extends OpenAICompatSTTProvider {
  constructor(private readonly link: LocalLinkClient, config: OpenAICompatLLMConfig) { super({ ...config, models: [] }); }
  protected override getClient(): OpenAI { return this.link.get(); }
  override isConfigured(): boolean { return this.link.configured(); }
}

class LocalTTS extends OpenAICompatTTSProvider {
  constructor(private readonly link: LocalLinkClient, config: OpenAICompatLLMConfig) { super({ ...config, models: [], voices: [], passthroughVoices: true }); }
  protected override getClient(): OpenAI { return this.link.get(); }
  override isConfigured(): boolean { return this.link.configured(); }
}

export function localLinkProvider(
  stage: 'chat' | 'stt' | 'tts', spec: LocalLinkSpec, env: Env, deps: LocalLinkDeps = {},
): LLMProvider | STTProvider | TTSProvider {
  const link = new LocalLinkClient(spec, env, deps);
  const config = { providerId: localLinkId(spec.baseUrl, spec.model) as ProviderId, baseURL: spec.baseUrl, envKey: spec.apiKeyEnv ?? '' };
  if (stage === 'chat') return new LocalLLM(link, config);
  return stage === 'stt' ? new LocalSTT(link, config) : new LocalTTS(link, config);
}
