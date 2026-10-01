# Guia de validação — itens de NF-e de entrada

Este guia descreve como verificar a entrega **após a implementação**. O comportamento exigido está em `specs/002-consultar-itens-nfe/spec.md`; resposta HTTP e estados estão em `specs/002-consultar-itens-nfe/contracts/itens-api.yaml`; relações e falhas técnicas estão em `specs/002-consultar-itens-nfe/data-model.md`. A apresentação pelo Halley não é gate desta funcionalidade.

## Pré-requisitos

- Node.js 24, dependências do `package-lock.json`, MSSQL isolado com os logins de implantação e aplicação do projeto, e um JWT de teste emitido para o Contei com a permissão fiscal já contratada. Usar somente chaves, CNPJs e XMLs sintéticos nos testes; não registrar XML, tokens ou dados fiscais reais.
- Se `.env.test` ainda não existir, `npm.cmd run test:db:setup` cria um banco **isolado** na instância local documentada por `scripts/setup-test-db.ps1`. Conferir o alvo antes de executar. As migrations devem ser testadas com credencial de implantação; a aplicação usa a credencial de execução restrita. Não aplicar migração em produção a partir deste guia.
- A fixture de integração precisa conter ao menos uma nota já armazenada com XML válido, uma nota somente com `resNFe`, uma cancelada sem XML, duas versões XML diferentes da mesma nota e uma versão cujo item não possa ser extraído integralmente. Para as variantes tributárias, usar XMLs sintéticos conformes ao [MOC 7.0, Anexo I](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf) e conferir os [esquemas XML oficiais em uso](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w%3D) ao construir os casos. Não é necessária chamada à Qive real para provar esta consulta.

## Comandos do repositório

Depois de configurar o banco isolado e `.env.test`:

```powershell
npm.cmd ci
npm.cmd run test:db:setup
node --env-file=.env.test src/db.ts migrate
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:entrypoints
```

`npm test` deve incluir `tests/itens.test.ts` após a implementação, além dos testes existentes. Verificar que os testes dependentes de MSSQL realmente executaram, sem serem ignorados por falta de `MSSQL_DATABASE`. `test:entrypoints` comprova a API compilada; não substitui os cenários de contrato. Para ensaio HTTP manual, iniciar o serviço com `npm.cmd run start` somente após configurar suas variáveis de ambiente de teste e manter a sincronização externa desabilitada. O caminho de consulta é `/api/v1/triagem/nfe/{accessKey}/items`, com `xmlOccurrenceId` opcional.

## Cenários de aceite

| Cenário | Ação | Resultado esperado |
|---|---|---|
| Nota já armazenada | Consultar XML preservado antes da implantação, ainda sem conjunto extraído; consultar a mesma versão de novo | Primeira consulta grava o conjunto completo por versão e retorna `AVAILABLE`; a segunda lê o conjunto armazenado sem nova extração, sem backfill prévio. |
| Produto e decimais | Declarar GTIN, NCM, CFOP, quantidades e valores com zeros finais; omitir outro campo opcional | Textos coincidem com XML, zero permanece zero, ausência não vira `null` ou zero inferido. |
| Variantes tributárias | Exercitar ICMS com CST/CSOSN; IPITrib/IPINT; PIS/COFINS Alíq, Qtde, NT e Outr | Grupo e variante corretos; códigos, bases, alíquotas e valores presentes mantêm nomes e decimais originais; unidades quantitativas não viram percentual. |
| Grupo fora do escopo | Declarar `PISST`, `COFINSST` ou `ICMSUFDest` além dos quatro grupos principais | A presença do grupo irmão não causa falha; ele não aparece estruturado e permanece no XML original para download. |
| Campo relevante desconhecido | Declarar variante/campo relevante não mapeado dentro de um dos quatro grupos principais | `EXTRACTION_FAILED` com categoria técnica segura, sem `items` e sem linha de sucesso armazenada; XML disponível. |
| Versões | Consultar sem parâmetro e depois cada `xmlOccurrenceId` da nota | Padrão usa a última versão válida; cada escolha usa somente o conjunto armazenado para seu XML e SHA-256. |
| Replay antigo | Receber novamente XML idêntico à versão inicial depois de outra versão válida | Nenhuma versão/conjunto duplicado; ponteiro, padrão e detalhe da nota continuam na versão realmente mais recente. |
| Resumo e cancelamento sem XML | Consultar nota apenas com `resNFe` e cancelada sem original | `AWAITING_XML` ou `CANCELED_XML_UNAVAILABLE`, sem propriedade `items`. |
| Falha e recuperação | Consultar repetidamente versão com item ilegível; depois corrigir o extrator em ambiente de teste e consultar de novo | Cada consulta sem conjunto armazenado tenta extrair; `EXTRACTION_FAILED` mostra categoria segura, sem `items`, com XML para download e falha vinculada à ocorrência. O sucesso posterior grava um único conjunto e resolve a falha, preservando seu histórico e sem alterar `technicalIssueActive`, XML, decisão ou checkpoint. |
| Outra versão após falha | Falhar na versão mais recente e escolher uma anterior válida | Padrão continua apontando para a mais recente com falha; versão anterior só aparece após escolha explícita. |
| Autorização e escopo | Repetir sem JWT, sem permissão fiscal, com versão de outra nota e com nota fora do escopo | `401`, `403` ou `404` conforme contrato, sem dados de itens nem indicação de existência fora do escopo. |
| Concorrência e integridade | Consultar simultaneamente a mesma versão sem conjunto; confrontar SHA-256 indicado com os bytes baixados; simular inconsistência somente no teste | Há uma única linha de sucesso completa por versão; divergência de integridade não produz conjunto nem afirma que XML corrompido é original íntegro. |

