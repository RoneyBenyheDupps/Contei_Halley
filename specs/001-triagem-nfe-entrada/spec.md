# Feature Specification: Triagem interna de NF-e de entrada

**Feature Branch**: `main`

**Created**: 2026-09-22

**Status**: Draft

**Input**: User description: "Usar o entendimento compartilhado confirmado para especificar a funcionalidade triagem-nfe-entrada, sem reabrir decisões já confirmadas."

## Clarifications

### Session 2026-09-22

- Q: Se o XML completo de uma NF-e antes exibida como “Cancelada; XML original indisponível” aparecer posteriormente na Qive, ela deve entrar na triagem normal? → A: Sim. Com o XML completo e verificável, entra uma única vez na triagem, preservando o histórico e destacando o cancelamento; se o CNPJ coincidir, não há recomendação e o fiscal escolhe.

### Session 2026-09-24

- Q: A descoberta automática deve incluir NF-e que a Qive classifica apenas como “citadas” para encontrar todo possível CNPJ destinatário divergente? → A: Não. No piloto, consultar somente NF-e classificadas pela Qive como recebidas para a empresa. Uma nota apenas citada pode pertencer legitimamente a terceiro e ter sido disponibilizada via `autXML`. Toda NF-e que entrar na triagem continua sujeita à conferência do CNPJ destinatário no XML e à recomendação de pendência quando houver divergência. O filtro de recebidas pode deixar de descobrir notas com destinatário incorreto classificadas como citadas; testar um caso real de cada classificação na conta controlada e documentar o retorno da API. Uma eventual análise de citadas exige critério específico de seleção em evolução posterior.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Decidir a triagem de uma NF-e completa (Priority: P1)

Como responsável fiscal autenticado pelo Halley, quero consultar os dados e as evidências de uma NF-e de entrada capturada pela Qive para decidir se ela fica sem ação nesta etapa ou com pendência para tratamento.

**Why this priority**: Esta é a tarefa fiscal completa que entrega o primeiro valor do Contei. Ela vai além da captura do documento sem antecipar análise fiscal ou gestão da pendência.

**Independent Test**: Pode ser testada com uma empresa ativa, uma NF-e completa e um responsável fiscal autorizado, verificando a recomendação por CNPJ divergente, a decisão registrada e as evidências apresentadas no Halley.

**Acceptance Scenarios**:

1. **Given** uma NF-e autorizada, com XML disponível e CNPJ destinatário igual ao CNPJ da empresa, **When** o responsável fiscal abrir a triagem, **Then** o sistema recomenda "Sem ação nesta etapa", apresenta as evidências consideradas e permite registrar essa decisão, que encerra a triagem sem criar fila, tarefa ou encaminhamento para análise futura.
2. **Given** uma NF-e obtida pela consulta de recebidas, com XML disponível e CNPJ destinatário diferente do CNPJ da empresa, **When** o responsável fiscal abrir a triagem, **Then** o sistema recomenda "Pendência para tratamento" e mantém a divergência visível.
3. **Given** uma NF-e com CNPJ destinatário divergente, **When** o responsável fiscal escolher "Pendência para tratamento" e o motivo predefinido "CNPJ destinatário divergente", **Then** a decisão é gravada com autor, data, motivo e evidências consideradas.
4. **Given** uma NF-e com divergência de CNPJ, **When** o responsável fiscal decidir "Sem ação nesta etapa", **Then** a decisão é aceita com o motivo predefinido de divergência aceita e a divergência continua visível.
5. **Given** uma NF-e cancelada com XML disponível e CNPJ destinatário igual ao da empresa, **When** ela entrar na triagem, **Then** o cancelamento é destacado sem recomendação de decisão, e o responsável fiscal pode escolher uma das duas decisões.
6. **Given** um usuário autenticado sem o papel fiscal exigido, **When** tentar consultar ou decidir uma triagem, **Then** o acesso é recusado.

---

### User Story 2 - Consultar e corrigir decisões preservando o histórico (Priority: P2)

Como responsável fiscal, quero localizar NF-e já recebidas, consultar sua situação documental e seu histórico e corrigir uma decisão anterior sem apagar o que ocorreu.

**Why this priority**: Mudanças externas e correções humanas são inevitáveis. O histórico preservado torna cada decisão reconstruível e evita que uma atualização documental reescreva a decisão do responsável.

