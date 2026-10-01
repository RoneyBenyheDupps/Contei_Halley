# Feature Specification: Consultar itens de NF-e de entrada

**Feature Branch**: `main`

**Created**: 2026-09-28

**Updated**: 2026-09-30

**Status**: Draft

**Input**: Extrair e consultar, pelo backend fiscal do Contei, os itens declarados nas versões preservadas das NF-e de entrada, conforme as decisões do Grilling de requisitos desta conversa.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consultar os itens declarados de uma nota (Priority: P1)

Como responsável fiscal autorizado, quero localizar uma NF-e de entrada na consulta existente e obter seus itens declarados no XML, para conhecer os produtos, valores e tributos informados pelo emitente sem abrir cada item no XML bruto.

**Why this priority**: Entrega a consulta básica, inclusive para notas já armazenadas, sem depender de uma interface do Halley ou de regras fiscais ainda não homologadas.

**Independent Test**: Localizar uma nota já armazenada com XML completo, consultar seus itens pela identidade fiscal autorizada e conferir cada campo apresentado com o XML preservado.

**Acceptance Scenarios**:

1. **Given** uma NF-e de entrada já armazenada e acessível ao responsável fiscal, com XML completo e itens, **When** ele consultar seus itens, **Then** recebe todos os itens na ordem declarada, com número do item, dados de produto, quantidades, unidades e valores declarados, e a identificação da versão do XML utilizada.
2. **Given** um item com ICMS, IPI, PIS e COFINS declarados, **When** ele for consultado, **Then** aparecem os códigos de situação, bases, alíquotas e valores presentes nesses grupos, com os valores declarados preservados, sem cálculo nem parecer sobre correção fiscal.
3. **Given** um campo opcional ou grupo tributário ausente no item, **When** ele for consultado, **Then** o campo ou grupo permanece ausente; nenhum zero, código ou valor é inferido.
4. **Given** uma identidade sem a autorização fiscal exigida pela consulta existente, **When** tentar consultar itens, **Then** o acesso é recusado.
5. **Given** uma versão válida ainda sem itens armazenados, **When** a extração completa tiver sucesso na primeira consulta, **Then** os itens são armazenados para aquela versão e as consultas seguintes obtêm o conjunto armazenado, sem nova extração.

---

### User Story 2 - Consultar itens de versões diferentes (Priority: P2)

Como responsável fiscal autorizado, quero saber qual versão preservada do XML originou os itens apresentados e consultar versões válidas anteriores, para reconhecer mudanças sem perder a evidência original.

**Why this priority**: Uma mesma chave de acesso pode ter mais de uma versão de XML preservada; os itens não podem ser apresentados sem sua origem.

**Independent Test**: Usar uma nota com duas versões válidas de XML e itens distintos, consultar sem escolher versão e depois escolher cada versão pelo histórico da nota.

**Acceptance Scenarios**:

1. **Given** uma nota com duas ou mais versões válidas de XML, **When** os itens forem consultados sem seleção de versão, **Then** a consulta usa a versão válida mais recente e identifica inequivocamente essa versão.
2. **Given** uma versão válida anterior identificada na nota, **When** ela for escolhida explicitamente, **Then** a consulta apresenta os itens declarados naquela versão e mantém disponível seu XML original preservado.
3. **Given** uma nova versão válida de XML para uma nota já consultável, **When** ela for incorporada ao histórico, **Then** passa a ser a versão padrão; as versões anteriores permanecem consultáveis sem alteração de seus XMLs preservados.
4. **Given** itens armazenados para duas versões válidas da mesma nota, **When** cada versão for consultada, **Then** cada resposta usa somente os itens armazenados para o respectivo XML, sem duplicação ou mistura.

---

### User Story 3 - Distinguir ausência de XML e falha de extração (Priority: P3)

Como responsável fiscal autorizado, quero entender por que os itens não estão disponíveis, para não interpretar uma lista vazia ou incompleta como o conteúdo da nota.

**Why this priority**: Resumos de NF-e não contêm itens, e uma falha técnica não deve produzir uma representação aparentemente completa.

