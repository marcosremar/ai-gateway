# Test Coverage Analysis — @ai-gateway

Este diretório contém análise completa da cobertura de testes do pacote `@ai-gateway`.

## Documentos Gerados

1. **TEST_COVERAGE_SUMMARY.txt** — Sumário visual com tabelas ASCII
   - Visão rápida de quais arquivos precisam testes
   - Roadmap em sprints de trabalho
   - Estimativas de esforço

2. **TEST_COVERAGE_ANALYSIS.md** — Análise detalhada completa
   - Descrição de cada arquivo sem testes
   - Funções/classes exportadas
   - Complexidade
   - O que testar
   - Necessidade de API real

3. **TEST_EXAMPLES_PRIORITY_1.md** — Exemplos de testes prontos para usar
   - 4 exemplos completos de testes (Prioridade 1)
   - Padrões a seguir
   - Setup com `vitest`

## Quick Links

### Análise Rápida (5 min)
→ Leia `TEST_COVERAGE_SUMMARY.txt`

### Análise Detalhada (15-30 min)
→ Leia `TEST_COVERAGE_ANALYSIS.md`

### Começar a Implementar (Agora)
→ Use `TEST_EXAMPLES_PRIORITY_1.md` como template

---

## Status Atual

- **Total de arquivos**: 87 TypeScript files em `src/`
- **Com testes**: 51 arquivos (~59%)
- **Sem testes**: 36 arquivos (~41%)

### Breakdown

| Categoria | Arquivos | Ação |
|-----------|----------|------|
| Tipos puros | 25 | ❌ Não precisam testes |
| Pode testar (sem API) | 16 | ✅ **PRIORIDADE** |
| Precisa integração | 2 | ⚠️ Complexo |
| Já com testes | 44 | ✓ OK |

---

## Próximos Passos

### Semana 1 — Prioridade 1 (10-15 horas)
```
✓ src/browser/emitter.ts         (1-2h)
✓ src/browser/logger.ts          (1-2h)
✓ src/browser/errors.ts          (1h)
✓ src/providers/errors.ts        (2-3h)
✓ src/hooks.ts                   (2h)
```

### Semana 2-3 — Prioridade 2 (15-20 horas)
```
✓ OpenAI-compat providers (3 classes: 6-8h)
✓ OpenAI providers (3 classes: 5-6h)
```

### Semana 4 — Prioridade 2 cont. (8-10 horas)
```
✓ src/browser/streaming-audio.ts (4-5h)
✓ src/factory.ts                 (3-4h)
```

### Semanas 5-7 — Prioridade 3 (30-35 horas)
```
⚠️ src/browser/speech-client.ts   (12-15h, requer mock server)
⚠️ src/autoscaler/engine.ts       (15-20h, requer mock providers)
```

---

## Usando os Exemplos

Cada arquivo em `TEST_EXAMPLES_PRIORITY_1.md` mostra:

1. **Imports necessários**
2. **Setup (beforeEach, etc.)**
3. **Tests estruturados** com:
   - Happy path
   - Edge cases
   - Error handling
   - Type safety

### Padrão para seus testes:

```bash
# Crie o arquivo de teste
touch __tests__/seu-arquivo.test.ts

# Copie o template de TEST_EXAMPLES_PRIORITY_1.md
# Adapte imports e casos de teste
# Rode
bun test seu-arquivo.test.ts
```

---

## Ferramentas & Setup

- **Test Runner**: Vitest (já configurado)
- **Assertions**: expect() do vitest
- **Mocks**: vi.fn(), vi.spyOn()
- **Async**: suporte nativo com async/await

### Rodar testes específicos:

```bash
# Um arquivo
bun test __tests__/browser-emitter.test.ts

# Padrão
bun test __tests__/browser-*.test.ts

# Todos
bun test
```

---

## Notas Importantes

### Arquivos que NÃO Precisam Testes

**Tipos puros** (`src/types.ts`, `src/deps.ts`, etc.)
- TypeScript compilation verifica já
- Sem lógica runtime

**Índices/Exports** (`src/index.ts`, `src/*/index.ts`)
- Apenas re-exportam
- Imports já verificam existence

**Catálogos** (`src/providers/*/models.ts`)
- Apenas constantes estáticas
- Estrutura JSON

**Trivial** (`src/logger.ts`)
- Apenas delegate console
- Sem lógica

### Arquivos Complexos (Integração)

**speech-client.ts** (670 linhas)
- Orquestra 3 transports (WebRTC, WebSocket, SSE)
- Requer servidor mock para testar

**engine.ts** (796 linhas)
- Orquestra boot, health checks, state transitions
- Requer mocks de GPU providers

Para estes, considere:
- Testes de integração separados
- Servidor mock (express/http)
- Fixtures de dados

---

## Perguntas Frequentes

**P: Por que Prioridade 1 é ALTA-FÁCIL?**
R: Poucas linhas + lógica simples + sem dependências externas = rápido & alto impacto no Browser SDK

**P: Preciso fazer todos os testes?**
R: Não. Prioridade 1+2 já cobre funções críticas. Prioridade 3 é nice-to-have.

**P: Como mockar fetch?**
R: Use `vi.stubGlobal('fetch', vi.fn())` ou import mock adapter

**P: AudioContext não existe em Node?**
R: Certo. Use `vi.mock()` ou use jsdom test environment.

---

## Métricas

Após implementar **Prioridade 1 + 2**:
- ~1500 linhas de código fonte com testes
- ~3500+ linhas de testes
- Taxa de cobertura: ~75-80%
- Tempo: ~35-40 horas de work