**Independent Test**: Pode ser testada com uma NF-e previamente triada, alterando sua decisão e sua situação documental e verificando que o estado atual e todos os registros anteriores continuam consultáveis.

**Acceptance Scenarios**:

1. **Given** uma NF-e já triada, **When** uma mudança documental ficar disponível na Qive, **Then** a situação documental e o histórico são atualizados em até 24 horas dessa disponibilidade, um alerta fica visível e a decisão interna anterior permanece inalterada.
2. **Given** uma decisão registrada, **When** o responsável fiscal mudá-la em qualquer dos dois sentidos, **Then** a nova decisão passa a ser a atual e a decisão anterior permanece consultável com autor, data e motivo.
3. **Given** consultas repetidas ou uma atualização para a mesma chave de acesso, **When** o documento for recebido novamente, **Then** nenhum documento duplicado é criado e as novas informações ficam associadas ao documento existente.
4. **Given** que dois responsáveis abriram a mesma versão da triagem, **When** um deles salvar uma decisão depois que o outro já alterou o registro, **Then** a gravação desatualizada é recusada e o responsável deve revisar o estado atual.

---

### User Story 3 - Acompanhar documentos sem XML completo (Priority: P3)

Como responsável fiscal, quero acompanhar NF-e aguardando o XML e NF-e canceladas cujo XML original não foi disponibilizado, para conhecer sua situação sem tratá-las como pendências da triagem.

**Why this priority**: A captura externa pode passar por etapas intermediárias ou não disponibilizar o XML de uma NF-e já cancelada. Essas situações precisam permanecer consultáveis fora da fila normal de triagem.

**Independent Test**: Pode ser testada com respostas controladas que representem resumo sem XML e cancelamento anterior à captura do XML, verificando a visibilidade e o destino de cada caso.

**Acceptance Scenarios**:

1. **Given** um resumo de NF-e sem XML completo, **When** o registro for obtido, **Then** ele aparece como "Aguardando XML" fora da triagem e novas consultas automáticas são realizadas; quando o XML ficar disponível, a NF-e entra uma única vez na fila normal de triagem.
2. **Given** uma NF-e cancelada antes da captura do XML original, **When** a Qive fornecer apenas o resumo e o evento de cancelamento, **Then** ambos são preservados, o documento aparece como "Cancelada; XML original indisponível", permanece consultável fora da fila normal e não recebe pendência fiscal automática; se o XML completo e verificável chegar depois, entra uma única vez na triagem, com o histórico preservado e o cancelamento destacado; com CNPJ coincidente, nenhuma decisão é recomendada e o fiscal escolhe.

---

### User Story 4 - Acompanhar falhas técnicas da integração (Priority: P4)

Como integrante do suporte operacional, quero receber um alerta ativo quando a integração falhar e acompanhar novas tentativas automáticas, para restaurar a obtenção de documentos sem criar pendências fiscais.

**Why this priority**: Falhas técnicas exigem ação do suporte operacional e não devem ser transferidas ao responsável fiscal.

**Independent Test**: Pode ser testada com falha de comunicação, XML ilegível ou resposta incompatível controlados, verificando o alerta ao suporte, a nova tentativa automática e o prosseguimento após a recuperação.

**Acceptance Scenarios**:

1. **Given** XML ilegível, falha de comunicação ou resposta incompatível da integração, **When** o problema ocorrer, **Then** o suporte operacional recebe alerta ativo e o sistema realiza nova tentativa automática sem criar pendência fiscal; após a recuperação, o documento segue o fluxo correspondente ao conteúdo obtido.

### Edge Cases