**Independent Test**: Consultar uma nota apenas com `resNFe` e uma nota cuja versão válida tenha falhado na extração; verificar o estado apresentado, o acesso ao XML disponível e a seleção explícita de outra versão extraída.

**Acceptance Scenarios**:

1. **Given** uma nota com apenas `resNFe` e sem cancelamento, **When** seus itens forem consultados, **Then** aparece “Aguardando XML”, sem lista vazia de itens.
2. **Given** uma nota cancelada cujo XML original ainda não foi disponibilizado, **When** seus itens forem consultados, **Then** aparece “Cancelada; XML original indisponível”, conforme a situação documental já definida pela triagem, sem lista vazia de itens.
3. **Given** uma versão válida de XML cuja extração de itens falhou, **When** essa versão for consultada, **Then** a falha técnica e a versão são identificadas, nenhum item parcial é apresentado, o XML continua disponível para download e o suporte pode acompanhar a falha sem criação de pendência fiscal.
4. **Given** uma versão mais recente com falha de extração e uma versão anterior extraída com sucesso, **When** a nota for consultada sem seleção de versão, **Then** a versão mais recente permanece indicada como padrão e indisponível; o responsável pode escolher explicitamente a versão anterior para ver seus itens.
5. **Given** uma nota antes limitada a `resNFe`, **When** seu XML completo e válido for recebido e os itens forem extraídos com sucesso, **Then** os itens passam a ser consultáveis com referência a essa versão do XML.
6. **Given** uma versão cuja extração falhou, **When** ela for consultada novamente, **Then** o Contei tenta a extração outra vez; se obtiver sucesso, armazena o conjunto completo, resolve a falha técnica e passa a apresentá-lo.

### Edge Cases

