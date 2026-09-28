# Implementation Plan: Triagem interna de NF-e de entrada

**Branch real:** `main` | **Feature:** `001-triagem-nfe-entrada` | **Date:** 2026-09-23
**Spec:** `specs/001-triagem-nfe-entrada/spec.md`
**Input:** spec vigente, clarificações de 2026-09-22 e 2026-09-24 e constituição 1.0.0.

## Summary

Planejar um serviço Node.js/TypeScript **somente backend fiscal**, com persistência em MSSQL: buscar NF-e classificadas pela Qive como recebidas para a empresa, preservar XML e ocorrências, oferecer ao Halley consulta e decisão humana de triagem. O backend do Halley chama a API do Contei em nome do usuário; o navegador não a chama diretamente. O Halley mantém autenticação de origem e toda a interface; o Contei verifica a credencial recebida, aplica a regra explícita de CNPJ e registra decisões e histórico. A Qive fica atrás de um adaptador de leitura. Não há emissão, cálculo tributário, Protheus ou gestão de pendências.

## Technical Context

| Item | Escolha para o piloto |
|---|---|
| **Language/Version** | Node.js `v24.18.0` e TypeScript `5.9.3` fixado no lockfile; `tsc --noEmit` e execução TS nativa do Node 24. |
| **Primary Dependencies** | Node nativo para HTTP, `fetch`, SHA-256 e testes; `mssql@12.7.2` para SQL Server, `saxes@6.0.0` para XML bem formado, `lossless-json@4.3.1` para lexemas numéricos Qive e `jose@6.2.12` para JWT. Versões fixadas no lockfile; compatibilidade com a conta Qive e JWT reais permanece gate. `claude` preexistente foi preservado sem uso fiscal. |
| **Storage** | Microsoft SQL Server sob schema `contei`, `varbinary(max)`/SHA-256, `decimal(15,2)`, chaves/índices únicos, transações e migrations T-SQL. Instância local de teste `17.0.1000.7` Developer com TCP e logins SQL distintos foi exercitada; versão/credenciais/backup do ambiente alvo permanecem pendentes. |
| **Testing** | Testes determinísticos de regra/API com Node e respostas Qive controladas; testes de persistência em banco MSSQL isolado criado pelas mesmas migrations, incluindo ida e volta de XML byte a byte, payloads Qive distintos, duas capturas simultâneas da mesma NF-e e disputas de decisão/idempotência ainda em US1; depois corridas entre decisão e evento; fluxo com conta Qive controlada e aceite funcional no Halley. Nenhum framework de teste adicional foi demonstrado como necessário. |
| **Target Platform** | Serviço backend Node.js sem interface própria. Testes locais em Windows com MSSQL Developer e autenticação SQL por TCP; sistema operacional, SQL Server e monitor do ambiente do piloto ainda serão confirmados na implantação. |
| **Project Type** | Backend fiscal único em código, com uma instância ativa no piloto, expondo a API fiscal somente ao backend do Halley e executando sincronização Qive. Múltiplas réplicas e sua coordenação ficam para evolução posterior; a unicidade no banco continua obrigatória. |
| **Performance Goals** | Metas da spec: novo registro em até 1 h e mudança posterior em até 24 h, contados da disponibilidade na Qive durante operação. Cadência de consultas, lote, latência HTTP e throughput serão definidos após medir duração da varredura, volume do piloto e limites/custo Qive; não há meta numérica adicional aprovada. |
| **Constraints** | Uma empresa/CNPJ/conexão Qive; descoberta automática limitada ao papel de recebida na Qive e corte inclusivo na ativação; XML e histórico preservados; uma única permissão fiscal do Halley autoriza consulta e decisão, com todas as decisões auditadas; Contei apenas backend fiscal; nenhuma emissão, cálculo tributário, Protheus ou gestão de pendências. |
| **Scale/Scope** | Piloto de uma empresa e uma instância ativa; volume documental, requisições simultâneas, tamanho dos XMLs e capacidade da instância MSSQL não constam da spec. Medir antes de fixar paginação da API, limites de payload e agendamento. |

As justificativas, alternativas e fontes primárias estão em `specs/001-triagem-nfe-entrada/research.md`.

## Constitution Check

