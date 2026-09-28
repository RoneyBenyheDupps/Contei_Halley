# Instruções para agentes — Contei

Este arquivo fica na raiz do repositório e orienta alterações feitas por agentes. Ele complementa o README, a constituição, as especificações e as decisões arquiteturais. Não substitui esses documentos.

## Papel do produto

- O Contei concentra as capacidades **fiscais e contábeis** da empresa e se integra ao ERP **Halley** por contratos explícitos. Não implemente no Contei cadastros, estoque, compras, vendas ou autenticação do Halley como se fossem módulos próprios.
- O Contei pode receber documentos e retornos de provedores externos, conferir informações, apresentar evidências e apoiar a decisão humana. Respeite a responsabilidade de cada sistema definida na especificação da funcionalidade.
- O projeto atende uma empresa. Não acrescente multitenancy, estabelecimentos ou outras generalizações sem necessidade documentada.
- QIve, emissores de NF-e e outras integrações devem permanecer atrás de limites explícitos. Protheus é contexto legado e referência de domínio; **não crie uma dependência operacional direta dele** sem decisão vigente e contrato aprovado. Se uma regra proposta depender de dados que só existem no Protheus, registre a lacuna antes de implementá-la.

## Antes de modificar qualquer coisa

1. Confira o estado do Git e leia os arquivos relevantes da área que será alterada. Preserve modificações preexistentes.
2. Leia `.specify/memory/constitution.md`, os ADRs aplicáveis em `docs/adr/` e os artefatos da funcionalidade em `specs/<feature>/` (`spec.md`, `plan.md`, `tasks.md` e contratos, quando existirem). Confira o código e os contratos reais antes de assumir estruturas, comandos ou comportamentos.
3. Siga a instrução explícita do usuário e os documentos vigentes. Se constituição, ADR, especificação e implementação divergirem, identifique o conflito e corrija-o no documento que define a decisão antes de consolidar uma interpretação no código. Não trate uma proposta pendente como aprovada.
4. Identifique o gerenciador de pacotes e os scripts nos manifests existentes. Não invente comandos de instalação, teste, migração ou deploy.

## Trabalho orientado pelas especificações

- Use a sequência de artefatos do Spec Kit: constituição para princípios do projeto; `spec.md` para comportamento; `plan.md` para decisões técnicas; `tasks.md` para execução. Execute apenas a etapa ou o escopo solicitado, respeitando dependências e critérios de aceite.
- Para a funcionalidade `specs/001-triagem-nfe-entrada/`, consulte os documentos atuais antes de trabalhar. A primeira entrega utilizável está delimitada pela US1; não antecipe as demais histórias apenas porque aparecem no mesmo `tasks.md`.
- Antes de implementar, verifique ambiguidades e contradições relevantes entre especificação, plano e tarefas. Use a análise do Spec Kit, quando disponível, para essa conferência. Ajuste o artefato de origem quando um requisito mudar.
- Marque uma tarefa como concluída somente depois de implementar e verificar seu resultado. Registre o que foi validado e qualquer bloqueio real. Não crie issues, PRs ou publicações como efeito colateral de uma tarefa técnica sem pedido explícito.
- `AGENTS.md` é um arquivo de contexto do repositório; sua existência não executa automaticamente o Spec Kit nem substitui os comandos instalados em `.agents/skills/`.

## Regras fiscais e contábeis