- Um registro cuja data de entrada na Qive coincida exatamente com a ativação da empresa é incluído para evitar perda na fronteira do corte.
- Um mesmo documento pode receber cancelamento, Carta de Correção, manifestação ou outro evento sem mudar sua chave de acesso; esses eventos são preservados no documento existente.
- Carta de Correção, manifestação ou evento não interpretado nesta versão permanece visível, mas não gera recomendação de pendência.
- Uma situação documental diferente das situações reconhecidas não é inferida como nova regra fiscal; ela recebe tratamento técnico até que seu significado seja validado.
- Uma NF-e sem CNPJ destinatário verificável não entra na triagem e recebe tratamento técnico.
- Uma NF-e apenas citada pela Qive não entra pela descoberta automática do piloto, mesmo que seu XML tenha destinatário diferente; o comportamento da API para casos reais de recebida e citada deve ser comprovado na conta controlada.
- Uma decisão com o motivo "Outro motivo" sem observação é recusada.
- A desativação da integração impede novas entradas, mas não remove documentos, decisões ou históricos já preservados.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O Contei DEVE manter um cadastro fiscal mínimo para uma empresa, contendo seu identificador no Contei, a referência correspondente no Halley, um único CNPJ, sua situação e data de ativação e a referência de uma única conexão Qive.
- **FR-002**: A empresa somente PODE ser ativada após a conexão Qive ser validada para o CNPJ cadastrado e registrada evidência verificável da conta vinculada, do certificado apto e da captura completa habilitada na Qive; essas condições são pré-condições externas.
- **FR-003**: O Contei DEVE descobrir automaticamente somente NF-e classificadas pela Qive como recebidas para o CNPJ da empresa e cuja data de entrada na Qive seja igual ou posterior à ativação. Notas apenas citadas NÃO DEVEM ser importadas automaticamente no piloto. A classificação da Qive limita a descoberta; ela NÃO substitui a conferência do CNPJ destinatário no XML de toda NF-e incorporada.
- **FR-004**: O Contei DEVE identificar cada NF-e pela chave de acesso e DEVE associar consultas repetidas e mudanças posteriores ao mesmo documento, sem duplicá-lo.
- **FR-005**: O Contei DEVE preservar sem alteração os bytes de cada XML disponibilizado, sua origem e o conteúdo completo de cada situação, evento e versão efetivamente recebidos da Qive, sem apagar registros anteriores. Reentrega idêntica não cria nova ocorrência; qualquer mudança de conteúdo recebido, inclusive em campo não usado pela triagem, permanece no histórico.
- **FR-006**: Quando o XML completo ainda não estiver disponível e não houver cancelamento, o Contei DEVE manter o documento como "Aguardando XML" fora da fila normal de triagem e DEVE consultá-lo novamente de forma automática.
- **FR-007**: Quando uma NF-e tiver sido cancelada antes da disponibilização do XML original, o Contei DEVE preservar o resumo e o evento de cancelamento, exibir "Cancelada; XML original indisponível" e mantê-la consultável fora da fila normal enquanto não houver XML completo e verificável, sem gerar pendência fiscal automática.
- **FR-008**: XML ilegível, falha de comunicação, ausência inesperada de dados obrigatórios ou resposta incompatível DEVEM gerar alerta ativo ao suporte operacional e nova tentativa automática, sem criar pendência fiscal.
- **FR-009**: Apenas uma NF-e com XML completo e verificável PODE entrar na fila normal com a situação interna "Aguardando triagem"; o caso de cancelamento sem XML definido em FR-007 permanece fora da fila até a disponibilização do XML, quando DEVE entrar uma única vez, preservando o histórico e destacando o cancelamento.
- **FR-010**: Para cada NF-e apta à triagem, o Contei DEVE comparar o CNPJ destinatário do documento com o CNPJ da empresa e apresentar ambos como evidência.
- **FR-011**: O Contei DEVE registrar separadamente a situação documental recebida da Qive e a decisão interna de triagem.
- **FR-012**: O Contei DEVE recomendar "Pendência para tratamento" somente quando o CNPJ destinatário divergir. Com CNPJ coincidente e NF-e não cancelada, DEVE recomendar "Sem ação nesta etapa". Com CNPJ coincidente e NF-e cancelada, NÃO DEVE recomendar nenhuma das duas decisões; o cancelamento DEVE ser destacado para decisão do responsável fiscal.
- **FR-013**: Cartas de Correção, manifestações e demais eventos posteriores DEVEM ter metadados e conteúdo preservado consultáveis pelo Halley autenticado, mas NÃO DEVEM gerar recomendação de pendência nesta versão.
- **FR-014**: A triagem DEVE apresentar, no mínimo, chave, número, emitente, destinatário, valor total, datas de emissão e entrada na Qive, origem, situação documental, divergências, decisão atual, histórico e acesso ao XML preservado quando disponível.
- **FR-015**: Somente uma identidade autenticada e autorizada pelo Halley com o papel fiscal exigido PODE consultar ou decidir uma triagem; o Contei NÃO DEVE manter cadastro próprio de usuários.
- **FR-016**: O responsável fiscal DEVE poder registrar "Sem ação nesta etapa" ou "Pendência para tratamento", inclusive contrariando a recomendação do Contei. "Sem ação nesta etapa" DEVE encerrar a triagem sem criar fila, tarefa ou encaminhamento para análise futura.
- **FR-017**: Para "Sem ação nesta etapa", os motivos predefinidos DEVEM ser "Nenhuma divergência exige tratamento nesta etapa" e "Divergência ou situação conhecida aceita nesta etapa".
- **FR-018**: Para "Pendência para tratamento", os motivos predefinidos DEVEM ser "CNPJ destinatário divergente", "NF-e cancelada" e "Outro motivo"; a observação DEVE ser obrigatória somente para "Outro motivo". O motivo "NF-e cancelada" PODE ser escolhido pelo responsável fiscal, mas não gera decisão ou recomendação automática.
- **FR-019**: A divergência de CNPJ que fundamentou uma recomendação DEVE continuar visível quando o responsável registrar uma decisão diferente da recomendada.
- **FR-020**: O responsável fiscal DEVE poder mudar a decisão nos dois sentidos; cada decisão e correção DEVE registrar autor, papel, data, motivo, observação e evidências consideradas, preservando todos os registros anteriores.
- **FR-021**: O Contei DEVE recusar uma decisão baseada em uma versão desatualizada da triagem e informar que o responsável precisa revisar o estado atual.
- **FR-022**: Uma mudança documental posterior DEVE atualizar a situação e o histórico, produzir alerta visível e NÃO DEVE reabrir nem alterar automaticamente a decisão interna vigente.
- **FR-023**: O responsável fiscal DEVE poder listar documentos por decisão atual e período, pesquisar por chave de acesso ou número e consultar detalhe, XML disponível, metadados e conteúdo de cada evento preservado e histórico completo pelo Halley.
- **FR-024**: O Contei DEVE manter documentos, eventos e decisões consultáveis mesmo após a desativação da integração e NÃO DEVE oferecer exclusão funcional nesta versão.
- **FR-025**: O Contei NÃO DEVE solicitar Ciência da Emissão nem transmitir manifestações conclusivas; a Ciência eventualmente registrada pela Qive é parte da captura externa.
- **FR-026**: As regras de recomendação, os motivos predefinidos e seus cenários de teste DEVEM ser validados por um responsável fiscal designado antes do primeiro uso real.
- **FR-027**: O aceite técnico do Contei PODE ocorrer pelo contrato de integração, mas a tarefa somente DEVE ser considerada completa quando o responsável fiscal puder executá-la pelo Halley.
- **FR-028**: Durante o funcionamento do sistema, cada novo registro classificado pela Qive como recebido para a empresa, dentro do corte de ativação e disponibilizado na consulta de descoberta, DEVE aparecer no Contei em até uma hora, contada dessa disponibilidade na Qive.
- **FR-029**: Durante o funcionamento do sistema, cada mudança posterior de documento já incorporado ao escopo e disponibilizada pela Qive DEVE aparecer no Contei em até 24 horas, contadas dessa disponibilidade na Qive, preservando a decisão interna anterior.