No banco isolado, o suporte pode conferir o registro técnico sem ler XML ou dados de item:

```sql
SELECT xmlOccurrenceId, state, attempts, firstAt, lastAt, resolvedAt, safeDetail
FROM contei.FalhaIntegracao
WHERE kind = 'ITEM_EXTRACTION'
ORDER BY lastAt DESC;
```

Conferir também a existência de uma única linha por versão bem-sucedida, sem exibir `itemsJson`:

```sql
SELECT xmlOccurrenceId, extractedAt
FROM contei.ItensNfeExtraidos
ORDER BY xmlOccurrenceId;
```

Medir separadamente ao menos 100 primeiras consultas de versões sintéticas distintas com 100 itens (extração e gravação), 100 consultas posteriores às mesmas versões (leitura armazenada) e 100 consultas indisponíveis, incluindo `resNFe` e nova tentativa de uma versão com falha; em cada grupo, pelo menos 95 devem terminar em até 3 segundos. Registrar tempo e condições da medição. O aceite exige conferir que a credencial SQL de execução não pode alterar nem apagar `OcorrenciaDocumental`, `DecisaoTriagem` ou `ItensNfeExtraidos`, e que a migração aditiva é reaplicável em banco isolado. Antes de qualquer aplicação em ambiente alvo, inspecionar o esquema real e comprovar backup/restauração. Nenhum desses testes conclui o gate da funcionalidade de triagem que depende do Halley.

## Evidência da implementação — 2026-09-29

- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test`: 34 testes aprovados, nenhum ignorado. Os testes HTTP/MSSQL cobriram autenticação e escopo fiscal, notas já armazenadas, `resNFe` seguido de XML, nota cancelada com XML, decisão anterior preservada, histórico e replay, falha por versão com nova tentativa e recuperação, concorrência, integridade, permissões da credencial de execução e migração `002` reaplicada na base isolada.
- `npm.cmd run test:entrypoints`: 1 teste aprovado, sem ignorados; imports TypeScript e JavaScript compilado, reaplicação das migrações `000`–`002` e inicialização/consulta HTTP da API compilada com JWT sintético.
- `node --check scripts/measure-items.mjs` e `git diff --check`: aprovados.

A medição foi executada com `node --env-file-if-exists=.env.test scripts/measure-items.mjs`, Node.js v24.18.0 e SQL Server 17.0.1000.7, na instância MSSQL isolada local. A API HTTP foi acessada sequencialmente via `127.0.0.1`, com JWT e notas/XMLs sintéticos; cada grupo teve 100 consultas. As 100 indisponíveis foram 50 notas só com `resNFe` e 50 novas tentativas de versões com falha de extração. Os dados da medição foram removidos ao final.

| Grupo | Até 3 s | Mediana | p95 | Máximo |
|---|---:|---:|---:|---:|
| Primeira extração e gravação, 100 itens | 100/100 | 39 ms | 68 ms | 112 ms |
| Leitura do conjunto armazenado, 100 itens | 100/100 | 16 ms | 27 ms | 31 ms |
| Indisponibilidade, incluindo nova tentativa | 100/100 | 18 ms | 68 ms | 160 ms |

A prova de tempo é um piloto controlado local, sem latência de rede remota, carga concorrente ou integração com Halley/Qive. Antes da aplicação em outro ambiente, ainda é necessário inspecionar o esquema real, comprovar backup/restauração e repetir a medição nas condições daquele ambiente.

## Evidência das correções da revisão — 2026-09-30

- Os testes de regressão foram escritos antes das correções e falharam pelo motivo esperado. ICMS53 com `vICMSMonoOp`/`vICMSMonoDif` era recusado; o IPI omitia `qUnid`; um segundo `imposto` era aceito e gravado como `AVAILABLE`. O replay antigo sobrescrevia destinatário e `vNF`, e a decisão usava XML e SHA-256 do ponteiro desatualizado. A conexão reutilizada continuava em `SERIALIZABLE` (nível 4) após commit.
- `npm.cmd run typecheck`: aprovado. `npm.cmd test`: 39 testes aprovados, nenhum ignorado. `npm.cmd run test:entrypoints`: 1 teste aprovado.
- Conferência somente leitura na base isolada, com reextração em memória: 59 conjuntos armazenados e nenhum XML com `qUnid`. Portanto, não há conjunto sem `qUnid` a reprocessar. 58 conjuntos coincidem com a reextração atual. Um conjunto sintético, gravado pela execução em falha do novo teste de `imposto` repetido, seria recusado hoje (`ITEM_STRUCTURE_INCOMPLETE`). Oito notas sintéticas de testes de replay anteriores à correção mantêm o cabeçalho da versão antiga; a correção impede novas regressões, mas não reescreve cabeçalhos já gravados.
- Medição repetida após a troca da validação do pool por `reset()`, nas mesmas condições de 2026-09-29: primeira extração 100/100 em até 3 s (mediana 34 ms, p95 53 ms, máximo 94 ms); leitura armazenada 100/100 (17/34/47 ms); indisponibilidade 100/100 (16/20/27 ms).

## Validação manual no Postman — 2026-09-30

Seis cenários foram executados na API local (`127.0.0.1:31082`), com `CONTEI_SYNC_ENABLED=false`, JWT de teste, XMLs sintéticos e MSSQL isolado `ConteiTriagemTest_235ee11a252c`:

| Cenário | Resultado observado |
|---|---|
| 1. Nota já armazenada | `200 AVAILABLE`; dois itens e tributos declarados coincidiram com o XML; ETag do download coincidiu com o SHA-256; resposta de itens teve `Cache-Control: no-store`. Os `?` das descrições já constavam no XML sintético. |
| 2. Reutilização | Segundo GET idêntico; a versão `31554` manteve uma linha em `ItensNfeExtraidos`, `extractedAt=2026-09-30T16:39:05.203Z` e o mesmo SHA-256 do JSON (`803cff91f47cea926dcb8a569969f1ec0e805d62fcb23bbf74d2102a6ac78bc0`) antes e depois. |
| 3. Versões | Padrão `31151/NEW`, anterior explícita `31149/OLD`, ambas `200` e com hashes correspondentes; a ocorrência inválida `31155` ficou fora de `xmlVersions`. |
| 4. Resumo sem XML | `200 AWAITING_XML`, sem propriedade `items`. A amostra é um resumo QIve em `SNAPSHOT` JSON, sem XML completo; não contém a tag literal `<resNFe>`. |
| 5. Falha por versão | `31169` retornou `EXTRACTION_FAILED/TAX_MAPPING_UNSUPPORTED` sem `items`; XML baixável; `31167` permaneceu `AVAILABLE/OLD`; `technicalIssueActive=false`. A falha `10089` seguiu `OPEN`, `resolvedAt` nulo e zero itens armazenados. |
| 6. Acesso | Itens e XML sem JWT: `401 UNAUTHORIZED`; com JWT válido sem permissão fiscal: `403 FORBIDDEN`. As quatro respostas tiveram `Cache-Control: no-store` e não expuseram itens nem XML. |

Na falha `10089`, a referência era `attempts=2`; após **duas consultas com falha relatadas** pelo Postman, a leitura mostrou `3`, não `4`. Um GET adicional retornou a mesma falha e elevou o contador a `4`, com `lastAt=2026-09-30T19:07:06.423Z`. A primeira discrepância não teve causa identificada; esta prova não demonstra que ambas as primeiras chamadas foram registradas.

O roteiro confirma o contrato observado com fixtures locais, mas não exercita QIve real, rede remota, carga concorrente ou a apresentação no Halley. A medição local acima não substitui a repetição dos três grupos de desempenho no ambiente alvo; antes de aplicar a migração nesse ambiente, ainda são necessárias inspeção do esquema e prova de backup/restauração.