| Princípio da constituição 1.0.0 | Gate antes da pesquisa | Rechecagem após desenho |
|---|---|---|
| I. Fronteiras do Ecossistema | **PASSA**: Contei só backend fiscal; Halley UI/identidade; Qive captura. | **PASSA**: contratos HTTP são consumidos pelo Halley; adaptador Qive só lê; nenhuma rota de manifestação/emissão. |
| II. Regras Explícitas e Validadas | **PASSA**: recomendações e motivos vêm de FR-012/017/018; validação fiscal é gate de uso. | **PASSA**: matriz de 13 cenários e gate de aprovação fiscal em `quickstart.md`. |
| III. Evidência e Decisão Responsável | **PASSA**: CNPJs e motivo da recomendação explícitos; resultado humano prevalece. | **PASSA**: API entrega evidências e só recebe decisão de identidade fiscal verificada, com possibilidade de contrariar sugestão. |
| IV. Histórico Preservado | **PASSA**: XML bruto, mudanças e decisões imutáveis. | **PASSA**: ocorrências e decisões aditivas; revisão e snapshot reconstruíveis; sem deleção funcional. |
| V. Simplicidade Suficiente | **PASSA**: uma Qive, uma empresa, sem motor/filas extras. | **PASSA**: MSSQL definido para o projeto, T-SQL versionado, módulos Node nativos onde suficientes; dependências externas serão escolhidas somente após comprovar o contrato que devem cumprir. |

**Gate:** nenhuma violação constitucional identificada. A ativação real continua bloqueada até validar contrato Qive, credencial Halley, alerta operacional, testes e aprovação fiscal (ver `research.md` e `quickstart.md`). Essas verificações externas não mudam o escopo da spec.

## Fluxo de processamento

