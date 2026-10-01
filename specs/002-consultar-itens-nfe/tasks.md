---

description: "Tarefas de implementação para consultar itens declarados em NF-e de entrada"
---

# Tasks: Consultar itens de NF-e de entrada

**Input**: `specs/002-consultar-itens-nfe/spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/itens-api.yaml` e `quickstart.md`.

**Tests**: exigidos pelos cenários de aceite e critérios SC-001 a SC-009. Usar XML sintético, `node:test` e MSSQL isolado; escrever os testes de cada fase antes da respectiva implementação e confirmar que falham pelo comportamento ausente.

**Organization**: tarefas agrupadas por história. A US1 é o primeiro incremento testável; o aceite da funcionalidade requer US1, US2 e US3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: tarefas que podem avançar em paralelo após suas dependências, em arquivos diferentes.
- **[Story]**: história da especificação (`US1`, `US2`, `US3`).
- Todos os caminhos são relativos à raiz do repositório.

## Phase 1: Setup

**Purpose**: fechar o mapeamento de leiaute necessário ao extrator, sem iniciar outro projeto ou adicionar dependências.

- [X] T001 Conferir os esquemas XML oficiais em uso contra o MOC, enumerar variantes e campos de situação/base/alíquota/valor dos quatro grupos principais e os grupos irmãos fora do escopo em `specs/002-consultar-itens-nfe/research.md`.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: preparar persistência e permissões compartilhadas pelas três histórias.

- [X] T002 Escrever testes de migração em `tests/triagem.test.ts` para aplicação/reaplicação/rollback isolados de `002`, PK/FK e JSON válido de `ItensNfeExtraidos`, unicidade de falha `ITEM_EXTRACTION` aberta por versão e negação de `UPDATE`/`DELETE` à credencial de execução.
- [X] T003 Criar `migrations/002_itens_nfe.sql` com uma linha de itens completos por `xmlOccurrenceId`, `itemsJson`, `extractedAt`, permissões restritas e extensão aditiva de `FalhaIntegracao` com FK, obrigatoriedade para `ITEM_EXTRACTION` e índice único filtrado.
- [X] T004 Registrar a versão `002` no executor de migrações em `src/db.ts` e comprovar com `tests/triagem.test.ts` que T002 passa em MSSQL isolado, sem aplicar migração a ambiente não inspecionado.

**Checkpoint**: o esquema admite somente conjuntos completos por versão e falhas técnicas identificadas por ocorrência; a migração é verificável e reaplicável.

---

## Phase 3: User Story 1 — Consultar os itens declarados de uma nota (Priority: P1) 🎯 MVP

**Goal**: consultar uma nota autorizada com XML válido, extrair todos os itens declarados na primeira leitura, armazenar o conjunto completo por versão e reutilizá-lo nas leituras seguintes.

**Independent Test**: com uma nota já armazenada e um XML sintético de vários `det`, a primeira chamada autenticada retorna `AVAILABLE` e cria uma única linha de itens; a segunda lê a linha sem reextrair. Produtos, decimais, ICMS/IPI/PIS/COFINS, ausência e zero coincidem com o XML, e identidades sem permissão não obtêm os itens.

### Tests for User Story 1

- [X] T005 [P] [US1] Escrever testes do extrator em `tests/itens.test.ts` para ordem e unicidade de `nItem`, produto e valores textuais, CST/CSOSN, IPITrib/IPINT, PIS/COFINS Alíq/Qtde/NT/Outr, campos ausentes/zero e grupos irmãos ignorados sem falha.
- [X] T006 [P] [US1] Escrever testes HTTP e MSSQL em `tests/api.test.ts` para nota pré-armazenada, primeira gravação atômica, segunda leitura sem reextração, consultas concorrentes sem duplicação, XML/hash de origem, `Cache-Control: no-store`, JWT fiscal e falha de gravação/integridade sem `AVAILABLE`.

### Implementation for User Story 1

- [X] T007 [US1] Implementar em `src/itens.ts` extração completa por caminho e namespace com `saxes`, reutilizando o critério de decodificação de `src/triagem.ts`, rejeitando DOCTYPE/estrutura incompleta e preservando decimais como texto sem cálculo tributário.
- [X] T008 [US1] Implementar em `src/db.ts` a seleção de XML válido da nota `IN` autorizada, leitura de `ItensNfeExtraidos`, conferência SHA-256 antes da primeira extração, inserção atômica do JSON completo e leitura da linha vencedora em corrida pela mesma versão.
- [X] T009 [US1] Acrescentar em `src/api.ts` o GET `/api/v1/triagem/nfe/{accessKey}/items` usando o JWT fiscal existente e o fluxo de sucesso de `specs/002-consultar-itens-nfe/contracts/itens-api.yaml`, sem ampliar escopo documental nem expor XML em erros.
- [X] T010 [US1] Incluir `tests/itens.test.ts` no script `test` de `package.json` e executar os testes US1 de `tests/itens.test.ts` e `tests/api.test.ts` no banco isolado até o critério independente passar.