- O motor fiscal cresce por operações recorrentes, uma regra homologada de cada vez. Não prometa cobertura integral da tributação brasileira no MVP.
- Para cada item de NF-e sujeito a conferência: preserve os dados declarados no XML; obtenha o contexto pelos contratos aprovados; identifique o cenário; selecione uma regra **vigente e homologada**; calcule o esperado; compare os valores; registre evidências suficientes para reproduzir a análise.
- Separe **critério de aplicabilidade**, **parâmetros com vigência**, **fórmula** e **comparação**. Prefira fórmulas TypeScript puras, determinísticas e testáveis. Especifique unidade, precisão, arredondamento e tolerância antes de comparar valores monetários ou bases tributárias.
- O resultado de uma análise fiscal deve distinguir `CONFORME`, `DIVERGENTE`, `INCONCLUSIVO` e `FALHA_TECNICA`. Ausência de regra, dados insuficientes ou cenário ambíguo levam a `INCONCLUSIVO`; erro de integração ou de processamento leva a `FALHA_TECNICA`. Nunca escolha uma regra por aproximação ou afirme erro fiscal sem contexto suficiente.
- Registre identificação e versão da regra, vigência, fundamento, parâmetros, entradas utilizadas, cálculo esperado, valores declarados, diferenças e resultado. Preserve o XML original e os eventos recebidos conforme o contrato de custódia; não reescreva evidências históricas quando uma regra mudar. Uma nova interpretação deve ser rastreável à versão que a produziu.
- O setor fiscal define e homologa o conteúdo tributário. Agentes podem propor estrutura, testes e implementação, mas não homologar alíquotas, classificações, vigências ou fundamentos por conta própria. Verifique atos e documentação oficiais aplicáveis antes de propor uma regra para aprovação.
- Systax é referência de organização do motor (cenários, regras versionadas, parâmetros e cálculo por item); não é fonte legal nem fonte de regras a copiar. TOTVS FISA170/CFGTRIB e TES são referências para entender o legado **se** seu uso na empresa for confirmado. OCA `l10n-brazil` e OpenFisca são referências conceituais; não copie código da OCA sem avaliar sua licença AGPL-3.0.

## Integrações, dados e segurança

- Respeite os contratos entre Halley e Contei. Valide autenticação, autorização, emissor, audiência e expiração conforme o contrato vigente; não invente claims ou conceda acesso por inferência. Trate entrada externa como não confiável.
- Processe documentos e eventos com idempotência e histórico auditável conforme a especificação. Diferencie o documento, seus eventos e as análises derivadas. Cancelamento ou correção não apagam evidências anteriores.
- Encapsule QIve, emissor, banco e outros serviços externos em adaptadores. Defina tratamento observável para falha, repetição e retomada; evite registrar XML integral, tokens, dados pessoais e segredos em logs.
- Faça alterações de esquema por migrações compatíveis e verificáveis. Inspecione o banco e a configuração reais antes de executar uma migração; nunca presuma que uma coluna ou índice já existe em produção.
- Não codifique segredos nem exponha dados fiscais reais em fixtures, exemplos ou mensagens. Use variáveis de ambiente e dados de teste sintéticos.

## Implementação e verificação

- Mantenha as mudanças pequenas e coerentes com as fronteiras existentes. Prefira lógica de domínio separada de HTTP, persistência e provedores externos. Evite abstrações para cenários futuros ainda não especificados.
- Teste comportamento observável e regras de maior risco: aplicabilidade e vigência, precisão de cálculos, resultado inconclusivo, falha técnica, idempotência, eventos fora de ordem, cancelamento e autorização quando pertinentes à tarefa.
- Execute os testes, análise estática e compilação disponíveis que cubram as alterações. Relate exatamente quais verificações passaram, quais não rodaram e por quê. Não declare uma integração validada apenas com mocks; as provas de contrato exigidas pelo plano precisam de evidência própria.
- Na entrega, resuma o comportamento alterado, os arquivos principais, os testes executados e as decisões pendentes. Se uma dependência externa bloquear a tarefa, descreva a condição necessária para retomá-la.

## Referências de pesquisa fiscal

- [Portal Nacional da NF-e](https://www.nfe.fazenda.gov.br/), [CONFAZ](https://www.confaz.fazenda.gov.br/legislacao), [Reforma Tributária do Consumo](https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/acoes-e-programas/programas-e-atividades/reforma-tributaria-do-consumo) e [Comitê Gestor do IBS](https://www.cgibs.gov.br/): fontes oficiais a consultar conforme o tributo e a vigência.
- [Systax Tax Engine](https://documentacao.systax.com.br/books/tax-engine-rt) e [Tax Validator](https://documentacao.systax.com.br/books/manual-do-tax-validator-reforma-tributaria): referências de arquitetura e comparação.
- [TOTVS Configurador de Tributos](https://centraldeatendimento.totvs.com/hc/pt-br/articles/360055360933-Cross-Segmento-TOTVS-Backoffice-Linha-Protheus-FIS-FISA170-Procedimentos-de-configura%C3%A7%C3%A3o-e-utiliza%C3%A7%C3%A3o-da-rotina-Configurador-de-Tributos), [OCA `l10n-brazil`](https://github.com/OCA/l10n-brazil) e [OpenFisca](https://openfisca.org/doc/coding-the-legislation/index.html): referências técnicas, sujeitas às restrições acima.