1. **Provisionar e ativar.** Criar o único cadastro fiscal com referência Halley, CNPJ normalizado e alias da conexão Qive. Antes de tornar a empresa ativa, registrar evidência verificável da conta vinculada ao CNPJ, certificado apto e captura completa habilitada na Qive; validar acesso e gravar referência da evidência e `activatedAt`. Uma lista Qive vazia isoladamente não comprova essas pré-condições. Desativação interrompe consultas futuras, sem exclusão do acervo.
2. **Descobrir.** O agendador consulta somente `POST /v2/dfe/nfe` para o CNPJ da empresa com o filtro de NF-e **recebidas** da Qive e `CreatedAt` desde a ativação **inclusive**, com sobreposição configurada (`CONTEI_SYNC_OVERLAP_MS`) antes do checkpoint e paginação conforme a Qive. A sobreposição é limitada pela ativação; seu valor operacional depende de medir o atraso de disponibilização na Qive. Não importa automaticamente a categoria “citadas”: nela pode haver nota legítima de terceiro disponibilizada via `autXML`. Informar também intervalo de emissão amplo/particionado para neutralizar o padrão de 30 dias documentado pela Qive: início configurado e fim derivado do fim da janela consultada, nunca uma data fixa que interromperia a descoberta de notas emitidas depois dela. Persistir cada página antes de avançar; em falha, repetir a janela. Item incompatível não interrompe a persistência dos demais itens da página, mas impede o avanço do checkpoint para permitir nova tentativa. O adaptador entrega o item NFe completo, XML e itens de eventos/manifestações, separados da projeção fiscal. Definir a cadência após medir o ciclo completo, deixando margem à meta de 1 h. O filtro pode não descobrir notas com destinatário incorreto classificadas apenas como citadas; provar e documentar esse limite com um caso real de cada classificação na conta controlada.
3. **Reconciliar.** Reconsultar por chave todos os documentos já incorporados pela descoberta, inclusive decididos e cancelados sem XML, com cadência medida para cumprir 24 h. Isso capta versões/eventos sem depender de alteração em `CreatedAt`; a reconsulta por chave não é uma via de importação automática de notas apenas citadas. Preservar o item NFe completo de cada resposta distinta, cada item completo de `Events`/`Manifestations` e os XMLs efetivamente disponibilizados pela Qive; o Contei não reconstrói estados intermediários nunca entregues. O contrato publicado não promete ID estável por evento; replay é identificado pelo conteúdo completo, não por `type`/protocolo/seq/status ou projeção fiscal. Comprovar a cobertura na conta controlada antes do piloto e revisar explicitamente spec ou integração se for insuficiente. Uma atualização idêntica não cria ocorrência nem aumenta revisão.
4. **Preservar e verificar.** Confirmar a codificação de `Xml` e `Events[].xml` na conta controlada; decodificar Base64 onde comprovado, calcular SHA-256 e guardar bytes XML em `varbinary(max)` sem reserialização. Guardar também o item NFe completo e cada item de evento/manifestações como JSON canônico completo em `varbinary(max)`, sem descartar campos desconhecidos; o status faz parte do snapshot. Comparar bytes antes de deduplicar por `(documento, tipo, seção Qive, hash)`, usando ordinal de colisão na transação se conteúdos distintos tiverem o mesmo hash. Validar estruturalmente XML completo e bem formado, chave válida e coerente com a Qive, CNPJ destinatário válido e identificável no XML e protocolo coerente. Para toda NF-e incorporada, CNPJ diferente do cadastrado **não** bloqueia a triagem: é evidência para recomendação de pendência, independentemente da classificação “recebida” atribuída pela Qive. XSD e assinatura digital ficam fora desta funcionalidade; o responsável fiscal aprova esse critério antes do piloto. Persistir em transação bytes, fonte, instante e resultado da validação numa ocorrência imutável, inclusive quando o XML é ilegível. Resposta inválida fica em acompanhamento técnico e aciona suporte. Evento que chega antes do resumo/XML cria registro interno por chave, fora da triagem, e é associado depois sem perder a ordem observada.
5. **Projetar estado.** Sem XML verificado: `Aguardando XML`; se houver cancelamento reconhecido: `Cancelada; XML original indisponível`. Ambos fora da triagem. Com XML válido, registrar a entrada **uma só vez** em `Aguardando triagem`. Recomendação deriva apenas de CNPJ divergente; com CNPJ igual e cancelamento, resultado `null` e cancelamento destacado. Evento não interpretado fica visível, sem regra fiscal nova. Situação Qive desconhecida é falha técnica, não inferência fiscal.
6. **Consultar/decidir.** O backend do Halley emite JWT assinado, curto e exclusivo para o Contei, com usuário `sub`, permissão fiscal, `iss`, `aud` do Contei, `iat` e `exp`, somente para usuários com a permissão fiscal. Halley e Contei atendem uma única empresa; o JWT **não contém empresa** e o CNPJ fica configurado no Contei. O Contei valida localmente assinatura, emissor, audiência, algoritmo permitido e expiração em cada chamada, sem tolerância para `exp` (nem para `nbf`, que não faz parte do contrato), e recusa `iat` mais adiantado que a tolerância de relógio configurada, sem manter usuários próprios ou consultar o Halley por requisição. Credencial já emitida pode ser aceita até seu vencimento curto conforme política Halley; revogação imediata fica fora do piloto. O Contei retorna resumo, estado documental separado da decisão, XML bruto e histórico; para `EVENT`, o detalhe oferece caminho autenticado para o JSON integral preservado, inclusive após desativação. `vNF` sai como string decimal exata. O fiscal envia resultado, motivo e revisão esperada. Na transação MSSQL, consultar primeiro a chave de idempotência: mesmo ator e pedido devolvem a decisão original, inclusive se a revisão já avançou; conteúdo ou ator diferente com a mesma chave recebe `409`. Para pedido novo, fazer atualização condicional da revisão e inserir a decisão imutável e seu snapshot na mesma transação. Se a revisão condicional falhar ou outra transação vencer a mesma chave, encerrar a transação perdedora e reler a idempotência antes de responder: replay só para mesmo ator/pedido; nos demais casos, `409`. Todas as decisões e correções ficam auditadas com identidade, papel/permissão, data, motivo, observação e evidências; atualização documental posterior aumenta revisão e alerta visível, mas não altera a decisão.
7. **Falhar e recuperar.** Erro de comunicação, payload incompatível ou XML ilegível gera falha persistente, erro estruturado no log e nova tentativa automática com recuo limitado e respeito a `Retry-After` da Qive. Intervalos e limite serão definidos com a quota real e as metas da spec. Ciclos não se sobrepõem e estados vencidos são retomados após reinício. Nenhum erro cria pendência fiscal. Reconciliar após recuperação sem duplicar. O Contei expõe saúde da sincronização e métricas operacionais sem dados fiscais; o monitor central da infraestrutura coleta saúde, métricas e erros e encaminha alerta ativo ao suporte. O Contei não envia notificações diretamente. Definir responsável e canal de alerta antes do piloto; acompanhar atrasos de 1 h/24 h.

## Dados, contratos e integridade

- Entidades, campos, unicidade, estados e invariantes: `specs/001-triagem-nfe-entrada/data-model.md`.
- API consumida pelo Halley: `specs/001-triagem-nfe-entrada/contracts/halley-api.yaml`. O Contei não envia componentes de interface nem expõe credenciais Qive.
- Limite do adaptador Qive e normalização: `specs/001-triagem-nfe-entrada/contracts/qive-adapter.md`.
- A classificação “recebida” limita a **descoberta**, não é prova de igualdade do destinatário: o XML de cada nota incorporada continua sendo conferido. Notas apenas citadas ficam fora do piloto; eventual análise exige critério específico de seleção em uma evolução posterior.
- Validação por cenário e execução: `specs/001-triagem-nfe-entrada/quickstart.md`.
- Operação: `GET /health/sync` e métricas de última execução bem-sucedida, atraso, falhas abertas e tentativas, sem dados fiscais; rota/formato de coleta das métricas serão acordados com o monitor central. Erros estruturados omitem segredos e XML integral.
- Unicidade por `(empresa, chave)` e `(documento, tipo, seção Qive, SHA-256 do payload completo, ordinal de colisão)`; atualização documental e decisão competem pela mesma revisão em transações MSSQL para impedir decisão sobre evidência desatualizada. XML inicial, ocorrências e decisões nunca recebem `UPDATE`/`DELETE` pela credencial de execução; migrations separam a credencial de implantação, criam papel de execução com `GRANT SELECT, INSERT` e `DENY UPDATE, DELETE` nessas tabelas, sem propriedade do schema nem `db_owner`, e testam a negação com o login real da aplicação. Testar bytes e SHA-256 após gravação/leitura e comprovar restauração do backup.

