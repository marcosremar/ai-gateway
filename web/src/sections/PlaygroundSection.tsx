'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getPlaygroundCatalog, playgroundLlm, playgroundTts, playgroundStt,
  type PlaygroundCatalog, type PlaygroundCatalogModel, type PlaygroundCatalogVoice,
} from '@/lib/gateway';
import { Button, FormSelect, FormInput, AlertBanner, Spinner } from '@/components/ui';
import {
  Send, Trash2, Settings2, Bot, User, Sparkles, Loader2,
  Mic, Square, Upload, Volume2, MessageSquare, AudioLines, Speech,
} from 'lucide-react';

// ── Types ──

type PlaygroundMode = 'chat' | 'transcribe' | 'tts';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  audioUrl?: string;
  meta?: {
    provider: string;
    model: string;
    latencyMs: number;
    tokens?: number;
    type: PlaygroundMode;
    language?: string;
    duration?: number;
    audioSize?: number;
  };
}

// ── Helpers ──

function modelsForCapability(catalog: PlaygroundCatalog, capability: string, providerId: string): PlaygroundCatalogModel[] {
  return (catalog.capabilities[capability]?.models ?? []).filter(m => m.providerId === providerId);
}

function providersForCapability(catalog: PlaygroundCatalog, capability: string): string[] {
  const seen = new Set<string>();
  return (catalog.capabilities[capability]?.models ?? [])
    .map(m => m.providerId)
    .filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
}

function voicesForProvider(catalog: PlaygroundCatalog, providerId: string): PlaygroundCatalogVoice[] {
  return (catalog.capabilities.tts?.voices ?? []).filter(v => v.providerId === providerId);
}

function providerName(catalog: PlaygroundCatalog, id: string): string {
  return catalog.providers.find(p => p.id === id)?.name ?? id;
}

function providerAvailable(catalog: PlaygroundCatalog, id: string): boolean {
  return catalog.providers.find(p => p.id === id)?.available ?? false;
}

let _msgId = 0;
function nextId(): string { return `msg-${++_msgId}-${Date.now()}`; }

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const MODE_META: Record<PlaygroundMode, { capability: string; label: string; icon: typeof MessageSquare }> = {
  chat: { capability: 'llm', label: 'Chat', icon: MessageSquare },
  transcribe: { capability: 'stt', label: 'Transcribe', icon: AudioLines },
  tts: { capability: 'tts', label: 'Text to Speech', icon: Speech },
};

// ── Audio Recording Hook ──

function useAudioRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    chunksRef.current = [];
    mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.start();
    mrRef.current = mr;
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  }, []);

  const stop = useCallback((): Promise<Blob> => {
    return new Promise(resolve => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      const mr = mrRef.current;
      if (!mr || mr.state === 'inactive') { setRecording(false); resolve(new Blob([])); return; }
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        mr.stream.getTracks().forEach(t => t.stop());
        setRecording(false);
        resolve(blob);
      };
      mr.stop();
    });
  }, []);

  return { recording, seconds, start, stop };
}

// ── Audio Player (inline) ──

function AudioPlayer({ url }: { url: string }) {
  return <audio src={url} controls className="h-8 mt-1.5" style={{ maxWidth: 320 }} />;
}

// ── Main Section ──

export function PlaygroundSection() {
  const [catalog, setCatalog] = useState<PlaygroundCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try { setCatalog(await getPlaygroundCatalog()); }
    catch (e) { setCatalogError(e instanceof Error ? e.message : 'Failed to load catalog'); }
    finally { setCatalogLoading(false); }
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  if (catalogLoading) {
    return (
      <div className="h-full flex items-center justify-center gap-3" style={{ color: 'var(--color-text-muted)' }}>
        <Spinner /> Loading models...
      </div>
    );
  }

  if (catalogError || !catalog) {
    return (
      <div className="p-6 space-y-4">
        <AlertBanner variant="error">{catalogError ?? 'No catalog data'}</AlertBanner>
        <Button onClick={loadCatalog}>Retry</Button>
      </div>
    );
  }

  return <ChatPlayground catalog={catalog} />;
}