### Scope Boundaries

**Included**:

- Uma empresa, um CNPJ e uma conexão Qive em piloto controlado.
- NF-e classificadas pela Qive como recebidas para a empresa e disponibilizadas após a ativação.
- Obtenção e preservação do documento, conferência do destinatário, apresentação da situação e decisão de triagem.
- Consulta do histórico e de mudanças posteriores.
- Tratamento separado de espera por XML e falhas técnicas.
- Alertas ativos ao suporte operacional e novas tentativas automáticas para falhas técnicas.

**Excluded**:

- CT-e, NFS-e e documentos anteriores à ativação.
- Descoberta ou importação automática de NF-e classificadas pela Qive apenas como citadas; sua eventual análise exigirá critério específico de seleção em funcionalidade posterior.
- Emissão pela Focus NFe.
- Manifestação conclusiva à SEFAZ.
- Análise, classificação ou escrituração fiscal ou contábil.
- Tratamento, atribuição, prazo ou conclusão de pendências.
- Fila, tarefa ou encaminhamento para análise futura após "Sem ação nesta etapa".
- Cadastro de estabelecimentos, usuários ou motivos configuráveis.
- DANFE, PDF, painéis e indicadores.
- Exclusão de dados ou política configurável de retenção.

### Key Entities

- **Empresa Fiscal**: representa a única empresa participante do piloto, com referência no Halley, CNPJ, situação e data de ativação e vínculo com a conexão Qive.
- **Documento Fiscal de Entrada**: representa uma NF-e identificada pela chave de acesso, com origem, emitente, destinatário, valor, datas, XML disponível, situação documental atual e decisão de triagem atual.
- **Ocorrência Documental**: representa cada situação, evento ou versão recebida posteriormente para a mesma NF-e, mantendo sua data, origem e conteúdo disponível.
- **Decisão de Triagem**: representa uma decisão humana com resultado, motivo, observação, identidade e papel do responsável, data, evidências consideradas e referência ao estado sobre o qual foi tomada.
- **Falha Técnica**: representa falha de comunicação, conteúdo ilegível ou resposta incompatível, com alerta e estado de acompanhamento pelo suporte operacional, sem produzir decisão fiscal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Durante o funcionamento do sistema, 100% dos novos registros classificados pela Qive como recebidos para a empresa e disponibilizados na consulta de descoberta após a ativação aparecem no Contei em até uma hora, contada dessa disponibilidade, como "Aguardando XML", aptos à triagem, "Cancelada; XML original indisponível" ou em acompanhamento técnico, conforme o caso.
- **SC-002**: Durante o funcionamento do sistema, 100% das mudanças posteriores de documentos já incorporados ao escopo e disponibilizadas pela Qive aparecem no histórico e na situação documental em até 24 horas, contadas dessa disponibilidade, sem alterar automaticamente a decisão interna.
- **SC-003**: Nenhuma consulta repetida ou mudança posterior cria uma segunda NF-e para a mesma chave de acesso em todos os cenários de aceite.
- **SC-004**: O responsável fiscal designado consegue, pelo Halley e sem acesso direto à Qive, consultar as evidências e concluir tanto "Sem ação nesta etapa" quanto "Pendência para tratamento"; a primeira decisão encerra a triagem sem gerar trabalho para análise futura.
- **SC-005**: Em 100% das alterações de decisão dos cenários de aceite, o estado atual e todas as decisões anteriores podem ser reconstruídos com autor, data, motivo e evidências.
- **SC-006**: Em 100% dos cenários de espera por XML ou falha técnica, nenhuma pendência fiscal é criada indevidamente; falhas técnicas geram alerta ativo ao suporte e nova tentativa automática.
- **SC-007**: Todos os cenários de aceite desta especificação são aprovados por testes determinísticos, além de pelo menos um fluxo completo com uma conta Qive controlada.
- **SC-008**: Um responsável fiscal designado aprova formalmente as regras de recomendação e os motivos predefinidos antes do piloto com uma empresa, um CNPJ e uma conexão Qive.

