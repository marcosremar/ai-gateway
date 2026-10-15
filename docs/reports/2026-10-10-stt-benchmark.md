# STT de reserva: benchmark em fala real de aprendizes (10/10/2026)

Pergunta: qual transcritor da OpenRouter (só endpoints com retenção zero, ZDR) serve melhor de reserva do `parle-stt`
para aprendizes francófonos de português? O resultado está gravado no registro de benchmarks do gateway
(`docs/model-benchmarks.md`), no conjunto `elevenlabs-pt-l2-v1`. Nenhuma rota de produção mudou.

## Dados

- **Fonte:** 372 conversas do agente ElevenLabs «Assistant de Portugais», de 09/02 a 02/04/2025, com a chamada inteira
  num mp3 só (aluno e agente misturados). O dono autorizou usá-las para testar STT, inclusive pela OpenRouter com ZDR.
  O áudio não entrou no git e não ficou em lugar público. Os recortes ficaram na pasta temporária do Mac e no
  Mésocentre só durante a medida, e foram apagados no fim.
- **Recorte dos turnos do aluno:** o `time_in_call_secs` do turno do aluno marca o fim do texto do agente, não o
  começo da fala do aluno. O piloto com esse tempo deixou a fala do agente no começo de 110 de 600 recortes. Por
  isso cada chamada passou por um Whisper large-v3-turbo com tempo por palavra (P40 do Mésocentre). O texto de cada
  turno foi alinhado às palavras. O recorte vai do fim da última palavra do agente anterior + 0,1 s até o começo da
  primeira palavra do agente seguinte − 0,1 s. Sem esse começo, o fim vira o tempo do turno seguinte − 0,2 s, e o
  piloto mostrou que esse lado não vaza fala.
  - Foram descartados: turno vazio, turno que não está entre dois turnos do agente, ordem de tempo trocada, agente
    interrompido, alinhamento falho e duração fora de 0,8–30 s.
  - O silêncio das pontas foi cortado a −40 dB e o áudio normalizado para 16 kHz mono.
  - Sobraram 1 380 turnos de 281 conversas.
- **Amostra fixa:** 600 turnos estratificados por duração (cinco faixas: 0,8–2, 2–4, 4–8, 8–15 e 15–30 s, cada faixa
  com pelo menos n/7 turnos) e espalhados por conversa (260 conversas, 4 352 s). Dentro dela há o **núcleo** de 200
  turnos (1 454 s), também estratificado, que todos os modelos rodaram.
- **Língua de cada turno:** a detecção de língua do Whisper large-v3 roda no recorte inteiro e em janelas de 4 s.
  - `pt`: o recorte inteiro sai como português e nenhuma janela sai como francês.
  - `fr`: o recorte inteiro sai como francês com p ≥ 0,7 e nenhuma janela sai como português.
  - O resto fica como `misto/incerto`: troca de língua, sotaque que o detector toma por espanhol ou italiano, ruído.
  - Na amostra de 600 turnos: **238 pt, 67 fr e 295 misto/incerto**. No núcleo: 77, 18 e 105.

## Referências

- **Prata:** a transcrição que a própria ElevenLabs gravou em 2025. É o ASR deles, não revisão humana. **Ela traduz
  o francês:** em 55 dos 67 turnos franceses, a prata está em português. Exemplo: o aluno diz «Alors j'aimerais
  pratiquer une simulation…» e a prata registra «Eu gostaria de praticar uma simulação…». Ela também apaga
  hesitações. Por isso o WER contra a prata só é calculado nos **turnos em português**.
- **Consenso:** voto palavra a palavra entre os 3 melhores sistemas contra a prata nos turnos em português, um por
  família. A família conta para que dois Whisper não votem juntos, e o scribe-v2 fica de fora por ser da mesma
  empresa da prata. Os sistemas escolhidos foram `voxtral-small-24b-2507-stt`, `whisper-large-v3` e
  `gemini-3.1-flash-lite`. Regras fixas:
  - O pivô é o melhor sistema. Cada posição recebe a palavra que tiver 2 votos de 3, e "apagar" conta como voto.
  - Uma inserção entra só quando os dois outros sistemas inserem a mesma coisa no mesmo lugar.
  - Empate fica com o pivô.
  - Os três membros saem favorecidos no WER de consenso (ver a coluna).
- **Prata × consenso nos turnos em português:** WER 0,24, e 45 % dos turnos são idênticos. Nos turnos curtos
  (0,8–2 s), a divergência é de 0,78. Lá a prata costuma ter texto que não está no recorte, ou o consenso erra
  palavras isoladas. Exemplos: prata «Algeia?» × consenso «ao gel»; prata «Que esquisito! Que esquisito!» × consenso
  «contatos». Contando todos os turnos, a divergência é de 0,42, puxada pelos turnos franceses traduzidos.
