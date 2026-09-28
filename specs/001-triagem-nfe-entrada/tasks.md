# Tasks: Triagem interna de NF-e de entrada

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/` e `quickstart.md` desta funcionalidade; constituição 1.0.0.
**Tests**: obrigatórios pelos cenários de aceite e SC-007; usar `node:test`, MSSQL isolado e conta Qive controlada conforme o plano.
**Organization**: fases por história, com infraestrutura compartilhada antes delas. O Halley fornece a interface e emite o JWT; este repositório entrega apenas o backend fiscal Contei.

## Formato

- `[P]` indica trabalho independente em arquivos distintos, após suas dependências.
- `[US1]` a `[US4]` referem-se às histórias da spec.
- Cada tarefa aponta para o arquivo que será criado, alterado ou usado para registrar evidência.

## Phase 1: Setup

**Purpose**: fechar contratos e ambiente que determinam as dependências; preparar Node.js/TypeScript sem escolher bibliotecas por antecipação.

- [ ] T001 Confirmar versão, autenticação, base MSSQL isolada, permissões, executor T-SQL e backup/restauração disponíveis; registrar as escolhas verificadas em specs/001-triagem-nfe-entrada/research.md.
- [ ] T002 [P] Firmar com o Halley o JWT exclusivo: emissor, audiência, algoritmo permitido, distribuição da chave, `sub` estável, código da permissão fiscal, política de expiração, tolerância de relógio para `iat`, sincronização de horário dos servidores, uso de `nbf` e teste de emissão negada sem permissão; registrar o contrato em specs/001-triagem-nfe-entrada/contracts/halley-api.yaml.
- [ ] T003 [P] Consultar a conta Qive controlada com uma NF-e real recebida e outra citada, com e sem `OwnerRoles`; registrar grafia dos filtros, classificação, destinatário e presença/ausência de cada caso em specs/001-triagem-nfe-entrada/contracts/qive-adapter.md, sem importar citadas.
- [ ] T004 Provar na conta Qive controlada resumo/cancelamento/evento antes do XML, XML tardio, consulta por chave, versões/eventos disponíveis, campos completos e codificação de `Xml`/`Events[].xml`, `CreatedAt`, `EmissionDate` (formato data ou data-hora, semântica de `To` só com data — inclusivo/exclusivo e fuso —, combinação com `CreatedAt`/`DocumentIdentifier`, aceitação de `To` futuro e intervalo máximo), paginação e 429; registrar payloads sanitizados e limites observados em specs/001-triagem-nfe-entrada/research.md.
- [ ] T005 Confrontar as amostras de T004 com o contrato Qive, registrar identificadores observados sem presumir garantia de unicidade e testar identidade por seção/conteúdo completo: replay idêntico, mudança só em campo não fiscal, lexema numérico fora da precisão de `Number` e dois eventos com mesmos tipo/protocolo/seq mas payloads distintos; registrar resultado e qualquer ajuste explícito em specs/001-triagem-nfe-entrada/contracts/qive-adapter.md e specs/001-triagem-nfe-entrada/data-model.md antes de criar o índice único.
- [ ] T006 Medir volume/tamanho dos documentos, duração da varredura e cota/custo Qive; documentar cadências, limites e recuo compatíveis com 1 h/24 h em specs/001-triagem-nfe-entrada/research.md, sem inventar metas adicionais.
- [ ] T007 Escolher e justificar driver MSSQL, parser XML seguro, leitura JSON sem perda de lexema numérico se necessária e verificador JWT compatíveis com T001–T005; registrar versões a fixar e alternativas descartadas em specs/001-triagem-nfe-entrada/research.md.
- [X] T008 Preparar Node.js 24/TypeScript e scripts `typecheck`, `migrate`, `provision`, `test`, `test:qive` e `start` em package.json, package-lock.json e tsconfig.json, preservando dependências preexistentes não fiscais.

**Checkpoint**: contratos reais e ambiente conhecidos; qualquer falta de cobertura Qive que afete a spec exige revisão explícita antes do piloto.

---

## Phase 2: Foundational

**Purpose**: persistência MSSQL, autenticação e execução compartilhadas. Esta fase bloqueia as histórias.

- [X] T009 Escrever testes que falhem para migração em base vazia, reaplicação, falha intermediária, `UNIQUE`/FK, transações e negação de `UPDATE`/`DELETE` em ocorrências e decisões com a credencial de execução em tests/triagem.test.ts.
- [X] T010 Criar schema `contei` e controle de versão de migration com aplicação única em migrations/000_schema_version.sql.
- [X] T011 Criar tabelas EmpresaFiscal, DocumentoEntrada, OcorrenciaDocumental, DecisaoTriagem, FalhaIntegracao e SyncCheckpoint, com `decimal(15,2)`, `varbinary(max)`, seção Qive, SHA-256 do payload completo, ordinal de colisão, PK/FK/`UNIQUE`/`CHECK` e índices; criar papel de execução com `GRANT SELECT, INSERT` e `DENY UPDATE, DELETE` em ocorrências/decisões, sem `db_owner` ou propriedade do schema, usando credencial de implantação distinta em migrations/001_triagem_nfe.sql.
- [X] T012 Implementar conexão MSSQL da aplicação com credencial restrita, executor de migrations com credencial de implantação e `XACT_ABORT ON` quando compatível e transações reutilizáveis em src/db.ts, usando versão e autenticação comprovadas em T001.
- [X] T013 [P] Implementar validação local do JWT Halley em src/api.ts: assinatura, `iss`, `aud`, algoritmo permitido, `iat`, `exp`, `sub` e permissão fiscal; devolver 401/403 sem consultar Halley, sem exigir claim de empresa nem aceitar identidade do corpo.
- [X] T014 [P] Implementar configuração obrigatória e inicialização de uma instância ativa do serviço em src/main.ts, sem mecanismo de coordenação para réplicas.
- [X] T015 Executar tests/triagem.test.ts contra MSSQL isolado após T010–T012 e corrigir migrations/000_schema_version.sql, migrations/001_triagem_nfe.sql ou src/db.ts até comprovar criação, reaplicação, rollback sem schema parcial e negação efetiva de `UPDATE`/`DELETE` históricos pelo login da aplicação.

**Checkpoint**: banco e autenticação disponíveis; não iniciar histórias com migration ou contrato JWT não verificados.

---

## Phase 3: User Story 1 — Decidir NF-e completa (P1, MVP)

**Goal**: incorporar uma NF-e recebida com XML verificável, apresentar evidências pelo Halley e gravar decisão humana auditável.

**Independent Test**: US1.1–US1.6 com uma empresa ativa, XML completo, destinatário igual/divergente, cancelamento e fiscal autorizado; decisão sem ação não cria fila/tarefa.

### Tests first

- [X] T016 [P] [US1] Escrever testes para ativação negada sem prova de certificado apto/captura completa/CNPJ Qive, XML estrutural, chave/protocolo/CNPJ, recomendação, cancelamento, motivos, XML `varbinary(max)` byte a byte com SHA-256, `vNF` exato, duas transações de captura simultâneas da mesma NF-e no MSSQL e duas decisões simultâneas com a mesma chave idempotente em tests/triagem.test.ts.
- [X] T017 [P] [US1] Escrever testes de contrato para lista/detalhe/XML/decisão, JWT válido/inválido/vencido, 401/403/422, replay de `Idempotency-Key` antes da revisão, requisições concorrentes com a mesma chave e `vNF` string em tests/api.test.ts.
- [X] T018 [P] [US1] Escrever testes de descoberta apenas de recebidas, exclusão de citadas, fronteira inclusiva de `CreatedAt`, emissão antiga, paginação, repetição, duas capturas concorrentes da mesma NF-e, checkpoint e desativação em tests/sync.test.ts.

### Implementation

- [ ] T019 [P] [US1] Implementar o adaptador somente de leitura `POST /v2/dfe/nfe` em src/qive.ts, com filtros Qive comprovados, `Owners`/papel recebido, paginação, item NFe completo, itens completos de eventos/manifestações, codificação XML comprovada e erros tipados, sem regra fiscal.
- [X] T020 [P] [US1] Implementar verificação estrutural segura do XML e regra de recomendação por CNPJ/cancelamento em src/triagem.ts; excluir XSD, assinatura digital e cálculo tributário.
- [ ] T021 [US1] Implementar cadastro da única empresa e ativação somente após registrar prova verificável de conta Qive ligada ao CNPJ, certificado apto e captura completa habilitada, além de acesso validado, evidência/instante e desativação sem exclusão em src/provision.ts; lista vazia isolada não comprova as pré-condições.
- [ ] T022 [US1] Persistir por chave o snapshot Qive completo, bytes XML imutáveis, fonte, SHA-256 do payload completo, deduplicação por comparação de bytes com ordinal de colisão, `vNF` decimal exato e primeira entrada na triagem em transações de src/db.ts; se outra captura inserir primeiro a mesma chave/ocorrência, reler e reconciliar o vencedor sem duplicar revisão.
- [ ] T023 [US1] Implementar descoberta paginada de recebidas apenas enquanto a empresa estiver ativa, corte inclusivo, janela de emissão com fim derivado do fim da consulta e checkpoint só após página persistida em src/sync.ts.
- [X] T024 [US1] Implementar em src/db.ts a decisão imutável: consultar idempotência antes da revisão, devolver replay do mesmo ator/pedido, recusar chave reutilizada, avançar revisão condicionalmente e inserir decisão/snapshot na mesma transação; após atualização condicional perdida ou conflito único, encerrar a transação e reler a chave antes de decidir entre replay e `409`.
- [X] T025 [US1] Validar resultado, motivo, observação e evidências consideradas da decisão em src/triagem.ts, aceitando escolha humana contrária à recomendação sem ocultar divergência.
- [X] T026 [US1] Expor lista, detalhe, download dos bytes XML e registro de decisão conforme contracts/halley-api.yaml em src/api.ts, com `vNF` string e sem interface própria.
- [ ] T027 [US1] Conectar API, MSSQL e ciclo de descoberta no processo único em src/main.ts, sem chamada do navegador ao Contei.
- [ ] T028 [US1] Executar US1.1–US1.6 pelo backend/interface do Halley e, no MSSQL isolado, provar duas capturas simultâneas da mesma NF-e com um documento/uma ocorrência por payload idêntico e duas decisões simultâneas com a mesma chave idempotente sem duplicar decisão; registrar evidências e resultados em specs/001-triagem-nfe-entrada/quickstart.md antes de aceitar US1.

**Checkpoint**: US1 pode ser aceita sem US2–US4; a liberação real ainda depende dos gates finais da spec.

---

## Phase 4: User Story 2 — Histórico e correção de decisões (P2)

**Goal**: mostrar mudanças documentais e correções humanas sem sobrescrever XML, eventos, evidências ou decisões.

**Independent Test**: US2.1–US2.4 com documento já triado; evento posterior preserva decisão, correção mantém anteriores, replay não duplica e gravação desatualizada recebe 409.

### Tests first

- [ ] T029 [P] [US2] Escrever testes de correção nos dois sentidos, snapshot histórico e corridas MSSQL entre duas decisões diferentes e decisão/evento em tests/triagem.test.ts.
- [ ] T030 [P] [US2] Escrever testes de novo snapshot/status, versão XML e item de evento/manifestações completos, replay idêntico, mudança só em campo não fiscal, payload distinto com mesmos metadados, colisão de digest simulada, reconsulta de decididos e atualização em até 24 h em tests/sync.test.ts.
- [ ] T031 [P] [US2] Escrever testes de filtros/período/pesquisa, histórico integral mesmo após desativação, GET autenticado do conteúdo completo de evento (200/401/403/404 e hash), alerta de mudança e 409 com revisão atual em tests/api.test.ts.

### Implementation

- [ ] T032 [US2] Inserir snapshots/itens de evento/versões XML imutáveis e projetar estado documental sem perder campo desconhecido ou payload distinto nem duplicar replay, com unicidade por documento/tipo/seção Qive/hash/ordinal de colisão em src/db.ts.
- [ ] T033 [US2] Reconsultar por chave todos os documentos incorporados, inclusive decididos, preservando versões/eventos e checkpoint de reconciliação em src/sync.ts.
- [ ] T034 [US2] Acrescentar correções humanas, sequência/snapshot de evidências e disputa da mesma revisão entre decisão e evento em transações de src/db.ts e src/triagem.ts.
- [ ] T035 [US2] Entregar filtros, histórico de ocorrências/decisões, indicadores de mudança e GET autenticado do conteúdo JSON integral de `EVENT` vinculado à NF-e no contrato do Halley em src/api.ts.
- [ ] T036 [US2] Executar US2.1–US2.4, inclusive corridas reais no MSSQL isolado, e registrar resultados em specs/001-triagem-nfe-entrada/quickstart.md.

**Checkpoint**: estado atual e todos os registros anteriores são reconstruíveis; nenhum evento altera automaticamente a decisão.

---

## Phase 5: User Story 3 — Documentos sem XML completo (P3)

**Goal**: acompanhar resumo, cancelamento e evento anterior ao XML fora da triagem; admitir XML tardio uma única vez.

**Independent Test**: US3.1–US3.2 e eventos antes de resumo/XML; cancelada com XML tardio e CNPJ igual entra uma vez, mantém histórico e não recebe recomendação.

### Tests first

- [ ] T037 [P] [US3] Escrever testes de resumo sem XML, cancelamento/evento antes do XML, evento antes de metadados, XML tardio e entrada única em tests/sync.test.ts.
- [ ] T038 [P] [US3] Escrever testes de lista/detalhe fora da triagem, cancelamento destacado, recomendação nula com CNPJ igual e decisão recusada sem XML em tests/api.test.ts.

### Implementation

- [ ] T039 [US3] Persistir registro provisório por chave e eventos antes de `CreatedAt`, confirmando classificação de recebida e corte antes de expor ao fiscal, em src/db.ts.
- [ ] T040 [US3] Projetar `AWAITING_XML` e `CANCELED_XML_UNAVAILABLE` sem pendência automática e transição única para triagem quando XML válido chegar em src/triagem.ts.
- [ ] T041 [US3] Reconsultar automaticamente documentos sem XML, inclusive cancelados, e associar XML tardio ao mesmo histórico em src/sync.ts.
- [ ] T042 [US3] Expor esses estados fora da fila, histórico e cancelamento em src/api.ts, mantendo recomendação nula quando XML cancelado tem CNPJ coincidente.

**Checkpoint**: documentos incompletos são consultáveis, mas só XML estruturalmente verificável habilita decisão.

---

## Phase 6: User Story 4 — Falhas técnicas e recuperação (P4)

**Goal**: alertar suporte por monitor central, retentar falhas técnicas e recuperar captura sem pendência fiscal.

**Independent Test**: US4.1 com timeout, XML ilegível e resposta incompatível; alerta ativo, retry, recuperação sem duplicação e zero decisão/pendência automática.

### Tests first

- [ ] T043 [P] [US4] Escrever testes de timeout, 5xx/429, `Retry-After`, XML ilegível, resposta incompatível, estado desconhecido, reinício e recuperação em tests/sync.test.ts.
- [ ] T044 [P] [US4] Escrever testes de `GET /health/sync`, métricas, erro estruturado e ausência de segredo/XML nos sinais operacionais em tests/api.test.ts.

### Implementation

- [ ] T045 [US4] Persistir FalhaIntegracao e XML inválido bruto, tentativas/recuo e retomada após reinício em src/db.ts e src/sync.ts, sem criar pendência fiscal e sem sobrepor ciclos.
- [ ] T046 [US4] Expor saúde, atrasos, falhas e contagem de tentativas para o monitor central em src/api.ts, separados das rotas fiscais do Halley.
- [ ] T047 [US4] Emitir erros estruturados sem segredos, JWT ou XML integral em src/main.ts e resolver alerta apenas após recuperação comprovada.
- [ ] T048 [US4] Configurar e provar no monitor central o encaminhamento de alerta ativo ao responsável/canal de suporte, registrando a evidência em specs/001-triagem-nfe-entrada/quickstart.md.

**Checkpoint**: falha externa fica operacionalmente visível e recuperável, sem decisão fiscal fabricada.

---

## Phase 7: Polish & Cross-Cutting Acceptance

**Purpose**: comprovar os gates da spec e constituição antes do primeiro uso real; nenhum motor tributário, emissão ou Protheus.

- [ ] T049 Executar backup/restauração MSSQL, reaplicação de migrations, unicidade, ida e volta byte a byte dos XMLs com SHA-256 e teste negativo de `UPDATE`/`DELETE` históricos com o login de execução; registrar evidência em specs/001-triagem-nfe-entrada/quickstart.md.
- [ ] T050 [P] Executar fluxo completo na conta Qive controlada, incluindo comparação real recebida/citada, resumos/eventos/versões disponíveis, codificação XML, payloads distintos e limites; registrar cobertura e lacunas em specs/001-triagem-nfe-entrada/research.md.
- [ ] T051 Revalidar no Halley emissão de JWT apenas para fiscal, negativa para usuário sem permissão, fluxo de consulta/XML/conteúdo integral de evento/ambas decisões e ausência de chamada direta do navegador ao Contei; registrar em specs/001-triagem-nfe-entrada/quickstart.md.
- [ ] T052 Obter aprovação formal do responsável fiscal para critério estrutural de XML, recomendações, ausência de sugestão no cancelamento com CNPJ igual e motivos; registrar em specs/001-triagem-nfe-entrada/quickstart.md.
- [ ] T053 Medir prazos de descoberta (1 h) e mudanças (24 h) com relógio controlado, verificar cadências/quota, alerta do monitor central e exatamente uma instância ativa/um agendador no ambiente de implantação do piloto; registrar configuração e evidência em specs/001-triagem-nfe-entrada/quickstart.md.
- [ ] T054 Executar `npm ci`, `npm run typecheck`, `npm run migrate`, `npm run provision`, `npm test` e `npm run test:qive`; registrar aprovação dos 13 cenários e bordas em specs/001-triagem-nfe-entrada/quickstart.md.
- [ ] T055 Conferir conformidade final com a constituição e limites de escopo, registrando qualquer conflito e sua resolução explícita em specs/001-triagem-nfe-entrada/plan.md antes do piloto.

## Dependencies & Execution Order

- **Setup → Foundational → US1**. T001/T002/T003/T004 comprovam SQL Server, JWT e Qive; T005–T008 fecham desenho/dependências. T011 depende também de T005: o índice único só é criado após validar a identidade pelo payload completo. T010–T012 dependem de T001/T007/T008; T013 depende de T002/T007/T008. T028 exige os testes reais de concorrência de T016–T018 antes do aceite de US1.
- **US2 → após US1**: precisa de documento/decisão existentes; seus testes usam fixtures próprias para reconstruir o estado sem depender de execução prévia dos testes US1.
- **US3 → após US1**: amplia a ingestão para ausência de XML e cancelamento anterior; seus cenários usam fixtures próprias.
- **US4 → após infraestrutura de sincronização US1**: falhas e recuperação exercitam também caminhos US2/US3. O aceite completo de US4 segue US3.
- **Polish → após US1–US4**. T050 pode ocorrer em paralelo às verificações MSSQL, mas nenhum piloto ocorre sem T049–T055.

### Parallel examples

- **US1**: T016, T017 e T018 escrevem testes em arquivos distintos; depois T019 (`src/qive.ts`) e T020 (`src/triagem.ts`) podem avançar em paralelo.
- **US2**: T029 (`tests/triagem.test.ts`), T030 (`tests/sync.test.ts`) e T031 (`tests/api.test.ts`) são independentes após US1.
- **US3**: T037 (`tests/sync.test.ts`) e T038 (`tests/api.test.ts`) podem ser escritos em paralelo após US1.
- **US4**: T043 (`tests/sync.test.ts`) e T044 (`tests/api.test.ts`) podem ser escritos em paralelo após a sincronização base.

## Implementation Strategy

1. Entregar Setup e Foundational; interromper qualquer caminho cuja prova Qive/Halley/MSSQL contradiga a spec e revisar o documento afetado explicitamente.
2. Entregar US1 como MVP de NF-e completa e validar seu fluxo pelo Halley.
3. Acrescentar US2, US3 e US4 nessa ordem, executando os testes próprios de cada história e regressão das anteriores.
4. Executar T049–T055 e liberar o piloto apenas com aceite fiscal, Halley, Qive, MSSQL e monitor central documentados.