// ── Chat Playground ──

function ChatPlayground({ catalog }: { catalog: PlaygroundCatalog }) {
  const [mode, setMode] = useState<PlaygroundMode>('chat');
  const [showConfig, setShowConfig] = useState(true);

  // ── Per-mode provider/model state ──
  const llmProviders = providersForCapability(catalog, 'llm');
  const sttProviders = providersForCapability(catalog, 'stt');
  const ttsProviders = providersForCapability(catalog, 'tts');

  const [llmProvider, setLlmProvider] = useState(catalog.defaults.llm?.provider || llmProviders[0] || '');
  const [llmModel, setLlmModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful assistant.');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);

  const [sttProvider, setSttProvider] = useState(catalog.defaults.stt?.provider || sttProviders[0] || '');
  const [sttModel, setSttModel] = useState('');
  const [sttLanguage, setSttLanguage] = useState('');

  const [ttsProvider, setTtsProvider] = useState(catalog.defaults.tts?.provider || ttsProviders[0] || '');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsVoice, setTtsVoice] = useState(catalog.defaults.tts?.voice || '');
  const [ttsInstructions, setTtsInstructions] = useState('');

  // ── Chat state ──
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder();

  // Derived: current mode's provider/model/models
  const cap = MODE_META[mode].capability;
  const curProvider = mode === 'chat' ? llmProvider : mode === 'transcribe' ? sttProvider : ttsProvider;
  const curModel = mode === 'chat' ? llmModel : mode === 'transcribe' ? sttModel : ttsModel;
  const curModels = modelsForCapability(catalog, cap, curProvider);
  const curProviderLabel = providerName(catalog, curProvider);
  const curModelLabel = curModels.find(m => m.id === curModel)?.name || curModel;

  // Default model when provider changes
  useEffect(() => {
    const ms = modelsForCapability(catalog, 'llm', llmProvider);
    setLlmModel((ms.find(m => m.isDefault) || ms[0])?.id || '');
  }, [llmProvider, catalog]);

  useEffect(() => {
    const ms = modelsForCapability(catalog, 'stt', sttProvider);
    setSttModel((ms.find(m => m.isDefault) || ms[0])?.id || '');
  }, [sttProvider, catalog]);

  useEffect(() => {
    const ms = modelsForCapability(catalog, 'tts', ttsProvider);
    setTtsModel((ms.find(m => m.isDefault) || ms[0])?.id || '');
    const vs = voicesForProvider(catalog, ttsProvider);
    if (vs.length && !vs.find(v => v.id === ttsVoice)) setTtsVoice(vs[0].id);
  }, [ttsProvider, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, [mode]);

  // ── Handlers ──

  async function handleSendChat() {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setError(null);
    setLoading(true);
    try {
      const apiMsgs = history.map(m => ({ role: m.role, content: m.content }));
      const res = await playgroundLlm({
        messages: apiMsgs,
        provider: llmProvider || undefined,
        model: llmModel || undefined,
        system_prompt: systemPrompt || undefined,
        temperature,
        max_tokens: maxTokens,
      });
      setMessages(prev => [...prev, {
        id: nextId(), role: 'assistant', content: res.content,
        meta: { provider: res.provider, model: res.model, latencyMs: res.latencyMs, tokens: res.usage?.totalTokens, type: 'chat' },
      }]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { setLoading(false); inputRef.current?.focus(); }
  }

  async function handleSendTts() {
    const text = input.trim();
    if (!text || loading) return;
    setMessages(prev => [...prev, { id: nextId(), role: 'user', content: text }]);
    setInput('');
    setError(null);
    setLoading(true);
    try {
      const res = await playgroundTts({
        text,
        provider: ttsProvider || undefined,
        model: ttsModel || undefined,
        voice: ttsVoice || undefined,
        instructions: ttsInstructions || undefined,
        return_audio: true,
      });
      let audioUrl: string | undefined;
      if (res.audioBase64) {
        const bytes = Uint8Array.from(atob(res.audioBase64), c => c.charCodeAt(0));
        audioUrl = URL.createObjectURL(new Blob([bytes], { type: res.contentType || 'audio/mp3' }));
      }
      setMessages(prev => [...prev, {
        id: nextId(), role: 'assistant',
        content: `Audio generated (${(res.audioSizeBytes / 1024).toFixed(1)} KB)`,
        audioUrl,
        meta: { provider: res.provider, model: res.model, latencyMs: res.latencyMs, type: 'tts', audioSize: res.audioSizeBytes },
      }]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { setLoading(false); inputRef.current?.focus(); }
  }

  async function handleAudioInput(blob: Blob) {
    if (blob.size === 0) return;
    const audioUrl = URL.createObjectURL(blob);

    if (mode === 'chat') {
      // Chat mode: STT → fill input → auto-send to LLM
      setError(null);
      setLoading(true);
      try {
        const sttRes = await playgroundStt(blob, {
          provider: sttProvider || undefined,
          model: sttModel || undefined,
          language: sttLanguage || undefined,
        });
        URL.revokeObjectURL(audioUrl);
        if (!sttRes.text?.trim()) { setError('No speech detected'); setLoading(false); return; }
        // Use transcription as a chat message and send to LLM
        const userMsg: ChatMessage = { id: nextId(), role: 'user', content: sttRes.text };
        const history = [...messages, userMsg];
        setMessages(history);
        const apiMsgs = history.map(m => ({ role: m.role, content: m.content }));
        const llmRes = await playgroundLlm({
          messages: apiMsgs,
          provider: llmProvider || undefined,
          model: llmModel || undefined,
          system_prompt: systemPrompt || undefined,
          temperature,
          max_tokens: maxTokens,
        });
        setMessages(prev => [...prev, {
          id: nextId(), role: 'assistant', content: llmRes.content,
          meta: { provider: llmRes.provider, model: llmRes.model, latencyMs: llmRes.latencyMs, tokens: llmRes.usage?.totalTokens, type: 'chat' },
        }]);
      } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
      finally { setLoading(false); inputRef.current?.focus(); }
    } else {
      // Transcribe mode: show audio → transcribe → show text
      setMessages(prev => [...prev, { id: nextId(), role: 'user', content: 'Audio recording', audioUrl }]);
      setError(null);
      setLoading(true);
      try {
        const res = await playgroundStt(blob, {
          provider: sttProvider || undefined,
          model: sttModel || undefined,
          language: sttLanguage || undefined,
        });
        setMessages(prev => [...prev, {
          id: nextId(), role: 'assistant', content: res.text || '(no speech detected)',
          meta: { provider: res.provider, model: res.model || '', latencyMs: res.latencyMs, type: 'transcribe', language: res.language, duration: res.duration },
        }]);
      } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
      finally { setLoading(false); }
    }
  }

  async function handleRecordToggle() {
    if (recorder.recording) {
      const blob = await recorder.stop();
      await handleAudioInput(blob);
    } else {
      try { await recorder.start(); }
      catch { setError('Microphone access denied. Please allow microphone access in your browser.'); }
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleAudioInput(file);
    e.target.value = '';
  }

  async function handleReadAloud(text: string) {
    try {
      const res = await playgroundTts({
        text,
        provider: ttsProvider || undefined,
        model: ttsModel || undefined,
        voice: ttsVoice || undefined,
        return_audio: true,
      });
      if (res.audioBase64) {
        const bytes = Uint8Array.from(atob(res.audioBase64), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: res.contentType || 'audio/mp3' }));
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play();
      }
    } catch { /* silent fail for read-aloud */ }
  }

  function handleSend() {
    if (mode === 'chat') handleSendChat();
    else if (mode === 'tts') handleSendTts();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleClear() {
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  }

  const setProviderForMode = (v: string) => {
    if (mode === 'chat') setLlmProvider(v);
    else if (mode === 'transcribe') setSttProvider(v);
    else setTtsProvider(v);
  };

  const setModelForMode = (v: string) => {
    if (mode === 'chat') setLlmModel(v);
    else if (mode === 'transcribe') setSttModel(v);
    else setTtsModel(v);
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* ── Config Sidebar ── */}
      <div
        className="flex flex-col border-r shrink-0 transition-all duration-200"
        style={{ width: showConfig ? 280 : 0, borderColor: 'var(--color-border)', background: 'var(--color-surface)', overflow: 'hidden' }}
      >
        <div className="p-4 space-y-4 overflow-y-auto flex-1" style={{ minWidth: 280 }}>
          {/* Mode selector */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Mode</label>
            <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: 'var(--color-bg)' }}>
              {(['chat', 'transcribe', 'tts'] as PlaygroundMode[]).map(m => {
                const meta = MODE_META[m];
                const Icon = meta.icon;
                const active = mode === m;
                return (
                  <button key={m} onClick={() => setMode(m)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-1 rounded-md text-[11px] font-medium transition-all ${active ? 'shadow-sm' : 'hover:opacity-80'}`}
                    style={{ background: active ? 'var(--color-surface)' : 'transparent', color: active ? 'var(--color-text)' : 'var(--color-text-muted)' }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Provider */}
          <FormSelect label="Provider" value={curProvider} onChange={e => setProviderForMode(e.target.value)}>
            {providersForCapability(catalog, cap).map(id => (
              <option key={id} value={id} disabled={!providerAvailable(catalog, id)}>
                {providerName(catalog, id)}{providerAvailable(catalog, id) ? '' : ' (no key)'}
              </option>
            ))}
          </FormSelect>

          {/* Model */}
          <FormSelect label="Model" value={curModel} onChange={e => setModelForMode(e.target.value)}>
            {curModels.map(m => (
              <option key={m.id} value={m.id}>{m.name}{m.isDefault ? ' (default)' : ''}</option>
            ))}
          </FormSelect>

          {/* ── Mode-specific config ── */}

          {mode === 'chat' && (
            <>
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>System prompt</label>
                <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={4}
                  className="w-full border rounded-lg text-xs p-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 resize-none"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
                  placeholder="You are a helpful assistant..." />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Temperature: {temperature}</label>
                <input type="range" min={0} max={2} step={0.1} value={temperature}
                  onChange={e => setTemperature(parseFloat(e.target.value))} className="w-full accent-emerald-500" />
                <div className="flex justify-between text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  <span>Precise</span><span>Creative</span>
                </div>
              </div>
              <FormInput label="Max tokens" type="number" value={maxTokens}
                onChange={e => setMaxTokens(parseInt(e.target.value) || 1024)} min={1} max={32768} />
              {/* STT config for voice input in chat mode */}
              <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <label className="block text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-muted)' }}>
                  Voice Input (STT)
                </label>
                <FormSelect label="STT Provider" value={sttProvider} onChange={e => setSttProvider(e.target.value)}>
                  {sttProviders.map(id => (
                    <option key={id} value={id} disabled={!providerAvailable(catalog, id)}>
                      {providerName(catalog, id)}{providerAvailable(catalog, id) ? '' : ' (no key)'}
                    </option>
                  ))}
                </FormSelect>
              </div>
            </>
          )}

          {mode === 'transcribe' && (
            <FormSelect label="Language hint (optional)" value={sttLanguage} onChange={e => setSttLanguage(e.target.value)}>
              <option value="">Auto-detect</option>
              {catalog.languages.map(l => (
                <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
              ))}
            </FormSelect>
          )}

          {mode === 'tts' && (
            <>
              {voicesForProvider(catalog, ttsProvider).length > 0 && (
                <FormSelect label="Voice" value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
                  {voicesForProvider(catalog, ttsProvider).map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </FormSelect>
              )}
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Voice instructions (optional)</label>
                <textarea value={ttsInstructions} onChange={e => setTtsInstructions(e.target.value)} rows={3}
                  className="w-full border rounded-lg text-xs p-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 resize-none"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
                  placeholder="Speak in a warm, friendly tone..." />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Chat Area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 h-11 border-b shrink-0"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowConfig(!showConfig)}
              className="p-1.5 rounded-md hover:bg-white/5 transition-colors"
              title={showConfig ? 'Hide config' : 'Show config'}>
              <Settings2 className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            </button>
            <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {(() => { const Icon = MODE_META[mode].icon; return <Icon className="w-3.5 h-3.5" style={{ color: '#10b981' }} />; })()}
              <span className="font-medium" style={{ color: 'var(--color-text)' }}>{MODE_META[mode].label}</span>
              <span className="opacity-50">&middot;</span>
              <span>{curProviderLabel}</span>
              <span>/</span>
              <span className="font-mono">{curModelLabel}</span>
            </div>
          </div>
          {messages.length > 0 && (
            <button onClick={handleClear}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/5 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}>
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState mode={mode} provider={curProviderLabel} model={curModelLabel}
              onSuggestion={text => { setInput(text); inputRef.current?.focus(); }} />
          ) : (
            <div className="max-w-3xl mx-auto py-6 px-4 space-y-1">
              {messages.map(msg => (
                <MessageBubble key={msg.id} message={msg}
                  onReadAloud={mode === 'chat' && msg.role === 'assistant' ? () => handleReadAloud(msg.content) : undefined} />
              ))}
              {loading && (
                <div className="flex gap-3 py-4 px-1">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: 'var(--color-surface)' }}>
                    <Bot className="w-4 h-4" style={{ color: '#10b981' }} />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                    <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                      {mode === 'chat' ? 'Thinking...' : mode === 'transcribe' ? 'Transcribing...' : 'Generating audio...'}
                    </span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 pb-2 max-w-3xl mx-auto w-full">
            <AlertBanner variant="error">{error}</AlertBanner>
          </div>
        )}

        {/* ── Input Bar ── */}
        <div className="border-t px-4 py-3 shrink-0" style={{ borderColor: 'var(--color-border)' }}>
          <div className="max-w-3xl mx-auto">
            {mode === 'transcribe' ? (
              /* STT mode: record + upload */
              <div className="flex items-center justify-center gap-4 py-2">
                <button onClick={handleRecordToggle} disabled={loading}
                  className={`flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    recorder.recording ? 'bg-red-500/20 text-red-400 ring-2 ring-red-500/30' : 'hover:bg-white/5'
                  }`}
                  style={recorder.recording ? {} : { background: 'var(--color-surface)', color: 'var(--color-text)' }}>
                  {recorder.recording ? (
                    <>
                      <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                      Recording {formatSeconds(recorder.seconds)}...
                      <Square className="w-4 h-4" />
                    </>
                  ) : (
                    <><Mic className="w-4 h-4" /> Record Audio</>
                  )}
                </button>

                <label className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer hover:bg-white/5 transition-colors ${loading ? 'opacity-50 pointer-events-none' : ''}`}
                  style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
                  <Upload className="w-4 h-4" /> Upload File
                  <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileUpload} disabled={loading} />
                </label>
              </div>
            ) : (
              /* Chat / TTS mode: text input + optional mic */
              <div className="flex items-end gap-2 border rounded-xl p-2 focus-within:ring-2 focus-within:ring-emerald-500/30 focus-within:border-emerald-600 transition-all"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
                {/* Mic button in Chat mode for voice input */}
                {mode === 'chat' && (
                  <button onClick={handleRecordToggle} disabled={loading}
                    className={`p-1.5 rounded-lg transition-colors shrink-0 ${recorder.recording ? 'bg-red-500/20' : 'hover:bg-white/5'}`}
                    title={recorder.recording ? 'Stop recording' : 'Record audio (voice-to-chat)'}>
                    {recorder.recording ? (
                      <span className="flex items-center gap-1.5 text-red-400 text-xs">
                        <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                        {formatSeconds(recorder.seconds)}
                      </span>
                    ) : (
                      <Mic className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                    )}
                  </button>
                )}

                <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  rows={1}
                  className="flex-1 bg-transparent text-sm resize-none focus:outline-none py-1.5 px-2 max-h-32"
                  style={{ color: 'var(--color-text)' }}
                  placeholder={mode === 'tts' ? 'Enter text to speak...' : 'Send a message...'}
                  disabled={loading || recorder.recording} />

                <Button size="sm" onClick={handleSend} disabled={!input.trim() || loading || recorder.recording}>
                  {mode === 'tts' ? <Volume2 className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
                </Button>
              </div>
            )}

            <div className="flex items-center justify-between mt-1.5 px-1">
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {mode === 'transcribe'
                  ? 'Record or upload audio to transcribe'
                  : mode === 'tts'
                  ? 'Enter text to synthesize speech'
                  : 'Enter to send · Shift+Enter for new line · Mic for voice input'}
              </span>
              {messages.length > 0 && (
                <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                  {messages.length} messages
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Empty State ──

function EmptyState({ mode, provider, model, onSuggestion }: {
  mode: PlaygroundMode; provider: string; model: string; onSuggestion: (text: string) => void;
}) {
  const meta = MODE_META[mode];
  const Icon = meta.icon;

  const suggestions: Record<PlaygroundMode, string[]> = {
    chat: [
      'Translate "hello world" to French',
      'Explain quantum computing simply',
      'Write a haiku about programming',
      'What is the capital of Japan?',
    ],
    transcribe: [],
    tts: [
      'Hello, welcome to BabelCast!',
      'The quick brown fox jumps over the lazy dog.',
      'Testing voice synthesis quality.',
      'Buenos días, ¿cómo estás?',
    ],
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-4">
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(16, 185, 129, 0.1)' }}>
        <Icon className="w-6 h-6" style={{ color: '#10b981' }} />
      </div>
      <div className="text-center space-y-1">
        <h3 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          {meta.label}
        </h3>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {mode === 'chat' && 'Test any LLM with a chat interface.'}
          {mode === 'transcribe' && 'Record or upload audio to test speech-to-text.'}
          {mode === 'tts' && 'Enter text to test text-to-speech synthesis.'}
          <br />
          Using <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>{provider}</span>
          {' / '}
          <span className="font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>{model}</span>
        </p>
      </div>

      {mode === 'transcribe' && (
        <div className="flex items-center gap-2 mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          <Mic className="w-4 h-4" />
          Click &quot;Record Audio&quot; or upload a file below
        </div>
      )}

      {suggestions[mode].length > 0 && (
        <div className="grid grid-cols-2 gap-2 mt-2 max-w-sm w-full">
          {suggestions[mode].map(s => (
            <button key={s} onClick={() => onSuggestion(s)}
              className="text-left text-xs p-3 rounded-xl border transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Message Bubble ──

function MessageBubble({ message, onReadAloud }: { message: ChatMessage; onReadAloud?: () => void }) {
  const isUser = message.role === 'user';

  return (
    <div className="flex gap-3 py-4 px-1">
      {/* Avatar */}
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: isUser ? 'var(--color-surface)' : 'rgba(16, 185, 129, 0.1)' }}>
        {isUser
          ? <User className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          : <Bot className="w-4 h-4" style={{ color: '#10b981' }} />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--color-text)' : '#10b981' }}>
            {isUser ? 'You' : 'Assistant'}
          </span>
          {message.meta && (
            <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
              {message.meta.provider}/{message.meta.model} &middot; {message.meta.latencyMs}ms
              {message.meta.tokens ? ` \u00b7 ${message.meta.tokens} tok` : ''}
              {message.meta.language ? ` \u00b7 lang: ${message.meta.language}` : ''}
              {message.meta.duration ? ` \u00b7 ${message.meta.duration.toFixed(1)}s` : ''}
            </span>
          )}
          {/* Read aloud button for chat assistant messages */}
          {onReadAloud && (
            <button onClick={onReadAloud}
              className="p-1 rounded hover:bg-white/5 transition-colors"
              title="Read aloud (TTS)">
              <Volume2 className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            </button>
          )}
        </div>

        <div className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--color-text)' }}>
          {message.content}
        </div>

        {/* Audio player */}
        {message.audioUrl && <AudioPlayer url={message.audioUrl} />}
      </div>
    </div>
  );
}
