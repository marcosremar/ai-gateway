export interface KokoroPhrase {
  id: string;
  text: string;
}

export interface KokoroDatasetShard {
  index: number;
  worker: string;
  phrases: KokoroPhrase[];
}

export interface KokoroDatasetPlan {
  kind: 'kokoro-tts-dataset-prep';
  voice: string;
  language: 'pt-BR';
  sampleRate: 24000;
  format: 'wav';
  phraseCount: number;
  workerCount: number;
  r2Uri: string;
  gpuRequired: false;
  trainingEnabled: false;
  shards: Array<{
    index: number;
    worker: string;
    phraseCount: number;
    firstId: string;
    lastId: string;
    r2Uri: string;
  }>;
}

export interface KokoroDatasetRequest {
  phrases?: number;
  workers?: number;
  voice?: string;
  r2Uri?: string;
  speed?: number;
  phraseSource?: 'template' | 'gateway';
  gatewayUrl?: string;
  gatewayKey?: string;
  gatewayModel?: string;
}

export interface KokoroDatasetRunRequest extends KokoroDatasetRequest {
  yes?: boolean;
  maxWorkers?: number;
  snapshot?: string;
  autoStopMinutes?: number;
  autoDeleteMinutes?: number;
  timeoutS?: number;
  stallS?: number;
  env?: Record<string, string | undefined>;
  daytona?: DaytonaLike;
}

export interface KokoroDatasetRunResult {
  status: 'done';
  elapsedS: number;
  createdSandboxes: string[];
  results: Array<{
    shard: number;
    sandboxId: string;
    phrases: number;
    r2Uri: string;
    tail: string;
  }>;
}

export interface DaytonaLike {
  create(opts: { autoStopMinutes: number; snapshot?: string }): Promise<{ id: string }>;
  setAutoDelete(id: string, minutes: number): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  exec(id: string, command: string, timeoutS?: number): Promise<{ exitCode: number; result: string }>;
  execDetached(id: string, command: string, logFile: string): Promise<void>;
  execWait(id: string, match: string, logFile: string, opts: { timeoutS: number; stallS: number }): Promise<string>;
}

export const KOKORO_DATASET_DEFAULTS = {
  phrases: 100,
  workers: 20,
  voice: 'pf_dora',
  r2Uri: 'r2://kokoro-datasets/pf_dora/pt-br-smoke',
  speed: 1.0,
  maxWorkers: 20,
  snapshot: 'daytona-medium',
  autoStopMinutes: 10,
  autoDeleteMinutes: 30,
  timeoutS: 3600,
  stallS: 900,
} as const;