## Migrations MSSQL planejadas

1. Criar scripts T-SQL ordenados em `migrations/`, sem ORM nem ferramenta de migration ainda inexistente no repositório. O primeiro cria o schema `contei` e o controle de versões; o seguinte cria tabelas de empresa, documento, ocorrência, decisão, falha e checkpoint, com PKs, FKs, `CHECK`, unicidade, índices para chave, período, decisão atual e reconsulta, e permissões mínimas para a credencial de execução distintas da credencial de implantação. O modelo físico está em `data-model.md`.
2. O processo de implantação executará cada versão uma vez, registrando-a somente após sucesso. Cada migration de dados/DDL compatível será executada em transação com `XACT_ABORT ON`; falha interrompe a implantação e exige rollback ou restauração conforme a operação aprovada. Evitar mudanças destrutivas nos registros históricos. O executor concreto será escolhido com o driver e a infraestrutura MSSQL, sem instalar ferramenta por antecipação.
3. Validar contra uma base MSSQL isolada: criação do zero, reaplicação sem duplicidade, falha intermediária sem schema parcial, índices/restrições, preservação byte a byte de `varbinary(max)`, duas capturas concorrentes da mesma NF-e e negativa real de `UPDATE`/`DELETE` nas tabelas históricas com a credencial de execução, além de restauração de backup. O workspace não contém dados de aplicação a converter de outro banco.

## Project Structure

### Documentation (this feature)

```text
specs/001-triagem-nfe-entrada/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── halley-api.yaml
    └── qive-adapter.md
```

### Source Code (criado parcialmente até US1; fases seguintes pendentes)

```text
src/
├── api.ts                 # rotas Halley, autenticação e erros HTTP
├── triagem.ts             # regras de estado, recomendação e decisão
├── qive.ts                # única fronteira com a API Qive
├── sync.ts                # descoberta e checkpoint US1; revisita/alertas pendentes
├── db.ts                  # acesso MSSQL e transações
├── provision.ts           # ativação operacional após prova da conexão Qive
└── main.ts                # inicialização do serviço
migrations/
├── 000_schema_version.sql # schema contei e controle de versões
└── 001_triagem_nfe.sql    # tabelas, restrições e índices MSSQL
tests/
├── triagem.test.ts        # cenários de regra e histórico
├── sync.test.ts           # duplicidade, eventos e falhas Qive
├── api.test.ts            # autorização, contrato e conflito de revisão
├── main.test.ts           # inicialização local sem sincronização externa
└── qive-live.test.ts      # gate de conta Qive controlada; pendente
scripts/
└── setup-test-db.ps1      # base MSSQL isolada para testes locais
```

**Structure Decision:** um projeto backend sem camadas genéricas, ORM, fila ou frontend. Se as provas de integração demonstrarem necessidade de outra estrutura, registrar a razão antes de expandir.

## Complexity Tracking

Nenhuma exceção à constituição. Driver MSSQL, parser XML, leitor JSON e verificador JWT estão fixados no código e em `research.md`, com teste local; parâmetros e prova dos contratos reais Qive/Halley permanecem pendentes. A infraestrutura ainda deve confirmar o ambiente alvo e definir responsável, canal e formato de coleta das métricas e alertas. Halley e Contei atendem uma única empresa; o JWT não leva empresa e sua emissão exige a permissão fiscal, condição a comprovar no aceite.

Na implantação do piloto, conferir e registrar no ambiente alvo que há exatamente uma instância ativa do processo Contei e um agendador de sincronização; não adicionar coordenação distribuída nesta funcionalidade. O aceite de US1 exige prova em MSSQL de duas capturas simultâneas da mesma NF-e e de duas decisões simultâneas com a mesma chave idempotente antes de liberar a história.

## Entrega do planejamento

Fase 0: `research.md` consolida escolhas e provas pendentes. Fase 1: `data-model.md`, `contracts/` e `quickstart.md` definem o desenho verificável. Em 2026-09-24 iniciou-se a execução de `tasks.md` até US1; testes locais não substituem provas reais da Qive, Halley, aceite fiscal ou implantação do piloto.