**Checkpoint**: US1 funciona por nota, inclusive para XMLs armazenados antes da funcionalidade. O conjunto é persistido após sucesso e não há dependência de Halley UI ou Qive real.

---

## Phase 4: User Story 2 — Consultar itens de versões diferentes (Priority: P2)

**Goal**: usar a versão válida mais recente por padrão e permitir a seleção explícita de cada versão válida anterior, sem regressão do ponteiro em replay antigo.

**Independent Test**: com dois XMLs válidos e itens diferentes para a mesma nota, a consulta padrão usa o mais recente; cada `xmlOccurrenceId` usa somente seu conjunto e seu download. Repetir o XML antigo não muda o padrão nem duplica conjuntos, e um ID de outra nota é recusado.

### Tests for User Story 2

- [X] T011 [P] [US2] Escrever em `tests/api.test.ts` testes de dois XMLs, seleção padrão por `(observedAt,id)`, seleção explícita de versão anterior, separação dos conjuntos/SHAs e `400`/`404` para ID malformado, inválido ou de outra nota.
- [X] T012 [P] [US2] Escrever em `tests/triagem.test.ts` teste de replay de XML antigo após versão nova, comprovando que `latestValidXmlOccurrenceId` e as evidências de novas decisões não regridem.

### Implementation for User Story 2

- [X] T013 [US2] Corrigir em `src/db.ts` a atualização do ponteiro no replay e derivar do histórico a versão padrão da consulta de itens e do detalhe da NF-e, inclusive para ponteiros antigos desatualizados, sem alterar ocorrências ou checkpoint.
- [X] T014 [US2] Validar em `src/api.ts` o parâmetro opcional `xmlOccurrenceId` do GET de itens e encaminhá-lo ao seletor de `src/db.ts`, mantendo a autorização fiscal e a resposta `404` sem revelar versões de outras notas.

**Checkpoint**: US2 pode ser testada sobre US1 sem falha técnica artificial; cada versão preservada mantém seus próprios itens armazenados e XML original.

---

## Phase 5: User Story 3 — Distinguir ausência de XML e falha de extração (Priority: P3)

**Goal**: responder sem lista vazia/parcial a notas sem XML ou versões com extração falha, registrar causa técnica segura por versão e tentar novamente a cada consulta da versão falhada.

**Independent Test**: `resNFe` retorna `AWAITING_XML`, cancelada sem original retorna `CANCELED_XML_UNAVAILABLE`; versão válida com item incompleto ou campo relevante não mapeado retorna `EXTRACTION_FAILED`, categoria segura e XML para download, sem conjunto armazenado. Nova consulta aumenta a tentativa e uma extração posterior bem-sucedida grava o conjunto e resolve a falha, sem alterar `technicalIssueActive`.

### Tests for User Story 3

- [X] T015 [P] [US3] Escrever em `tests/itens.test.ts` testes de estrutura XML ilegível/incompleta, `nItem` ausente/duplicado, variante ou campo relevante desconhecido nos quatro grupos e categorias seguras `XML_STRUCTURE_UNSUPPORTED`, `ITEM_STRUCTURE_INCOMPLETE`, `TAX_MAPPING_UNSUPPORTED`, sem falhar por `PISST`, `COFINSST` ou `ICMSUFDest`.
- [X] T016 [P] [US3] Escrever em `tests/api.test.ts` cenários HTTP/MSSQL de `resNFe` seguido de XML completo consultável, cancelamento sem XML, nota cancelada com XML consultável, nota com decisão anterior preservada após consultar itens, versão inválida, falha sem itens parciais, download preservado, registro de suporte por ocorrência, nova tentativa em cada GET, resolução após sucesso, outra versão explícita e `technicalIssueActive` inalterado.

### Implementation for User Story 3

- [X] T017 [US3] Classificar em `src/itens.ts` as falhas do extrator nas categorias estáveis `XML_STRUCTURE_UNSUPPORTED`, `ITEM_STRUCTURE_INCOMPLETE` e `TAX_MAPPING_UNSUPPORTED`, sem repassar XML, campo fiscal ou texto interno do parser.
- [X] T018 [US3] Implementar em `src/db.ts` criação/atualização idempotente da falha `ITEM_EXTRACTION` aberta com categoria segura, tentativas e vínculo à mesma nota/ocorrência; não gravar itens em falha e resolver a falha histórica na transação que confirma sucesso posterior.
- [X] T019 [US3] Completar em `src/api.ts` os estados `AWAITING_XML`, `CANCELED_XML_UNAVAILABLE`, `TECHNICAL_FOLLOWUP` e `EXTRACTION_FAILED` de `specs/002-consultar-itens-nfe/contracts/itens-api.yaml`, sem propriedade `items` nos estados indisponíveis, com categoria segura e log estruturado sem XML, token, dados pessoais ou chave completa.

