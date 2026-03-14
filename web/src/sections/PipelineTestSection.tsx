'use client';

import { useState, useRef } from 'react';
import { translate, ttsPreview } from '@/lib/gateway';
import { Card, CardHeader, CardBody, CardFooter, Button, FormInput, FormSelect, AlertBanner, CardSectionHeader } from '@/components/ui';
import { Languages, Volume2, ArrowRight } from 'lucide-react';

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
];

const TTS_VOICES = ['Ryan', 'Aria', 'Luna', 'Davis', 'Jenny'];

export function PipelineTestSection() {
  // Translation
  const [srcLang, setSrcLang] = useState('fr');
  const [tgtLang, setTgtLang] = useState('en');
  const [inputText, setInputText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [translateUsedGpu, setTranslateUsedGpu] = useState<boolean | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateLatency, setTranslateLatency] = useState<number | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);

  // TTS
  const [ttsText, setTtsText] = useState('');
  const [ttsVoice, setTtsVoice] = useState('Ryan');
  const [ttsLang, setTtsLang] = useState('English');
  const [synthesizing, setSynthesizing] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  async function handleTranslate() {
    if (!inputText.trim()) return;
    setTranslating(true);
    setTranslateError(null);
    const start = performance.now();
    try {
      const result = await translate({ text: inputText, source_lang: srcLang, target_lang: tgtLang });
      setTranslateLatency(Math.round(performance.now() - start));
      setTranslatedText(result.translated_text);
      setTranslateUsedGpu(result.used_gpu);
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : 'Translation failed');
    } finally {
      setTranslating(false);
    }
  }

  async function handleTts() {
    if (!ttsText.trim()) return;
    setSynthesizing(true);
    setTtsError(null);
    try {
      const blob = await ttsPreview({ text: ttsText, speaker: ttsVoice, language: ttsLang });
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play();
      }
    } catch (e) {
      setTtsError(e instanceof Error ? e.message : 'TTS failed');
    } finally {
      setSynthesizing(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Translation Test */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Languages} color="emerald" title="Translation Test" subtitle="POST /v1/translate" />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <FormSelect label="Source" value={srcLang} onChange={e => setSrcLang(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <ArrowRight className="w-5 h-5 mb-3" style={{ color: 'var(--color-text-muted)' }} />
            <FormSelect label="Target" value={tgtLang} onChange={e => setTgtLang(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Input text</label>
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              rows={3}
              className="w-full border rounded-xl text-sm p-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
              placeholder="Enter text to translate..."
            />
          </div>
          {translateError && <AlertBanner variant="error">{translateError}</AlertBanner>}
          {translatedText && (
            <div className="p-4 rounded-xl" style={{ background: 'var(--color-surface)' }}>
              <div className="text-xs mb-1 flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
                Result
                {translateLatency && <span className="font-mono">({translateLatency}ms)</span>}
                {translateUsedGpu !== null && <span>{translateUsedGpu ? 'GPU' : 'Cloud'}</span>}
              </div>
              <div>{translatedText}</div>
            </div>
          )}
        </CardBody>
        <CardFooter>
          <Button onClick={handleTranslate} isLoading={translating} loadingText="Translating..." disabled={!inputText.trim()}>
            Translate
          </Button>
        </CardFooter>
      </Card>

      {/* TTS Preview */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Volume2} color="violet" title="TTS Preview" subtitle="POST /v1/tts" />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormSelect label="Voice" value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
              {TTS_VOICES.map(v => <option key={v} value={v}>{v}</option>)}
            </FormSelect>
            <FormInput label="Language" value={ttsLang} onChange={e => setTtsLang(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Text to speak</label>
            <textarea
              value={ttsText}
              onChange={e => setTtsText(e.target.value)}
              rows={2}
              className="w-full border rounded-xl text-sm p-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
              placeholder="Enter text for TTS..."
            />
          </div>
          {ttsError && <AlertBanner variant="error">{ttsError}</AlertBanner>}
          <audio ref={audioRef} controls className="w-full" style={{ display: audioRef.current?.src ? 'block' : 'none' }} />
        </CardBody>
        <CardFooter>
          <Button onClick={handleTts} isLoading={synthesizing} loadingText="Synthesizing..." disabled={!ttsText.trim()}>
            <Volume2 className="w-4 h-4" /> Speak
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