- **Régua** (`pt-norm-bridge+tags+fillers-v1`):
  1. `normalize_pt` do projeto `qwen35-audio-bridge` (minúsculas, NFC e sem pontuação).
  2. Retirada de etiquetas `<|…|>` e `[…]`.
  3. Retirada de hesitações: eh, eee, ééé, hum, hm, umm, uh, hãã, euh, mhm. O «um» fica, porque é artigo.
- **Fidelidade** (`fid-mean-probe-fr-v1`): média de duas partes.
  - A sonda de erros plantados (`bridge/fidelity.py`, 120 frases faladas por TTS com erro de gênero, verbo ou
    calque do francês): fração em que o erro foi preservado.
  - A fração dos turnos franceses do núcleo que o modelo transcreveu **em francês**. Traduzir para o português, que
    é o defeito da prata, conta como infiel.
  - O estudo precisa de um transcritor que não corrija nem traduza o aluno.

## Resultado (núcleo de 200 turnos, nota do ranking do gateway)

Os WER «pt» são calculados nos 77 turnos em português do núcleo. «FR» mostra quantos dos 18 turnos franceses o
modelo deixou em francês, traduziu para o português ou devolveu em outra língua/vazio. O TTFT foi medido deste Mac
(Paris) em 10/10/2026, 18h–19h, com 4 pedidos simultâneos por modelo e um modelo por vez. `*` = o endpoint não
fez streaming, então TTFT = latência total. O custo vem do `usage.cost` de cada resposta.

| # | modelo (OpenRouter, ZDR) | WER prata pt | WER consenso pt | WER prata, todos | sonda | FR fr/pt/outro | fidelidade | TTFT p50/p95 s | latência p50/p95 s | vazias | US$/1000 | nota |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | elevenlabs/scribe-v2 | 0,38 | 0,27 | 0,62 | 0,88 | 12/2/4 | 0,77 | 1,2/3,4* | 1,2/3,4 | 1 % | 0,22 | **0,76** |
| 2 | mistralai/voxtral-small-24b-2507-stt | 0,25 | 0,04 (membro) | 0,44 | 0,68 | 3/11/4 | 0,42 | 1,4/3,4* | 1,4/3,4 | 3 % | 0,36 | 0,74 |
| 3 | google/gemini-3.1-flash-lite | 0,33 | 0,21 (membro) | 0,67 | 0,82 | 6/5/7 | 0,57 | 1,3/1,9 | 1,4/2,1 | 0 % | 0,13 | 0,70 |
| 4 | qwen/qwen3-asr-1.7b | 0,45 | 0,36 | 0,73 | 0,76 | 13/0/5 | 0,74 | 1,2/3,1* | 1,2/3,1 | 0 % | 0,05 | 0,70 |
| 5 | mistralai/voxtral-mini-3b-2507 | 0,27 | 0,15 | 0,48 | 0,62 | 3/10/4 | 0,40 | 0,9/1,8* | 0,9/1,8 | 1 % | 0,12 | 0,69 |
| 6 | assemblyai/universal-3-5-pro | 0,35 | 0,27 | 0,57 | 0,65 | 8/4/6 | 0,55 | 0,5/1,1* | 0,5/1,1 | 4 % | 0,89 | 0,69 |
| 7 | fish-audio/transcribe-1 | 0,45 | 0,36 | 0,73 | 0,77 | 13/0/5 | 0,74 | 0,9/1,9* | 0,9/1,9 | 0 % | 0,76 | 0,69 |
| 8 | openai/whisper-large-v3 | 0,27 | 0,15 (membro) | 0,40 | 0,76 | 0/14/4 | 0,38 | 1,1/3,4* | 1,1/3,4 | 3 % | 0,23 | 0,67 |
| 9 | deepgram/nova-3 | 0,39 | 0,29 | 0,58 | 0,82 | 0/10/8 | 0,41 | 0,5/1,3* | 0,5/1,3 | 3 % | 0,51 | 0,62 |
| 10 | qwen/qwen3-asr-0.6b | 0,50 | 0,44 | 0,85 | 0,68 | 12/0/6 | 0,67 | 1,0/3,1* | 1,0/3,1 | 0 % | 0,02 | 0,62 |
| 11 | google/gemini-3.5-flash-lite | 0,37 | 0,29 | 0,59 | 0,74 | 4/7/7 | 0,48 | 1,3/1,9 | 1,4/2,2 | 0 % | 0,10 | 0,61 |
| 12 | fish-audio/transcribe-1-pro | 0,48 | 0,42 | 0,70 | 0,72 | 13/1/4 | 0,72 | 0,9/3,2* | 0,9/3,2 | 7 % | 0,76 | 0,59 |
| 13 | microsoft/mai-transcribe-2 | 0,42 | 0,36 | 0,61 | 0,85 | 8/6/4 | 0,65 | 1,8/7,5* | 1,8/7,5 | 0 % | 0,21 | 0,59 |
| 14 | microsoft/mai-transcribe-1.5 | 0,40 | 0,30 | 0,68 | 0,88 | 3/10/5 | 0,52 | 1,3/2,2* | 1,3/2,2 | 0 % | 0,76 | 0,59 |
| 15 | nvidia/parakeet-tdt-0.6b-v3 | 0,53 | 0,46 | 0,73 | 0,64 | 10/1/7 | 0,60 | 0,7/1,4* | 0,7/1,4 | 4 % | 0,18 | 0,58 |
| 16 | google/gemini-3.8-flash | 0,35 | 0,27 | 0,57 | 0,75 | 4/4/10 | 0,49 | 2,0/3,5 | 2,2/3,5 | 0 % | 0,22 | 0,55 |
| 17 | openai/whisper-large-v3-turbo (reserva atual) | 0,38 | 0,31 | 0,59 | 0,77 | 0/17/1 | 0,38 | 1,6/3,9* | 1,6/3,9 | 0 % | 0,03 | 0,52 |
| 18 | google/chirp-3 | 0,35 | 0,26 | 0,54 | 0,83 | 5/6/7 | 0,56 | 2,3/5,2* | 2,3/5,2 | 0 % | 2,04 | 0,48 |
| 19 | mistralai/voxtral-small-24b-2507 (chat) | 0,32 | 0,21 | 0,63 | 0,04 | 1/12/5 | 0,05 | 0,9/2,0 | 1,0/2,3 | 0 % | 0,68 | 0,46 |
| 20 | nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b | 0,59 | 0,53 | 0,77 | 0,77 | 0/0/18 | 0,38 | 2,7/4,1* | 2,7/4,1 | 39 % | 0,02 | 0,16 |
| ref | Whisper large-v3 local (P40) | 0,25 | 0,16 | 0,38 | 0,75 | 0/14/4 | 0,38 | 0,9/1,3 GPU | — | 1 % | 0 | — |
| ref | Qwen3-ASR-1.7B local (P40) | 0,37 | 0,29 | 0,53 | 0,78 | 0/12/6 | 0,39 | 0,8/2,0 GPU | — | 0 % | 0 | — |