const REQUIRED_R2_ENVS = ['R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

export function generatePortugueseTemplatePhrases(count: number = KOKORO_DATASET_DEFAULTS.phrases): KokoroPhrase[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('phrases must be a positive integer');
  }

  const openings = [
    'Hoje eu gostaria de comprar',
    'Bom dia, voce poderia separar',
    'Por favor, eu preciso de',
    'Antes de sair, vou pedir',
    'Depois da aula, quero experimentar',
    'No caminho para casa, vou levar',
    'Para o cafe da manha, prefiro',
    'Se ainda estiver fresco, eu quero',
    'Quando chegar minha vez, vou pedir',
    'Com licenca, voce tem',
  ];
  const objects = [
    'um pao frances bem quentinho',
    'dois croissants de manteiga',
    'uma fatia de bolo de laranja',
    'um cafe pequeno sem acucar',
    'uma garrafa de agua mineral',
    'tres paes de queijo',
    'um sanduiche simples para viagem',
    'meia duzia de paezinhos',
    'uma torta salgada pequena',
    'um suco natural de maracuja',
  ];
  const endings = [
    'para comer agora.',
    'porque estou com um pouco de pressa.',
    'e pagar no cartao, por gentileza.',
    'se nao for incomodo.',
    'para dividir com meus colegas.',
    'antes que a padaria fique cheia.',
    'com uma sacola pequena, obrigado.',
    'e tambem saber o preco total.',
    'quando estiver pronto.',
    'para levar para minha familia.',
  ];

  const seen = new Set<string>();
  const phrases: KokoroPhrase[] = [];
  for (const opening of openings) {
    for (const object of objects) {
      for (const ending of endings) {
        const text = `${opening} ${object} ${ending}`;
        if (seen.has(text)) continue;
        seen.add(text);
        phrases.push({ id: `utt_${String(phrases.length).padStart(5, '0')}`, text });
        if (phrases.length === count) return phrases;
      }
    }
  }

  let seed = 20260601;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
  const times = [
    'Hoje cedo', 'Ainda hoje', 'Amanha de manha', 'No fim da tarde', 'Durante a reuniao',
    'Antes do almoco', 'Depois da aula', 'No caminho para casa', 'Na proxima semana',
    'Quando a loja abrir', 'Assim que possivel', 'Depois do expediente', 'No sabado',
    'Na segunda-feira', 'Logo depois da chuva', 'Antes da viagem', 'Durante o atendimento',
  ];
  const subjects = [
    'a professora', 'o cliente', 'minha irma', 'o tecnico', 'a medica', 'o gerente',
    'a atendente', 'o motorista', 'a pesquisadora', 'o estudante', 'a vizinha',
    'o coordenador', 'a enfermeira', 'o vendedor', 'a artista', 'o jornalista',
    'a familia', 'o grupo', 'a equipe', 'o produtor', 'a crianca', 'o consultor',
    'a advogada', 'o padeiro', 'a dentista', 'o analista', 'a bibliotecaria',
  ];
  const verbs = [
    'confirmou', 'explicou', 'separou', 'organizou', 'revisou', 'anotou', 'preparou',
    'entregou', 'avaliou', 'comparou', 'encontrou', 'sugeriu', 'respondeu',
    'apresentou', 'guardou', 'comprou', 'reservou', 'corrigiu', 'terminou',
    'encaminhou', 'descreveu', 'planejou', 'avisou', 'perguntou',
  ];
  const objects2 = [
    'o horario da consulta', 'a lista de compras', 'o relatorio da semana',
    'o pedido de cafe', 'a chave do escritorio', 'a receita do bolo',
    'o endereco da clinica', 'a mensagem para o cliente', 'o orcamento da reforma',
    'a agenda da manha', 'o material da escola', 'a entrega do mercado',
    'o roteiro da entrevista', 'a resposta do suporte', 'o comprovante de pagamento',
    'a proposta do projeto', 'o resultado do exame', 'a reserva do hotel',
    'o cardapio do almoco', 'a senha temporaria', 'a atualizacao do sistema',
    'o aviso para os moradores', 'a escala da equipe', 'o mapa do bairro',
    'a confirmacao da inscricao', 'o resumo da noticia', 'a previsao do tempo',
    'o documento assinado', 'a explicacao do professor', 'o plano de viagem',
  ];
  const details = [
    'com bastante calma', 'sem fazer barulho', 'antes que ficasse tarde',
    'para evitar confusao', 'com todos os detalhes', 'em poucos minutos',
    'de forma simples', 'com uma observacao importante', 'para facilitar o trabalho',
    'sem esquecer nenhum item', 'com uma voz tranquila', 'do jeito combinado',
    'para ajudar a equipe', 'com atencao ao prazo', 'sem pressa nenhuma',
    'para deixar tudo claro', 'com uma pausa no final', 'e agradeceu em seguida',
  ];
  const requests = [
    'me avise quando o pedido estiver pronto',
    'confirme se o pagamento foi aprovado',
    'explique novamente o caminho ate a estacao',
    'separe uma copia do documento',
    'mande a resposta depois da reuniao',
    'verifique se ainda ha vaga disponivel',
    'anote meu telefone no cadastro',
    'reserve dois lugares perto da janela',
    'traga agua sem gas para a mesa',
    'leia a mensagem em voz alta',
    'mande o arquivo para o email correto',
    'espere mais cinco minutos antes de sair',
  ];
  const starters = [
    'Por favor', 'Com licenca', 'Se puder', 'Quando tiver um minuto',
    'Antes de continuar', 'So para confirmar', 'Caso nao seja incomodo',
    'Assim que voce conseguir', 'Para deixar registrado',
  ];
  const places = [
    'na padaria do centro', 'no consultorio', 'na escola do bairro', 'no escritorio',
    'na biblioteca', 'no mercado', 'na recepcao do predio', 'na estacao de onibus',
    'no laboratorio', 'na cozinha de casa', 'na sala de espera', 'no pequeno restaurante',
  ];
  const feelings = [
    'tranquila', 'animada', 'cuidadosa', 'curiosa', 'atenta', 'confiante',
    'surpresa', 'aliviada', 'satisfeita', 'preocupada', 'esperancosa',
  ];
  const topics = [
    'saude', 'educacao', 'tecnologia', 'seguranca', 'culinaria', 'viagem',
    'trabalho', 'atendimento', 'financas', 'clima', 'transporte', 'familia',
    'musica', 'cinema', 'esporte', 'pesquisa', 'moradia', 'jardinagem',
  ];
  const templates = [
    '{time}, {subject} {verb} {object} {detail}.',
    '{starter}, {request}, porque precisamos resolver isso hoje.',
    '{time}, {subject} ficou {feeling} quando recebeu {object}.',
    'A conversa sobre {topic} aconteceu {place} {detail}.',
    '{subjectCap} {verb} {object} {place} e depois voltou para casa.',
    '{starter}, eu gostaria de saber se {object} ja esta disponivel.',
    '{time}, nos conversamos sobre {topic} {detail}.',
    'Ela pediu que alguem {request} {detail}.',
    'O aviso sobre {topic} foi publicado {place} {detail}.',
    '{subjectCap} disse que {object} precisava ser revisado {detail}.',
  ];
  for (let attempts = 0; phrases.length < count && attempts < count * 20; attempts += 1) {
    const subject = pick(subjects);
    const subjectCap = subject.slice(0, 1).toUpperCase() + subject.slice(1);
    let text = pick(templates)
      .replace('{time}', pick(times))
      .replaceAll('{subject}', subject)
      .replace('{subjectCap}', subjectCap)
      .replace('{verb}', pick(verbs))
      .replaceAll('{object}', pick(objects2))
      .replaceAll('{detail}', pick(details))
      .replace('{starter}', pick(starters))
      .replace('{request}', pick(requests))
      .replace('{place}', pick(places))
      .replace('{feeling}', pick(feelings))
      .replace('{topic}', pick(topics));
    text = text.replace(/\s+/g, ' ').trim();
    if (text.split(/\s+/).length < 6 || text.length < 35 || text.length > 180) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    phrases.push({ id: `utt_${String(phrases.length).padStart(5, '0')}`, text });
  }
  if (phrases.length === count) return phrases;
  throw new Error(`only generated ${phrases.length} unique phrases`);
}