## Assumptions

- O piloto usa uma única empresa, um único CNPJ e uma única conexão Qive; não existe cadastro de estabelecimentos.
- A conta Qive, o CNPJ, o certificado e a captura completa estão configurados antes da ativação no Contei.
- A Qive pode registrar Ciência da Emissão como parte de sua captura; o Contei não solicita esse evento nem transmite manifestações conclusivas.
- A data de entrada informada pela Qive é a referência para o corte de ativação; registros na fronteira exata são incluídos.
- O filtro de recebidas da Qive pode não descobrir uma NF-e com destinatário incorreto se ela for classificada apenas como citada. A regra de divergência se aplica a toda NF-e que entrar na triagem, sem promessa de descobrir notas que a consulta do piloto não retorna. A conta controlada deve demonstrar o retorno da API para um caso real de cada classificação.
- O Halley fornece a referência da empresa, a identidade autenticada, o papel fiscal e a interface usada pelo responsável.
- O suporte operacional acompanha alertas ativos e novas tentativas automáticas por meios externos à fila fiscal.
- Não existe meta de duração para a decisão humana nesta versão.
- Não existe requisito de volume além do piloto controlado; os prazos de uma hora e 24 horas aplicam-se ao funcionamento do sistema a partir da disponibilidade de cada registro ou mudança na Qive.
- A política futura de expurgo não faz parte desta funcionalidade; nenhum dado preservado é excluído nesta versão.