Saída em outra língua nos 77 turnos em português (italiano, espanhol, chinês, francês) acontece com:

| modelo | turnos |
|---|---|
| qwen3-asr-0.6b | 12 |
| fish transcribe-1 | 9 |
| qwen3-asr-1.7b | 8 |
| fish transcribe-1-pro | 5 |
| parakeet | 4 |
| mai-transcribe-1.5 | 1 |
| todos os outros | 0 |

No conjunto de 600 turnos, os 14 modelos mais baratos mantêm a mesma ordem de WER nos turnos em português:

| modelo | WER pt |
|---|---|
| whisper-large-v3 | 0,25 |
| voxtral-small-stt | 0,27 |
| voxtral-mini-3b | 0,28 |
| gemini-3.1-flash-lite | 0,32 |
| scribe-v2 | 0,33 |
| mai-transcribe-2 | 0,34 |
| nova-3 | 0,34 |
| whisper-turbo | 0,37 |
| qwen3-asr-1.7b | 0,37 |

Em todos, a faixa de 0,8–2 s é a pior: WER de 0,5 a 0,85.

## Achados

1. **Quem respeita `language=pt`, traduz o francês:** Whisper (os dois), Deepgram nova-3 e o Qwen3-ASR local. O
   Voxtral STT e o MAI-1.5 traduzem quase sempre. A **reserva atual (`openai/whisper-large-v3-turbo`) traduziu 17 dos
   18** turnos franceses e acrescenta «Obrigado.» em silêncio. Para o registro da pesquisa, essa é a pior falha
   possível: a fala do aluno vira português correto.
2. **Quem ignora `language`, erra a língua do português:** a OpenRouter não repassa `language` ao Qwen3-ASR
   (DeepInfra). Testado com `pt`, `Portuguese`, `pt-BR` e `pt-PT`: a saída não mudou. Esse modelo, o Fish e o
   Parakeet mantêm o francês, mas devolvem italiano, espanhol ou chinês para português com sotaque.