- A nota tem XML completo e válido, mas está cancelada ou já recebeu uma decisão de triagem: os itens do XML continuam consultáveis, sem alterar a situação ou a decisão existente.
- Um item possui valor declarado igual a zero: o zero é apresentado; ele não é confundido com campo ausente.
- As variantes de ICMS, IPI, PIS ou COFINS trazem apenas alguns dos campos previstos: apresentar somente os campos efetivamente declarados, sem completar os demais.
- `PISST`, `COFINSST`, `ICMSUFDest` ou outro grupo irmão fora dos quatro grupos principais está presente: sua presença não causa falha de extração e seu conteúdo permanece no XML original.
- Uma variante ou campo relevante dos quatro grupos principais não pode ser mapeado com segurança: a versão fica indisponível para itens, com categoria técnica segura, sem conjunto parcial armazenado.
- A lista de itens não pode ser extraída integralmente de uma versão, inclusive por estrutura inesperada ou item ilegível: a versão inteira fica indisponível para consulta de itens e recebe tratamento técnico.
- Uma versão de XML inválida para a triagem não é tratada como versão válida para consulta de itens. Seu tratamento técnico e sua preservação seguem a funcionalidade de triagem.
- A mesma versão é recebida ou consultada novamente: não surgem itens armazenados duplicados nem uma nova versão documental por causa desta funcionalidade.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O Contei DEVE permitir que a identidade com a autorização fiscal já exigida para consultar uma NF-e de entrada acesse os itens dessa nota, inclusive quando ela já estava armazenada antes desta funcionalidade. A consulta NÃO DEVE ampliar o conjunto de notas acessíveis nem importar documentos fora do escopo existente.
- **FR-002**: A consulta DEVE identificar a NF-e pela chave de acesso existente e relacionar cada conjunto de itens a uma versão válida e preservada do XML dessa mesma nota.
- **FR-003**: Para cada item, o Contei DEVE apresentar número e ordem declarados e, quando presentes, código e descrição do produto pelo fornecedor, NCM, CFOP, CEST e GTIN.
- **FR-004**: Para cada item, o Contei DEVE apresentar, quando declarados, unidade, quantidade e valor unitário comerciais e tributáveis; valor do produto, desconto, frete, seguro e outras despesas.
- **FR-005**: Para cada item, o Contei DEVE apresentar os códigos de situação e os campos de base, alíquota e valor declarados nos quatro grupos XML principais ICMS, IPI, PIS e COFINS, quando presentes, distinguindo os campos de cada tributo. Grupos irmãos como `PISST`, `COFINSST` e `ICMSUFDest` ficam fora da extração estruturada e sua presença NÃO DEVE causar falha.
- **FR-006**: Os dados apresentados DEVEM corresponder ao conteúdo declarado na versão do XML indicada, preservando os valores decimais informados e a distinção entre campo ausente e zero declarado. O Contei NÃO DEVE calcular, completar, arredondar ou julgar tributos nesta funcionalidade.
- **FR-007**: A consulta sem indicação de versão DEVE usar a versão válida mais recente do XML. O responsável fiscal DEVE poder escolher cada versão válida anterior e obter seus respectivos itens.
- **FR-008**: Cada consulta de itens DEVE informar a referência inequívoca à versão do XML de origem, incluindo seu identificador no histórico da nota e a evidência de integridade já disponível, e permitir acessar o XML original preservado daquela versão.
- **FR-009**: Para uma nota apenas com `resNFe` e sem XML completo, a consulta de itens DEVE apresentar a situação documental existente, inclusive “Aguardando XML” ou “Cancelada; XML original indisponível”, conforme o caso, e NÃO DEVE retornar uma lista vazia como se a extração tivesse sido concluída.
- **FR-010**: Se a extração de itens falhar para uma versão válida, o Contei DEVE identificar essa versão e uma categoria técnica estável e segura, sem expor XML ou mensagens internas do parser; NÃO DEVE apresentar ou armazenar itens parciais nem substituir automaticamente seus itens pelos de outra versão, e DEVE manter o XML dessa versão disponível para download.
- **FR-011**: A falha de extração DEVE ficar vinculada à versão e ser acompanhável pelo suporte operacional, sem criar conclusão ou pendência fiscal e sem alterar `technicalIssueActive` da consulta existente da NF-e. Versões extraídas com sucesso DEVEM continuar consultáveis por escolha explícita.
- **FR-012**: A chegada posterior do XML completo ou de uma nova versão válida DEVE tornar seus itens consultáveis quando a extração for bem-sucedida, preservando as versões anteriores e sem mudar automaticamente decisões de triagem.
- **FR-013**: A funcionalidade NÃO DEVE alterar os XMLs originais, as ocorrências, a situação documental ou o histórico de decisões preservados pela triagem.
- **FR-014**: Após extração integral bem-sucedida, o Contei DEVE armazenar os itens declarados vinculados exclusivamente à versão do XML de origem. Consultas posteriores dessa versão DEVEM usar o conjunto armazenado sem executar novamente a extração; versões ainda não consultadas, inclusive de notas antigas, DEVEM poder ser extraídas e armazenadas na primeira consulta.
- **FR-015**: Uma versão cuja extração falhou NÃO DEVE ter conjunto de itens armazenado como sucesso e DEVE receber nova tentativa de extração a cada consulta dessa versão. O sucesso posterior DEVE armazenar o conjunto completo e resolver a falha técnica sem apagar seu histórico.
- **FR-016**: O replay de um XML antigo NÃO DEVE regredir o ponteiro da nota para a versão mais recente nem sobrescrever o cabeçalho projetado dessa versão (número, emitente, destinatário, valor e emissão). A consulta de itens, o detalhe da NF-e e a evidência de novas decisões DEVEM identificar a versão válida mais recente pelo histórico de ocorrências válidas mesmo que um ponteiro já armazenado esteja desatualizado.

### Scope Boundaries

**Included**:

- Consulta autenticada por NF-e de entrada já incorporada ao escopo fiscal do Contei, inclusive notas armazenadas antes desta entrega.
- Dados de produto e valores do item e dados declarados de ICMS, IPI, PIS e COFINS descritos acima.
- Consulta por versão válida do XML e situações de indisponibilidade dos itens.
- Armazenamento do conjunto completo de itens após extração bem-sucedida, separado por versão do XML.
- Aceite do backend do Contei com os cenários desta especificação verificados.

**Excluded**:

- Interface própria do Contei; apresentação dos itens no Halley nesta entrega.
- Busca por produto ou lista de itens entre várias notas.
- Pedido de compra, recebimento, estoque, Protheus e dados externos ao XML para enriquecer itens.
- Cálculo, conferência de correção, recomendação ou homologação de regras tributárias.
- Extração estruturada de grupos do item não enumerados nos requisitos; eles continuam disponíveis no XML original.
- Captura automática de documentos, seu checkpoint, ampliação do escopo de descoberta e mudança do aceite da triagem existente.

### Key Entities

- **NF-e de entrada**: documento já incorporado ao escopo do Contei, identificado pela chave de acesso e associado às versões de XML preservadas.
- **Versão preservada do XML**: conteúdo original recebido para a nota, com identificador, ordem no histórico e evidência de integridade; é a fonte dos itens exibidos.
- **Item declarado**: posição e dados de produto, valores e tributos informados pelo emitente em uma versão específica do XML, sem interpretação fiscal do Contei.
- **Conjunto de itens extraídos**: dados declarados armazenados somente após extração completa, vinculados a uma única versão preservada do XML e reutilizados em consultas posteriores.
- **Disponibilidade da extração**: condição da consulta de itens para uma versão ou nota sem XML, distinguindo itens disponíveis, espera pelo XML e falha técnica.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Em 100% das versões válidas de XML com extração bem-sucedida no conjunto de aceite, inclusive de notas já armazenadas, o responsável fiscal autorizado consegue consultar todos os itens da versão escolhida, na ordem declarada, sem itens omitidos ou duplicados.
- **SC-002**: Em 100% dos campos de produto, valores e ICMS, IPI, PIS e COFINS conferidos no conjunto de aceite, o resultado coincide com o XML de origem; campos ausentes continuam ausentes e zeros declarados continuam visíveis.
- **SC-003**: Em 100% dos casos de múltiplas versões do conjunto de aceite, a consulta padrão identifica e usa a versão válida mais recente, e cada versão válida anterior pode ser consultada com referência ao respectivo XML preservado.
- **SC-004**: Em 100% dos casos de apenas `resNFe` ou falha de extração do conjunto de aceite, a causa da indisponibilidade é identificável e nenhuma lista vazia ou parcial é apresentada como extração completa.
- **SC-005**: Em 100% das tentativas do conjunto de aceite sem autorização fiscal válida, o acesso aos itens é recusado.
- **SC-006**: No piloto controlado, pelo menos 95% das consultas de notas com até 100 itens apresentam o resultado ou a condição de indisponibilidade em até 3 segundos.
- **SC-007**: Todos os cenários de aceite desta especificação são verificados antes de concluir a entrega do backend do Contei; a integração de apresentação pelo Halley é posterior.
- **SC-008**: Em 100% das versões extraídas com sucesso no conjunto de aceite, o conjunto completo fica armazenado uma única vez por versão e a consulta repetida o reutiliza; versões com falha não deixam conjunto parcial armazenado.
- **SC-009**: Em 100% das consultas repetidas a versões com falha no conjunto de aceite, há nova tentativa; uma recuperação posterior disponibiliza e armazena os itens, enquanto a falha anterior permanece rastreável.

## Assumptions

- A consulta de NF-e, o controle de acesso fiscal, o histórico de versões válidas e o download do XML preservado já existem e serão usados por esta funcionalidade.
- “Notas já armazenadas” significa notas incorporadas ao escopo fiscal já autorizado; esta funcionalidade não busca retroativamente documentos fora desse escopo.
- A situação “Cancelada; XML original indisponível” e o tratamento de versões inválidas seguem a especificação vigente de triagem.
- Os grupos de tributos podem ter variantes e campos opcionais; o escopo de apresentação é o que estiver declarado nas categorias citadas, sem inventar conteúdo ausente.
- A meta de tempo de consulta é um valor inicial para o piloto controlado e pode ser revista com medição real, sem reduzir os requisitos de completude e rastreabilidade.
- O aceite desta API de consulta do Contei não altera o critério de conclusão da funcionalidade de triagem, que continua exigindo uso pelo Halley.
