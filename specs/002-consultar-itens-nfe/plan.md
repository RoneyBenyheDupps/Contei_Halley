# Implementation Plan: Consultar itens de NF-e de entrada

**Branch real:** `main` | **Diretório da funcionalidade:** `002-consultar-itens-nfe` | **Date:** 2026-09-28 | **Updated:** 2026-09-29
**Spec:** `specs/002-consultar-itens-nfe/spec.md`
**Input:** decisões do Grilling, especificação vigente, constituição 1.0.0 e contratos da triagem existente.

## Summary

Adicionar uma consulta autenticada de itens por chave de NF-e e, opcionalmente, por versão válida do XML. Na primeira consulta de uma versão sem extração bem-sucedida, ler os bytes preservados, extrair produto e os quatro grupos tributários principais com o parser já instalado e armazenar o conjunto completo por versão; consultas seguintes reutilizam o conjunto. Versões com falha são tentadas a cada consulta. A versão padrão é a última ocorrência XML válida efetivamente recebida; versões anteriores permanecem selecionáveis. Corrigir pontualmente o ponteiro que pode regredir no replay de XML antigo, sem alterar polling, checkpoint, decisão de triagem ou XMLs. Registrar falha de extração por versão no mecanismo técnico existente.

## Technical Context

| Item | Decisão |
|---|---|
| **Language/Version** | Node.js 24 e TypeScript 5.9, conforme `package.json` e `tsconfig.json`. |
| **Primary Dependencies** | `saxes` 6 para XML; `mssql` 12 para leitura e falhas técnicas; `jose` 6 já usado na autorização. Nenhuma dependência nova. |
| **Storage** | MSSQL existente: `contei.DocumentoEntrada`, `contei.OcorrenciaDocumental` e `contei.FalhaIntegracao`. Nova `contei.ItensNfeExtraidos`: uma lista JSON completa por `xmlOccurrenceId`, gravada apenas após sucesso e reutilizada nas leituras. Migração aditiva também liga falha técnica à versão XML. |
| **Testing** | `node:test`, fixtures XML sintéticas e MSSQL isolado conforme scripts atuais; contrato HTTP, autorização, persistência e concorrência por versão, nova tentativa após falha e medição de latência fria e armazenada. |
| **Target Platform** | Serviço HTTP backend do Contei, consumido pelo backend do Halley; sem interface própria. |
| **Project Type** | Serviço fiscal existente, com código plano em `src/` e testes em `tests/`. |
| **Performance Goals** | Pelo menos 95% das consultas de notas com até 100 itens em até 3 s no piloto controlado; medir separadamente primeira extração com gravação e leitura do conjunto armazenado. |
| **Constraints** | Preservar bytes e SHA-256 do XML; jamais inferir campos ausentes, arredondar ou converter decimal via ponto flutuante; restringir chave, escopo, ocorrência e JWT fiscal; não retornar itens parciais; não incluir Protheus, Halley UI, Qive ou checkpoint no fluxo da consulta. |
| **Scale/Scope** | Uma empresa e uma nota por consulta. O leiaute oficial admite até 990 `det` por NF-e; sem busca transversal nem paginação de itens nesta entrega. |

## Constitution Check

*GATE: conferido antes da pesquisa e reavaliado após o desenho da Fase 1.*

| Princípio | Antes da pesquisa | Após o desenho |
|---|---|---|
| I. Fronteiras do Ecossistema | **PASSA**: Contei consulta documentos fiscais já capturados; Halley mantém identidade e futura interface. | **PASSA**: a rota usa o JWT fiscal existente e os XMLs preservados, sem módulo de compras, Protheus ou nova captura. |
| II. Regras Explícitas e Validadas | **PASSA**: a função apenas extrai dados declarados, sem regra tributária ou recomendação. | **PASSA**: os caminhos XML admitidos e os casos de ausência/variantes são verificáveis; nenhuma alíquota é homologada pelo código. |
| III. Evidência e Decisão Responsável | **PASSA**: cada item aponta à versão de XML que o declarou. | **PASSA**: identificador, SHA-256 e download da versão acompanham os itens; nenhuma decisão é produzida. |
| IV. Histórico Preservado | **PASSA**: versões XML e decisões anteriores não são alteradas. | **PASSA**: conjuntos extraídos são ligados ao XML preservado e inseridos uma vez por versão; falhas técnicas podem ser resolvidas sem apagar ocorrência, conjunto ou decisão. |
| V. Simplicidade Suficiente | **PASSA**: reutilizar parser, API, banco e autorização atuais. | **PASSA**: uma linha JSON por versão atende ao armazenamento confirmado sem índice ou tabela por item; nenhuma dependência nova. |

**Gate:** nenhuma violação constitucional. A spec de triagem continua com seus próprios gates para uso pelo Halley; o aceite desta funcionalidade é o contrato autenticado do Contei e seus cenários verificados.

## Fluxo e decisões de desenho