**Checkpoint**: US3 distingue ausência de XML de falha por versão; o padrão não cai silenciosamente para versão anterior e o suporte acompanha a falha sem criar pendência fiscal.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: comprovar o contrato completo e a meta de tempo antes do aceite do backend.

- [X] T020 Executar `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run test:entrypoints` e os cenários de autorização, migração/reaplicação, permissões, histórico, recuperação, `resNFe` seguido de XML completo, consulta de nota cancelada com XML e preservação de decisão anterior em MSSQL isolado; registrar comandos, resultados e limites da prova em `specs/002-consultar-itens-nfe/quickstart.md`.
- [X] T021 Medir no piloto controlado 100 primeiras consultas de versões sintéticas distintas com 100 itens, 100 leituras posteriores das mesmas versões e 100 consultas que retornam indisponibilidade, incluindo `resNFe` e nova tentativa de versão com falha; confirmar pelo menos 95% de cada grupo em até 3 s e registrar tempos e condições em `specs/002-consultar-itens-nfe/quickstart.md`.

---

## Phase 7: Correções da revisão (2026-09-30)

**Purpose**: corrigir defeitos comprovados depois de T001–T021, com teste de regressão observado em falha antes de cada correção.

- [X] T022 [US1] Incluir `vICMSMonoOp` e `vICMSMonoDif` no ICMS53 e projetar `qUnid` do IPI em `src/itens.ts`, com testes em `tests/itens.test.ts`, e conferir por leitura se há conjuntos armazenados sem `qUnid`.
- [X] T023 [US3] Rejeitar em `src/itens.ts` um segundo `imposto` no mesmo item como `ITEM_STRUCTURE_INCOMPLETE`, com testes em `tests/itens.test.ts` e `tests/api.test.ts` sem `items` nem conjunto armazenado.
- [X] T024 [US2] Em `src/db.ts`, projetar o cabeçalho do XML somente quando ele for a versão válida mais recente e registrar na evidência de nova decisão o XML e o SHA-256 dessa versão pelo histórico; testar em `tests/triagem.test.ts` com destinatário e `vNF` diferentes sob a mesma chave e com ponteiro desatualizado.
- [X] T025 Devolver em `READ COMMITTED` as conexões reutilizadas do pool após transação `SERIALIZABLE` confirmada, desfeita ou abortada (`src/db.ts`), com teste em `tests/triagem.test.ts`, e repetir as verificações de T020–T021.

---

## Dependencies & Execution Order

### Phase dependencies

`Setup (T001) → Foundational (T002–T004) → US1 (T005–T010) → US2 (T011–T014) → US3 (T015–T019) → Polish (T020–T021) → Correções (T022–T025)`.

US2 depende da rota e do armazenamento de US1. US3 depende da seleção explícita de versões de US2 para comprovar que uma versão anterior permanece consultável quando a mais recente falha. Nenhuma história depende da implementação do Halley, Protheus, motor fiscal ou captura automática.

### Within each story

- Escrever os testes da história primeiro e observar a falha esperada; implementar extrator/persistência antes da rota; rodar novamente os cenários independentes no checkpoint.
- Em US1, T007 depende de T001 e T005; T008 depende de T003–T004 e T007; T009 depende de T008. T010 depende de T005–T009.
- Em US2, T013 depende de T011–T012 e T014 depende de T013. Em US3, T017 depende de T015, T018 depende de T016–T017 e T019 depende de T018.

### Parallel execution examples

- **US1:** T005 (`tests/itens.test.ts`) e T006 (`tests/api.test.ts`) podem ser escritos em paralelo após a base; ambos antecedem T007–T009.
- **US2:** T011 (`tests/api.test.ts`) e T012 (`tests/triagem.test.ts`) podem ser escritos em paralelo depois de US1.
- **US3:** T015 (`tests/itens.test.ts`) e T016 (`tests/api.test.ts`) podem ser escritos em paralelo depois de US2.

## Implementation Strategy

1. Entregar US1 como primeiro incremento interno: nota com XML válido, itens completos armazenados por versão e consulta autenticada. Validar o checkpoint antes de avançar.
2. Acrescentar US2 para versões e replay; depois US3 para ausência, falha técnica e retomada, incluindo a seleção explícita de versão anterior após falha.
3. Concluir o backend somente após T020–T021 e todos os cenários de `specs/002-consultar-itens-nfe/spec.md`. A apresentação pelo Halley e o critério de conclusão de `specs/001-triagem-nfe-entrada/spec.md` permanecem em outra entrega.