export function parseGatewayPhraseList(content: string): string[] {
  let text = content.trim();
  if (text.startsWith('```')) {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.startsWith('```')) lines.shift();
    if (lines[lines.length - 1]?.startsWith('```')) lines.pop();
    text = lines.join('\n').trim();
  }
  if (!text.startsWith('[')) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('gateway phrase response must be a JSON list');
  return parsed.map((item) => String(item).trim()).filter(Boolean);
}

export async function generatePhrasesWithGateway(req: KokoroDatasetRequest): Promise<KokoroPhrase[]> {
  const count = req.phrases ?? KOKORO_DATASET_DEFAULTS.phrases;
  const gatewayUrl = req.gatewayUrl || process.env.AI_GATEWAY_URL || 'http://localhost:4000';
  const gatewayKey = req.gatewayKey || process.env.AIGW_APP_KEY;
  const body = {
    model: req.gatewayModel || process.env.AI_GATEWAY_MODEL || 'auto',
    messages: [
      { role: 'system', content: 'Voce cria frases variadas para dataset de fala.' },
      {
        role: 'user',
        content: `Gere exatamente ${count} frases curtas e naturais em portugues brasileiro para um dataset de TTS. Use situacoes cotidianas de padaria, escola, rua, familia, trabalho e atendimento. Responda somente JSON: uma lista de strings.`,
      },
    ],
    temperature: 0.9,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (gatewayKey) headers.Authorization = `Bearer ${gatewayKey}`;
  const res = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`gateway phrase generation failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const payload = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('gateway phrase generation returned no content');
  const unique = [...new Set(parseGatewayPhraseList(content))];
  if (unique.length < count) {
    throw new Error(`gateway returned only ${unique.length} unique phrases`);
  }
  return unique.slice(0, count).map((text, i) => ({ id: `utt_${String(i).padStart(5, '0')}`, text }));
}

export async function loadKokoroDatasetPhrases(req: KokoroDatasetRequest): Promise<KokoroPhrase[]> {
  return req.phraseSource === 'gateway'
    ? generatePhrasesWithGateway(req)
    : generatePortugueseTemplatePhrases(req.phrases ?? KOKORO_DATASET_DEFAULTS.phrases);
}

export function shardKokoroPhrases(phrases: KokoroPhrase[], workers: number): KokoroDatasetShard[] {
  if (!Number.isInteger(workers) || workers <= 0) throw new Error('workers must be a positive integer');
  const activeWorkers = Math.min(workers, phrases.length);
  const size = Math.ceil(phrases.length / activeWorkers);
  const shards: KokoroDatasetShard[] = [];
  for (let index = 0; index < activeWorkers; index++) {
    const chunk = phrases.slice(index * size, (index + 1) * size);
    if (chunk.length > 0) shards.push({ index, worker: `worker-${String(index).padStart(2, '0')}`, phrases: chunk });
  }
  return shards;
}

export function buildKokoroDatasetPlan(phrases: KokoroPhrase[], req: KokoroDatasetRequest): KokoroDatasetPlan {
  const workers = req.workers ?? KOKORO_DATASET_DEFAULTS.workers;
  const voice = req.voice ?? KOKORO_DATASET_DEFAULTS.voice;
  const r2Uri = (req.r2Uri ?? KOKORO_DATASET_DEFAULTS.r2Uri).replace(/\/+$/, '');
  const shards = shardKokoroPhrases(phrases, workers);
  return {
    kind: 'kokoro-tts-dataset-prep',
    voice,
    language: 'pt-BR',
    sampleRate: 24_000,
    format: 'wav',
    phraseCount: phrases.length,
    workerCount: shards.length,
    r2Uri,
    gpuRequired: false,
    trainingEnabled: false,
    shards: shards.map(shard => ({
      index: shard.index,
      worker: shard.worker,
      phraseCount: shard.phrases.length,
      firstId: shard.phrases[0]!.id,
      lastId: shard.phrases[shard.phrases.length - 1]!.id,
      r2Uri: `${r2Uri}/shards/${String(shard.index).padStart(2, '0')}`,
    })),
  };
}

export function r2ToS3Uri(r2Uri: string): string {
  if (!r2Uri.startsWith('r2://')) throw new Error('r2Uri must start with r2://');
  return `s3://${r2Uri.slice('r2://'.length).replace(/^\/+|\/+$/g, '')}`;
}

export function encodeShardJsonl(shard: KokoroDatasetShard): string {
  return shard.phrases.map(phrase => JSON.stringify(phrase)).join('\n');
}

export function buildKokoroWorkerScript(shard: KokoroDatasetShard, req: KokoroDatasetRequest): string {
  const voice = req.voice ?? KOKORO_DATASET_DEFAULTS.voice;
  const speed = req.speed ?? KOKORO_DATASET_DEFAULTS.speed;
  const r2Root = (req.r2Uri ?? KOKORO_DATASET_DEFAULTS.r2Uri).replace(/\/+$/, '');
  const s3Uri = r2ToS3Uri(`${r2Root}/shards/${String(shard.index).padStart(2, '0')}`);
  const payload = encodeShardJsonl(shard);
  const python = `
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline

voice = ${JSON.stringify(voice)}
speed = ${JSON.stringify(speed)}
sample_rate = 24000
pipeline = KPipeline(lang_code="p", device="cpu")
Path("audio").mkdir(exist_ok=True)

with open("metadata.jsonl", "w", encoding="utf-8") as meta:
    for line in Path("phrases.jsonl").read_text(encoding="utf-8").splitlines():
        item = json.loads(line)
        chunks = []
        started = time.time()
        for _gs, _ps, audio in pipeline(item["text"], voice=voice, speed=speed):
            if audio is not None:
                chunks.append(audio)
        if not chunks:
            raise RuntimeError(f"no audio generated for {item['id']}")
        audio_np = np.concatenate(chunks)
        rel = f"audio/{item['id']}.wav"
        sf.write(rel, audio_np, sample_rate, subtype="PCM_16")
        meta.write(json.dumps({
            "id": item["id"],
            "text": item["text"],
            "audio": rel,
            "voice": voice,
            "language": "pt-BR",
            "sample_rate": sample_rate,
            "duration_s": round(len(audio_np) / sample_rate, 3),
            "generation_s": round(time.time() - started, 3),
        }, ensure_ascii=False) + "\\n")
`.trim();
  return `set -euo pipefail
: "\${R2_ENDPOINT_URL:?missing R2_ENDPOINT_URL}"
: "\${R2_ACCESS_KEY_ID:?missing R2_ACCESS_KEY_ID}"
: "\${R2_SECRET_ACCESS_KEY:?missing R2_SECRET_ACCESS_KEY}"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="\${AWS_DEFAULT_REGION:-auto}"
export HF_HOME="\${HF_HOME:-$HOME/.cache/huggingface}"
export HF_HUB_DISABLE_TELEMETRY=1

work="$HOME/kokoro-dataset-${shard.worker}"
rm -rf "$work"
mkdir -p "$work/audio"
cd "$work"
cat > phrases.jsonl <<'PHRASES_JSONL'
${payload}
PHRASES_JSONL

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip wheel
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
python -m pip install "kokoro>=0.9.4" "misaki[pt]>=0.9.4" soundfile numpy awscli
cat > generate.py <<'PY'
${python}
PY
python generate.py
aws --endpoint-url "$R2_ENDPOINT_URL" s3 sync . ${quoteShell(s3Uri)}
`.trim();
}

export function validateKokoroRunRequest(req: KokoroDatasetRunRequest): void {
  if (!req.yes) throw new Error('refusing real execution without --yes');
  const workers = req.workers ?? KOKORO_DATASET_DEFAULTS.workers;
  const maxWorkers = req.maxWorkers ?? KOKORO_DATASET_DEFAULTS.maxWorkers;
  if (workers > maxWorkers) throw new Error(`refusing workers=${workers}; maxWorkers=${maxWorkers}`);
  const env = req.env ?? process.env;
  const missing = REQUIRED_R2_ENVS.filter(name => !env[name]);
  if (missing.length > 0) throw new Error(`missing R2 env vars: ${missing.join(', ')}`);
  if (!env.DAYTONA_API_KEY && !env.DAYTONA_KEY) throw new Error('missing DAYTONA_API_KEY or DAYTONA_KEY');
}

export async function runKokoroDatasetFanout(req: KokoroDatasetRunRequest): Promise<KokoroDatasetRunResult> {
  validateKokoroRunRequest(req);
  const env = req.env ?? process.env;
  const daytona = req.daytona ?? new DaytonaRestClient(env.DAYTONA_API_KEY || env.DAYTONA_KEY || '');
  const phrases = await loadKokoroDatasetPhrases(req);
  const shards = shardKokoroPhrases(phrases, req.workers ?? KOKORO_DATASET_DEFAULTS.workers);
  const started = Date.now();
  const createdSandboxes: string[] = [];

  const results = await Promise.all(shards.map(async (shard) => {
    const sandbox = await daytona.create({
      autoStopMinutes: req.autoStopMinutes ?? KOKORO_DATASET_DEFAULTS.autoStopMinutes,
      snapshot: req.snapshot ?? KOKORO_DATASET_DEFAULTS.snapshot,
    });
    createdSandboxes.push(sandbox.id);
    await daytona.setAutoDelete(sandbox.id, req.autoDeleteMinutes ?? KOKORO_DATASET_DEFAULTS.autoDeleteMinutes);
    await daytona.start(sandbox.id);
    for (const name of REQUIRED_R2_ENVS) {
      await daytona.exec(sandbox.id, `printf %s ${quoteShell(env[name] || '')} > /tmp/${name}`, 30);
    }
    const envPrefix = REQUIRED_R2_ENVS.map(name => `export ${name}=$(cat /tmp/${name})`).join('; ');
    const logFile = `/tmp/kokoro-dataset-${String(shard.index).padStart(2, '0')}.log`;
    await daytona.execDetached(sandbox.id, `${envPrefix}; ${buildKokoroWorkerScript(shard, req)}`, logFile);
    const tail = await daytona.execWait(sandbox.id, 'kokoro-dataset', logFile, {
      timeoutS: req.timeoutS ?? KOKORO_DATASET_DEFAULTS.timeoutS,
      stallS: req.stallS ?? KOKORO_DATASET_DEFAULTS.stallS,
    });
    await daytona.stop(sandbox.id);
    return {
      shard: shard.index,
      sandboxId: sandbox.id,
      phrases: shard.phrases.length,
      r2Uri: `${(req.r2Uri ?? KOKORO_DATASET_DEFAULTS.r2Uri).replace(/\/+$/, '')}/shards/${String(shard.index).padStart(2, '0')}`,
      tail: tail.slice(-1000),
    };
  }));

  return {
    status: 'done',
    elapsedS: Math.round((Date.now() - started) / 100) / 10,
    createdSandboxes,
    results: results.sort((a, b) => a.shard - b.shard),
  };
}

export function formatKokoroDatasetPlan(plan: KokoroDatasetPlan): string {
  return JSON.stringify(plan, null, 2);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class DaytonaRestClient implements DaytonaLike {
  private readonly api = process.env.DAYTONA_API_URL || 'https://app.daytona.io/api';
  private static readonly successSentinel = 'AIGW_KOKORO_DONE_b6d3f1';
  private static readonly failureSentinel = 'AIGW_KOKORO_FAILED_b6d3f1';

  constructor(private readonly key: string) {}

  async create(opts: { autoStopMinutes: number; snapshot?: string }): Promise<{ id: string }> {
    const body: Record<string, unknown> = { autoStopInterval: opts.autoStopMinutes };
    if (opts.snapshot) body.snapshot = opts.snapshot;
    const payload = await this.request('POST', '/sandbox', body, 120);
    const id = String(payload.id || '');
    if (!id) throw new Error('Daytona did not return sandbox id');
    return { id };
  }

  async setAutoDelete(id: string, minutes: number): Promise<void> {
    await this.request('POST', `/sandbox/${id}/autodelete/${minutes}`, undefined, 60);
  }

  async start(id: string): Promise<void> {
    try {
      await this.request('POST', `/sandbox/${id}/start`, undefined, 120);
    } catch (err) {
      if (!String(err).includes('409')) throw err;
    }
    await this.waitState(id, 'started');
  }

  async stop(id: string): Promise<void> {
    try {
      await this.request('POST', `/sandbox/${id}/stop`, undefined, 60);
    } catch (err) {
      if (!String(err).includes('409')) throw err;
    }
  }

  async exec(id: string, command: string, timeoutS = 120): Promise<{ exitCode: number; result: string }> {
    const encoded = Buffer.from(command).toString('base64');
    const payload = await this.request('POST', `/toolbox/${id}/toolbox/process/execute`, {
      command: `echo ${encoded} | base64 -d | bash -l`,
    }, timeoutS);
    return { exitCode: Number(payload.exitCode ?? 0), result: String(payload.result ?? '') };
  }

  async execDetached(id: string, command: string, logFile: string): Promise<void> {
    const quotedLog = quoteShell(logFile);
    const wrapped = `set -e; trap 'code=$?; echo ${DaytonaRestClient.failureSentinel}:$code >>${quotedLog}; exit $code' ERR; ${command}; echo ${DaytonaRestClient.successSentinel} >>${quotedLog}`;
    await this.exec(id, `nohup bash -lc ${JSON.stringify(wrapped)} >${quotedLog} 2>&1 & echo started`, 30);
  }

  async execWait(id: string, match: string, logFile: string, opts: { timeoutS: number; stallS: number }): Promise<string> {
    const started = Date.now();
    let lastSize = -1;
    let lastGrowth = Date.now();
    while (true) {
      const { result } = await this.exec(id, `test -f ${quoteShell(logFile)} && tail -c 8000 ${quoteShell(logFile)} || true`, 30);
      if (result.includes(DaytonaRestClient.failureSentinel)) {
        throw new Error(`${match} worker failed:\n${result.replace(DaytonaRestClient.failureSentinel, '').slice(-3000)}`);
      }
      if (result.includes(DaytonaRestClient.successSentinel)) return result.replace(DaytonaRestClient.successSentinel, '');
      const size = result.length;
      if (size > lastSize) {
        lastSize = size;
        lastGrowth = Date.now();
      }
      if ((Date.now() - started) / 1000 > opts.timeoutS) {
        await this.exec(id, `pkill -9 -f ${quoteShell(match)} 2>/dev/null || true`, 30);
        throw new Error(`timeout waiting for ${match}`);
      }
      if ((Date.now() - lastGrowth) / 1000 > opts.stallS) {
        await this.exec(id, `pkill -9 -f ${quoteShell(match)} 2>/dev/null || true`, 30);
        throw new Error(`stall waiting for ${match}`);
      }
      await sleep(3000);
    }
  }

  private async waitState(id: string, target: string): Promise<void> {
    const started = Date.now();
    while ((Date.now() - started) < 120_000) {
      const payload = await this.request('GET', `/sandbox/${id}`, undefined, 60);
      if (payload.state === target) return;
      await sleep(2000);
    }
    throw new Error(`${id} not ${target} after 120s`);
  }

  private async request(method: string, path: string, body?: unknown, timeoutS = 60): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