1. **Selecionar a fonte.** Consultar a nota por `(empresaId=1, accessKey, scope='IN')`. Sem versão explícita, selecionar a ocorrência `kind='XML'` e `isValidXml=1` mais recente em `(observedAt, id)`; com `xmlOccurrenceId`, exigir que a ocorrência pertença à mesma nota e seja válida. Retornar `404` para chave/ocorrência fora do escopo e `400` para identificador malformado. Usar o mesmo critério no detalhe da nota. Corrigir a atualização de `latestValidXmlOccurrenceId` na ingestão para que replay de XML antigo não faça o ponteiro regredir; a consulta deriva a ordem das ocorrências e também funciona para dados já armazenados cujo ponteiro esteja desatualizado. Nenhum checkpoint é alterado.
2. **Ler ou extrair.** Consultar `contei.ItensNfeExtraidos` pela ocorrência selecionada. Se houver conjunto armazenado, devolvê-lo sem reextrair. Se não houver, ler `rawPayload` e SHA-256, conferir integridade, decodificar pelo critério do validador da triagem e percorrer com `saxes` em modo namespace. Aceitar somente `nfeProc/NFe/infNFe/det` no namespace NF-e; rejeitar DOCTYPE, XML malformado, ausência/duplicidade de `nItem` ou conjunto incompleto de itens. A falha da versão inteira produz `EXTRACTION_FAILED`, nunca itens parciais. O parser usa caminhos dentro de `det/prod` ou dos quatro grupos principais em `det/imposto`.
3. **Projetar e armazenar.** Cada `det` produz `nItem`, produto e tributos opcionais na ordem do XML. Mapear os campos da spec pelos nomes oficiais, sem coerção numérica: `cProd`, `xProd`, `NCM`, `CFOP`, `CEST`, `cEAN`, `cEANTrib`, unidades, quantidades, valores unitários e valores do produto/desconto/frete/seguro/outras despesas. Para ICMS, IPI, PIS e COFINS, devolver variante e somente códigos de situação, bases, alíquotas e valores presentes. Conferir variantes/campos no esquema oficial; conteúdo relevante desconhecido nesses quatro grupos não pode ser omitido silenciosamente. `qBCProd`/`vAliqProd` e `qUnid`/`vUnid` conservam seus nomes e unidades. `PISST`, `COFINSST`, `ICMSUFDest` e demais grupos irmãos ficam no XML e não causam falha por estarem fora do escopo. Após a extração integral, inserir atomicamente uma linha em `ItensNfeExtraidos` com a lista JSON completa, `xmlOccurrenceId` como PK/FK e instante de extração. A PK resolve consultas concorrentes: quem não inserir lê o conjunto já confirmado. Não reextrair conjuntos bem-sucedidos automaticamente; uma correção futura deles exige reprocessamento explícito a partir do XML original.
4. **Responder.** Acrescentar ao namespace HTTP da nota existente uma rota GET de itens, com `xmlOccurrenceId` opcional. A resposta tem estado `AVAILABLE`, `AWAITING_XML`, `CANCELED_XML_UNAVAILABLE`, `TECHNICAL_FOLLOWUP` ou `EXTRACTION_FAILED`; `items` só existe em `AVAILABLE` após ler ou confirmar a gravação do conjunto completo. `xmlVersion` identifica ocorrência, instante, SHA-256 e caminho de download quando há XML selecionado. `EXTRACTION_FAILED` traz categoria técnica segura e estável, por exemplo `XML_STRUCTURE_UNSUPPORTED`, `ITEM_STRUCTURE_INCOMPLETE` ou `TAX_MAPPING_UNSUPPORTED`, sem XML nem texto interno do parser. Sem XML válido, reutilizar o estado documental já exposto pela triagem, sem lista vazia. Manter `Cache-Control: no-store`; não usar o hash do XML como ETag do JSON derivado.
5. **Observar e retomar falhas.** A tabela `FalhaIntegracao` existe, mas sua operação e seus alertas ainda não foram implementados na triagem. A migração também acrescenta `xmlOccurrenceId` opcional com FK e índice filtrado para no máximo uma falha `ITEM_EXTRACTION` aberta por versão. Registrar categoria segura, primeiro/último instante e tentativas; emitir log estruturado sem XML, token, dados pessoais ou chave completa. Toda consulta de versão sem conjunto armazenado tenta extrair, mesmo após falha anterior; sucesso grava o conjunto e resolve a falha aberta, mantendo o registro anterior, e falha recorrente atualiza tentativas. O suporte consulta as falhas abertas pelo guia operacional. Não alterar `technicalIssueActive` da NF-e, nem criar fluxo ou decisão fiscal; esta entrega não declara prontos os alertas ativos gerais da US4 da triagem.
6. **Verificar.** Cobrir nota antiga cuja primeira consulta cria a linha e cuja segunda usa o conjunto armazenado; duas versões sem mistura; inserção concorrente sem duplicação; variantes ICMS CST/CSOSN, IPITrib/IPINT e PIS/COFINS por alíquota, quantidade, não tributado e outros; decimais longos/zero/ausência; grupos irmãos fora do escopo; variante relevante desconhecida; replay antigo; XML inválido, item incompleto, hash incoerente; JWT e escopo; repetição e resolução da falha sem alterar `technicalIssueActive`; latência fria e armazenada no piloto. Não usar a Qive real nem mudar polling/checkpoint para validar esta consulta.

## Project Structure

### Documentation (this feature)

```text
specs/002-consultar-itens-nfe/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    └── itens-api.yaml
```

### Source Code (repository root)

```text
src/
├── api.ts       # rota e autorização já existentes
├── db.ts        # seleção de ocorrência, ponteiro, conjunto armazenado e falha
├── triagem.ts   # decodificação XML já existente, compartilhável
└── itens.ts     # extrator puro dos itens declarados
migrations/
└── 002_itens_nfe.sql  # conjunto por versão e vínculo de falha técnica
tests/
├── api.test.ts   # contrato, autenticação e MSSQL
└── itens.test.ts # variantes e falhas com XML sintético
```

**Structure Decision:** ampliar o serviço e os testes atuais. Se `tests/itens.test.ts` for criado, incluí-lo no script `npm test` existente; não criar aplicação, serviço ou pacote separado.