3. **O scribe-v2 é o único que faz as duas coisas:**
   - mantém o francês (12 de 18);
   - nunca troca a língua do português (0 de 77);
   - preserva 88 % dos erros plantados;
   - custa US$ 0,22 por 1000 turnos, com 1,2 s p50.
   - Tem a nota mais alta. Vem da mesma empresa da prata, mas fica longe dela (WER 0,38 contra 0,27 do Whisper),
     então a prata não o favorece.
4. **Recusados pela política ZDR da conta:** `openai/gpt-4o-transcribe` e `mistralai/voxtral-mini-transcribe`
   devolveram 404 «guardrail». Ficaram fora do inventário por não terem endpoint ZDR: gpt-4o-mini-transcribe,
   gpt-transcribe, whisper-1, gemini-3.5-transcribe, grok-stt e muse-voice.
5. **Nemotron:** com `language`, devolve vazio em 39 % dos turnos; sem ele, devolve hebraico ou russo. Não serve.
6. **Streaming:** nenhum endpoint `/audio/transcriptions` da OpenRouter fez streaming (o pedido foi `stream=true`).
   Só os modelos de chat com áudio (Gemini, Voxtral chat) entregam texto antes do fim.

## Recomendação (o dono decide; nada mudou em produção)

- **Reserva de STT:** `openrouter:elevenlabs/scribe-v2`.
- **Segunda reserva:** `openrouter:google/gemini-3.1-flash-lite`. Faz streaming e mantém parte do francês, mas
  usa um prompt de chat.
- **Ordem proposta para o `parle-stt`:** `deployment:parle-speech` → `openrouter:elevenlabs/scribe-v2` →
  `openrouter:openai/whisper-large-v3-turbo` → `groq:whisper-large-v3-turbo`. Outra opção é declarar
  `"order": "benchmark", "benchmarkDataset": "elevenlabs-pt-l2-v1"` no primeiro elo e incluir o scribe-v2 na cadeia.
- Trocar o transcritor de reserva muda o que fica registrado da fala do aluno quando a reserva serve (regra 28 do
  babylon-cinema): é preciso registrar a mudança no capítulo de método antes.

## Limites

- **Prata não é verdade.** Ela traduz o francês, apaga hesitações e às vezes contém texto que não está no recorte.
  Os 77 turnos em português do núcleo são uma base pequena: diferenças de WER abaixo de ~0,05 não separam modelos.
- **Consenso** favorece os três membros e herda os erros que eles têm em comum, por exemplo a tradução do francês
  pelo Whisper e pelo Voxtral. Por isso o WER de consenso só é calculado nos turnos em português.
- **Língua:** a detecção do Whisper erra em português com sotaque, e por isso 49 % dos turnos ficaram como
  `misto/incerto`, fora do WER. A classificação «saída em francês ou em português» é uma heurística de palavras
  frequentes.
- **Fidelidade nas conversas reais** sem referência humana mede só a tradução do francês. A preservação do erro
  vem da sonda sintética (TTS).
- **Latência** depende da rede deste Mac. As referências locais medem só computação na P40.
- **Revisão humana:** 150 turnos ficaram prontos para o dono corrigir: os 100 com maior divergência
  prata × consenso e 50 sorteados. Estão em uma página local no próprio HD das conversas
  (`stt-review-2026-10-10/revisao.html` e `.csv`, com áudio tocado direto do mp3 original). Nada foi enviado a
  lugar nenhum. As hipóteses de todos os modelos ficaram arquivadas ao lado, para recalcular sem gastar de novo.

## Gasto

| Item | US$ |
|---|---|
| Testes iniciais e pilotos de recorte | 0,13 |
| Sonda | 0,42 |
| Núcleo (20 modelos × 200 turnos) | 1,64 |
| Resto da amostra (14 modelos × 400 turnos) | 1,06 |
| **Total** | **3,24** (teto: 4,00) |

Saldo da OpenRouter: de 5,59 para 2,35. O Mésocentre (P40) foi usado para o alinhamento, a detecção de língua e as
duas referências locais, sem custo e sem Vast.

## Gravar em produção depois do deploy

```bash
AI_GATEWAY_ADMIN_KEY=… bun scripts/stt-bench/record.ts scripts/stt-bench/elevenlabs-pt-l2-v1.json https://parle-ai-gateway.up.railway.app
```

`scripts/stt-bench/elevenlabs-pt-l2-v1.json` tem só os números agregados, sem áudio nem transcrições. O pipeline
que os gerou está em `scripts/stt-bench/pipeline/`: recorte, alinhamento no Mésocentre, chamadas, régua, consenso e
página de revisão.
