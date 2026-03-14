'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  detectLanguage, type DetectLanguageResponse,
  getAutoSwapStatus, toggleAutoSwap,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, CardFooter,
  Button, FormSelect, AlertBanner, CardSectionHeader, Toggle,
} from '@/components/ui';
import { ScanSearch, Play, Square, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

const LANGUAGES = [
  { code: 'fr', name: 'French' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' },
];

// ── Benchmark phrases: 50 FR + 50 EN ─────────────────────────────────────────

const FR_PHRASES = [
  "Bonjour, comment allez-vous aujourd'hui?",
  "Je suis en train de préparer une présentation pour demain",
  "La réunion commence dans cinq minutes",
  "Nous devons discuter des résultats du trimestre dernier",
  "Est-ce que vous avez terminé le rapport financier?",
  "Le projet avance bien malgré les difficultés techniques",
  "Pourriez-vous m'envoyer les documents avant midi?",
  "J'ai une question concernant le budget prévisionnel",
  "La prochaine étape consiste à valider les spécifications",
  "Il faut absolument résoudre ce problème avant vendredi",
  "Le client a demandé une modification du cahier des charges",
  "Nous avons prévu une démonstration pour la semaine prochaine",
  "Les résultats sont très encourageants cette année",
  "Je vous propose de faire un point rapide sur l'avancement",
  "L'équipe technique a identifié plusieurs points d'amélioration",
  "Le délai de livraison a été repoussé de deux semaines",
  "Merci de confirmer votre disponibilité pour jeudi",
  "La formation aura lieu dans la salle de conférence principale",
  "Nous recherchons un développeur expérimenté en intelligence artificielle",
  "Le directeur général présentera les objectifs annuels",
  "La base de données relationnelle nécessite une optimisation urgente",
  "Le serveur cloud a été migré vers une nouvelle infrastructure",
  "L'algorithme de machine learning atteint une précision de quatre-vingt-quinze pour cent",
  "Nous utilisons Docker pour le déploiement des microservices",
  "Le pipeline d'intégration continue détecte les régressions automatiquement",
  "Le médecin a prescrit un traitement antibiotique pendant dix jours",
  "Les résultats des analyses sanguines sont tout à fait normaux",
  "Le patient présente des symptômes de fatigue chronique",
  "La vaccination contre la grippe est recommandée chaque automne",
  "L'hôpital universitaire dispose d'un service d'urgences ouvert en permanence",
  "Aujourd'hui il fait très beau, le soleil brille depuis ce matin",
  "Je vais faire les courses au supermarché cet après-midi",
  "Les enfants jouent dans le jardin pendant que les parents préparent le dîner",
  "Le restaurant du coin propose un excellent menu du jour",
  "Nous avons prévu un pique-nique au parc pour dimanche prochain",
  "Le tribunal a rendu son verdict après trois semaines de délibération",
  "L'avocat de la défense a présenté de nouvelles preuves",
  "Le contrat de bail doit être renouvelé avant la fin du mois",
  "La propriété intellectuelle est protégée par le droit international",
  "Le changement climatique représente un défi majeur pour l'humanité",
  "Les énergies renouvelables sont essentielles pour la transition écologique",
  "La biodiversité marine est menacée par la pollution plastique",
  "Le recyclage des déchets électroniques pose des problèmes complexes",
  "L'intelligence artificielle transforme de nombreux secteurs économiques",
  "La conquête spatiale entre dans une nouvelle ère avec les fusées réutilisables",
  "Les recherches en physique quantique ouvrent des perspectives fascinantes",
  "Le télescope spatial a découvert une exoplanète potentiellement habitable",
  "La bourse de Paris a clôturé en hausse de deux pour cent",
  "Les taux d'intérêt restent historiquement bas cette année",
  "L'inflation a atteint son niveau le plus élevé depuis dix ans",
];

const EN_PHRASES = [
  "Hello, how are you doing today?",
  "I'm currently preparing a presentation for tomorrow",
  "The meeting starts in five minutes",
  "We need to discuss the results from last quarter",
  "Have you finished the financial report?",
  "The project is progressing well despite technical difficulties",
  "Could you send me the documents before noon?",
  "I have a question about the budget forecast",
  "The next step is to validate the specifications",
  "We absolutely need to resolve this issue before Friday",
  "The client has requested a change to the requirements",
  "We have scheduled a demonstration for next week",
  "The results are very encouraging this year",
  "I suggest we have a quick progress update",
  "The technical team has identified several areas for improvement",
  "The delivery deadline has been pushed back by two weeks",
  "Please confirm your availability for Thursday",
  "The training will take place in the main conference room",
  "We are looking for an experienced artificial intelligence developer",
  "The CEO will present the annual objectives",
  "The relational database requires urgent optimization",
  "The cloud server has been migrated to a new infrastructure",
  "The machine learning algorithm achieves ninety-five percent accuracy",
  "We use Docker for deploying our microservices",
  "The continuous integration pipeline detects regressions automatically",
  "The doctor prescribed an antibiotic treatment for ten days",
  "The blood test results are completely normal",
  "The patient shows symptoms of chronic fatigue",
  "The flu vaccination is recommended every autumn",
  "The university hospital has an emergency department open at all times",
  "Today the weather is beautiful, the sun has been shining since morning",
  "I'm going grocery shopping at the supermarket this afternoon",
  "The children are playing in the garden while the parents prepare dinner",
  "The local restaurant offers an excellent lunch special",
  "We have planned a picnic in the park for next Sunday",
  "The court delivered its verdict after three weeks of deliberation",
  "The defense attorney presented new evidence",
  "The lease agreement must be renewed before the end of the month",
  "Intellectual property is protected by international law",
  "Climate change represents a major challenge for humanity",
  "Renewable energies are essential for the ecological transition",
  "Marine biodiversity is threatened by plastic pollution",
  "Electronic waste recycling poses complex problems",
  "Artificial intelligence is transforming many economic sectors",
  "Space exploration enters a new era with reusable rockets",
  "Research in quantum physics opens fascinating perspectives",
  "The space telescope discovered a potentially habitable exoplanet",
  "The Paris stock exchange closed up two percent",
  "Interest rates remain historically low this year",
  "Inflation has reached its highest level in ten years",
];

type PhraseSet = '50' | '100' | '200';

interface BenchmarkResult {
  text: string;
  expectedLang: string;
  detectedLang: string;
  confidence: number;
  shouldSwap: boolean;
  correct: boolean;
  latencyMs: number;
}

function buildPhrases(count: PhraseSet, source: string, target: string) {
  const n = count === '50' ? 25 : count === '100' ? 50 : 50;
  const phrases: Array<{ text: string; expectedLang: string }> = [];
  for (let i = 0; i < n; i++) {
    if (i < FR_PHRASES.length) phrases.push({ text: FR_PHRASES[i], expectedLang: source });
    if (i < EN_PHRASES.length) phrases.push({ text: EN_PHRASES[i], expectedLang: target });
  }
  return phrases;
}

function computeStats(results: BenchmarkResult[], source: string, target: string) {
  const relevant = results.filter(r => r.expectedLang === source || r.expectedLang === target);
  const correct = relevant.filter(r => r.correct).length;
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;
  const totalMs = latencies.reduce((a, b) => a + b, 0);

  // False positives: source-lang phrases that triggered a swap
  const falsePositives = results.filter(r => r.expectedLang === source && r.shouldSwap).length;
  // False negatives: target-lang phrases that did NOT trigger a swap
  const falseNegatives = results.filter(r => r.expectedLang === target && !r.shouldSwap).length;
  const swapDetections = results.filter(r => r.shouldSwap).length;

  return {
    totalPhrases: results.length,
    relevantPhrases: relevant.length,
    correctCount: correct,
    accuracy: relevant.length > 0 ? correct / relevant.length : 0,
    avgLatencyMs: avg,
    p95LatencyMs: p95,
    totalMs,
    swapDetections,
    falsePositives,
    falseNegatives,
  };
}

export function LanguageDetectSection() {
  // Toggle state
  const [enabled, setEnabled] = useState(true);
  const [loadingToggle, setLoadingToggle] = useState(true);
  const [toggling, setToggling] = useState(false);

  // Shared lang selection
  const [srcLang, setSrcLang] = useState('fr');
  const [tgtLang, setTgtLang] = useState('en');

  // Single text test
  const [singleText, setSingleText] = useState('');
  const [singleResult, setSingleResult] = useState<DetectLanguageResponse | null>(null);
  const [singleTesting, setSingleTesting] = useState(false);

  // Benchmark — progressive
  const [phraseCount, setPhraseCount] = useState<PhraseSet>('100');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [totalPhrases, setTotalPhrases] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const cancelRef = useRef(false);
  const tableEndRef = useRef<HTMLDivElement>(null);

  // Fetch initial status
  useEffect(() => {
    getAutoSwapStatus()
      .then(r => setEnabled(r.enabled))
      .catch(() => {})
      .finally(() => setLoadingToggle(false));
  }, []);

  async function handleToggle(v: boolean) {
    setToggling(true);
    try {
      const r = await toggleAutoSwap(v);
      setEnabled(r.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    } finally {
      setToggling(false);
    }
  }

  async function handleSingleTest() {
    if (!singleText.trim()) return;
    setSingleTesting(true);
    setError(null);
    try {
      const result = await detectLanguage({ text: singleText, source: srcLang, target: tgtLang });
      setSingleResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed');
    } finally {
      setSingleTesting(false);
    }
  }

  const handleStopBenchmark = useCallback(() => {
    cancelRef.current = true;
  }, []);

  async function handleRunBenchmark() {
    setRunning(true);
    setError(null);
    setResults([]);
    setShowAll(false);
    cancelRef.current = false;

    const phrases = buildPhrases(phraseCount, srcLang, tgtLang);
    setTotalPhrases(phrases.length);

    try {
      for (let i = 0; i < phrases.length; i++) {
        if (cancelRef.current) break;

        const phrase = phrases[i];
        const t0 = performance.now();
        try {
          const r = await detectLanguage({ text: phrase.text, source: srcLang, target: tgtLang });
          const latency = Math.round(performance.now() - t0);

          // Determine correctness:
          // - Source-lang phrase: correct if NOT shouldSwap
          // - Target-lang phrase: correct if shouldSwap OR detected as target
          const isSource = phrase.expectedLang === srcLang;
          const correct = isSource ? !r.shouldSwap : r.shouldSwap;

          const result: BenchmarkResult = {
            text: phrase.text,
            expectedLang: phrase.expectedLang,
            detectedLang: r.language || '',
            confidence: r.confidence,
            shouldSwap: r.shouldSwap,
            correct,
            latencyMs: latency,
          };

          setResults(prev => [...prev, result]);
        } catch {
          // If a single phrase fails, record it as incorrect
          setResults(prev => [...prev, {
            text: phrase.text,
            expectedLang: phrase.expectedLang,
            detectedLang: 'error',
            confidence: 0,
            shouldSwap: false,
            correct: false,
            latencyMs: Math.round(performance.now() - t0),
          }]);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Benchmark failed');
    } finally {
      setRunning(false);
    }
  }

  const stats = results.length > 0 ? computeStats(results, srcLang, tgtLang) : null;
  const wrongResults = results.filter(r => !r.correct && (r.expectedLang === srcLang || r.expectedLang === tgtLang));
  const progress = totalPhrases > 0 ? results.length / totalPhrases : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Toggle + How it works */}
      <Card>
        <CardHeader>
          <CardSectionHeader
            icon={ScanSearch}
            color="violet"
            title="Language Detection"
            subtitle="Detects speaker language and swaps translation direction automatically"
          />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between p-4 rounded-xl" style={{ background: 'var(--color-surface)' }}>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                Language Detection
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                When enabled, the system detects when a speaker switches languages and automatically
                inverts the translation direction (e.g., FR&rarr;EN becomes EN&rarr;FR).
              </div>
            </div>
            <Toggle
              checked={enabled}
              onChange={handleToggle}
              disabled={loadingToggle || toggling}
            />
          </div>

          <div className="p-4 rounded-xl space-y-2" style={{ background: 'var(--color-surface)' }}>
            <div className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>How it works</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg)' }}>
                <div className="font-semibold mb-1" style={{ color: '#60a5fa' }}>1. Whisper Auto-Detect</div>
                GPU transcribes audio without specifying a language. Whisper&apos;s audio-level detection identifies the spoken language.
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg)' }}>
                <div className="font-semibold mb-1" style={{ color: '#a78bfa' }}>2. Word Overlap</div>
                Compares transcriptions from source and target language decoders. High overlap indicates the audio matches the target language.
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg)' }}>
                <div className="font-semibold mb-1" style={{ color: '#34d399' }}>3. Lingua Classifier</div>
                Text-based language classifier analyzes the transcribed text. Majority vote (2/3 signals) triggers the swap.
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Single Detection Test */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={ScanSearch} color="sky" title="Test Detection" subtitle="POST /v1/detect-language" />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormSelect label="Source" value={srcLang} onChange={e => setSrcLang(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <FormSelect label="Target" value={tgtLang} onChange={e => setTgtLang(e.target.value)}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Text to detect</label>
            <textarea
              value={singleText}
              onChange={e => setSingleText(e.target.value)}
              rows={3}
              className="w-full border rounded-xl text-sm p-3 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
              placeholder="Enter text to detect language (use 5+ words for best accuracy)..."
            />
          </div>
          {error && !running && <AlertBanner variant="error">{error}</AlertBanner>}
          {singleResult && (
            <div className="p-4 rounded-xl space-y-2" style={{ background: 'var(--color-surface)' }}>
              <div className="flex items-center gap-4 text-sm">
                <span><strong>Detected:</strong> {singleResult.language || '(unknown)'}</span>
                <span><strong>Confidence:</strong> {(singleResult.confidence * 100).toFixed(0)}%</span>
                <span className="flex items-center gap-1">
                  <strong>Swap:</strong>
                  {singleResult.shouldSwap
                    ? <span className="text-amber-400 font-semibold">Yes</span>
                    : <span style={{ color: 'var(--color-text-muted)' }}>No</span>}
                </span>
                <span className="font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>{singleResult.latencyMs}ms</span>
              </div>
              {!singleResult.language && (
                <div className="text-xs mt-1" style={{ color: '#fbbf24' }}>
                  <AlertTriangle className="w-3 h-3 inline mr-1" />
                  Text too short for reliable detection. Use at least 5 words / 10 characters.
                </div>
              )}
            </div>
          )}
        </CardBody>
        <CardFooter>
          <Button onClick={handleSingleTest} isLoading={singleTesting} loadingText="Detecting..." disabled={!singleText.trim()}>
            <ScanSearch className="w-4 h-4" /> Detect
          </Button>
        </CardFooter>
      </Card>

      {/* Benchmark */}
      <Card>
        <CardHeader>
          <CardSectionHeader
            icon={Play}
            color="amber"
            title="Detection Benchmark"
            subtitle="Live phrase-by-phrase language detection accuracy test"
          />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FormSelect label="Source" value={srcLang} onChange={e => setSrcLang(e.target.value)} disabled={running}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <FormSelect label="Target" value={tgtLang} onChange={e => setTgtLang(e.target.value)} disabled={running}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </FormSelect>
            <FormSelect label="Phrases" value={phraseCount} onChange={e => setPhraseCount(e.target.value as PhraseSet)} disabled={running}>
              <option value="50">50 phrases</option>
              <option value="100">100 phrases</option>
              <option value="200">200 phrases (all)</option>
            </FormSelect>
          </div>

          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Sends interleaved {srcLang.toUpperCase()}/{tgtLang.toUpperCase()} phrases one by one through the
            Lingua classifier, showing live progress, detection accuracy, swap decisions, and latency.
          </p>

          {/* Progress bar (shown while running or after completion) */}
          {(running || results.length > 0) && totalPhrases > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <span>
                  {running ? 'Running...' : 'Complete'}
                  {' '}{results.length}/{totalPhrases} phrases
                </span>
                <span className="font-mono">{(progress * 100).toFixed(0)}%</span>
              </div>
              <div className="h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--color-ink-300)' }}>
                <div
                  className="h-2.5 rounded-full transition-all duration-300"
                  style={{
                    width: `${progress * 100}%`,
                    background: running
                      ? 'linear-gradient(90deg, #60a5fa, #a78bfa)'
                      : stats && stats.accuracy >= 0.95 ? '#34d399'
                      : stats && stats.accuracy >= 0.85 ? '#fbbf24'
                      : '#f87171',
                  }}
                />
              </div>
            </div>
          )}

          {/* Live stats (update as results come in) */}
          {stats && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  {
                    label: 'Accuracy',
                    value: `${(stats.accuracy * 100).toFixed(1)}%`,
                    color: stats.accuracy >= 0.95 ? '#34d399' : stats.accuracy >= 0.85 ? '#fbbf24' : '#f87171',
                  },
                  { label: 'Avg Latency', value: `${stats.avgLatencyMs}ms` },
                  { label: 'P95 Latency', value: `${stats.p95LatencyMs}ms` },
                  { label: 'Total Time', value: `${stats.totalMs}ms` },
                  { label: 'Swaps', value: `${stats.swapDetections}/${results.length}` },
                ].map((s, i) => (
                  <div key={i} className="p-3 rounded-xl text-center" style={{ background: 'var(--color-surface)' }}>
                    <div className="text-lg font-bold font-mono" style={{ color: s.color || 'var(--color-text)' }}>{s.value}</div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* False positive/negative breakdown */}
              {(stats.falsePositives > 0 || stats.falseNegatives > 0) && (
                <div className="flex gap-4 p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
                  <div className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4" style={{ color: '#fbbf24' }} />
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      False positives ({srcLang.toUpperCase()} wrongly swapped): <strong>{stats.falsePositives}</strong>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4" style={{ color: '#f87171' }} />
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      False negatives ({tgtLang.toUpperCase()} missed swap): <strong>{stats.falseNegatives}</strong>
                    </span>
                  </div>
                </div>
              )}

              {/* Accuracy bar per language */}
              <div className="grid grid-cols-2 gap-3">
                {[srcLang, tgtLang].map(lang => {
                  const langResults = results.filter(r => r.expectedLang === lang);
                  const correct = langResults.filter(r => r.correct).length;
                  const acc = langResults.length > 0 ? correct / langResults.length : 0;
                  return (
                    <div key={lang} className="p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                          {lang.toUpperCase()} Detection
                        </span>
                        <span className="text-sm font-bold font-mono" style={{
                          color: acc >= 0.95 ? '#34d399' : acc >= 0.85 ? '#fbbf24' : '#f87171'
                        }}>
                          {correct}/{langResults.length} ({(acc * 100).toFixed(0)}%)
                        </span>
                      </div>
                      <div className="h-2 rounded-full" style={{ background: 'var(--color-ink-300)' }}>
                        <div
                          className="h-2 rounded-full transition-all duration-500"
                          style={{
                            width: `${acc * 100}%`,
                            background: acc >= 0.95 ? '#34d399' : acc >= 0.85 ? '#fbbf24' : '#f87171',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Misclassified results */}
              {wrongResults.length > 0 && !running && (
                <div className="space-y-2">
                  <div className="text-sm font-medium" style={{ color: '#f87171' }}>
                    Misclassified ({wrongResults.length})
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                          <th className="text-left py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Phrase</th>
                          <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Expected</th>
                          <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Detected</th>
                          <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Confidence</th>
                          <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Swap</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wrongResults.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                            <td className="py-2 px-2" style={{ color: 'var(--color-text)', maxWidth: 400 }}>
                              <div className="truncate" title={r.text}>{r.text.slice(0, 80)}...</div>
                            </td>
                            <td className="text-center py-2 px-2 font-mono">{r.expectedLang}</td>
                            <td className="text-center py-2 px-2 font-mono" style={{ color: '#f87171' }}>{r.detectedLang || '—'}</td>
                            <td className="text-center py-2 px-2 font-mono">{(r.confidence * 100).toFixed(0)}%</td>
                            <td className="text-center py-2 px-2">{r.shouldSwap ? 'Yes' : 'No'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Full results (collapsible) — only show after completion */}
              {!running && (
                <div>
                  <button
                    onClick={() => setShowAll(!showAll)}
                    className="text-xs font-medium hover:underline"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {showAll ? 'Hide' : 'Show'} all {results.length} results
                  </button>
                  {showAll && (
                    <div className="mt-2 overflow-x-auto max-h-96 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0" style={{ background: 'var(--color-bg)' }}>
                          <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                            <th className="text-left py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>#</th>
                            <th className="text-left py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Phrase</th>
                            <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Expected</th>
                            <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Detected</th>
                            <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Conf</th>
                            <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>Swap</th>
                            <th className="text-right py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>ms</th>
                            <th className="text-center py-2 px-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>OK</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.map((r, i) => {
                            const isRelevant = r.expectedLang === srcLang || r.expectedLang === tgtLang;
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                                <td className="py-1.5 px-2 font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>{i + 1}</td>
                                <td className="py-1.5 px-2" style={{ color: 'var(--color-text)', maxWidth: 300 }}>
                                  <div className="truncate text-xs" title={r.text}>{r.text.slice(0, 60)}</div>
                                </td>
                                <td className="text-center py-1.5 px-2 font-mono text-xs">{r.expectedLang}</td>
                                <td className="text-center py-1.5 px-2 font-mono text-xs">{r.detectedLang || '—'}</td>
                                <td className="text-center py-1.5 px-2 font-mono text-xs">{(r.confidence * 100).toFixed(0)}%</td>
                                <td className="text-center py-1.5 px-2 text-xs">{r.shouldSwap ? 'Yes' : '—'}</td>
                                <td className="text-right py-1.5 px-2 font-mono text-xs">{r.latencyMs}</td>
                                <td className="text-center py-1.5 px-2">
                                  {isRelevant ? (
                                    r.correct
                                      ? <CheckCircle2 className="w-3.5 h-3.5 inline" style={{ color: '#34d399' }} />
                                      : <XCircle className="w-3.5 h-3.5 inline" style={{ color: '#f87171' }} />
                                  ) : (
                                    <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>n/a</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Live results stream while running */}
          {running && results.length > 0 && (
            <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-xl" style={{ background: 'var(--color-surface)' }}>
              <table className="w-full text-sm">
                <thead className="sticky top-0" style={{ background: 'var(--color-surface)' }}>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <th className="text-left py-2 px-2 font-medium text-xs" style={{ color: 'var(--color-text-muted)' }}>#</th>
                    <th className="text-left py-2 px-2 font-medium text-xs" style={{ color: 'var(--color-text-muted)' }}>Phrase</th>
                    <th className="text-center py-2 px-2 font-medium text-xs" style={{ color: 'var(--color-text-muted)' }}>Detected</th>
                    <th className="text-center py-2 px-2 font-medium text-xs" style={{ color: 'var(--color-text-muted)' }}>Conf</th>
                    <th className="text-center py-2 px-2 font-medium text-xs" style={{ color: 'var(--color-text-muted)' }}>OK</th>
                  </tr>
                </thead>
                <tbody>
                  {results.slice(-15).map((r, i) => {
                    const idx = results.length - 15 + i;
                    const actualIdx = idx < 0 ? i : idx;
                    const isRelevant = r.expectedLang === srcLang || r.expectedLang === tgtLang;
                    return (
                      <tr key={actualIdx} style={{ borderBottom: '1px solid var(--color-border)' }}>
                        <td className="py-1 px-2 font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>{actualIdx + 1}</td>
                        <td className="py-1 px-2" style={{ color: 'var(--color-text)', maxWidth: 300 }}>
                          <div className="truncate text-xs" title={r.text}>{r.text.slice(0, 50)}</div>
                        </td>
                        <td className="text-center py-1 px-2 font-mono text-xs">{r.detectedLang || '—'}</td>
                        <td className="text-center py-1 px-2 font-mono text-xs">{(r.confidence * 100).toFixed(0)}%</td>
                        <td className="text-center py-1 px-2">
                          {isRelevant ? (
                            r.correct
                              ? <CheckCircle2 className="w-3 h-3 inline" style={{ color: '#34d399' }} />
                              : <XCircle className="w-3 h-3 inline" style={{ color: '#f87171' }} />
                          ) : (
                            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div ref={tableEndRef} />
            </div>
          )}
        </CardBody>
        <CardFooter>
          {running ? (
            <Button onClick={handleStopBenchmark} variant="danger">
              <Square className="w-4 h-4" /> Stop
            </Button>
          ) : (
            <Button onClick={handleRunBenchmark} isLoading={false}>
              <Play className="w-4 h-4" /> Run Benchmark
            </Button>
          )}
          {stats && (
            <span className="text-xs font-mono ml-3" style={{ color: 'var(--color-text-muted)' }}>
              {stats.correctCount}/{stats.relevantPhrases} correct in {stats.totalMs}ms
            </span>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
