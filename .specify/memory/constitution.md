<!--
Sync Impact Report
- Version change: unversioned scaffold -> 1.0.0
- Modified principles:
  - Principle placeholder 1 -> I. Fronteiras do Ecossistema
  - Principle placeholder 2 -> II. Regras Explícitas e Validadas
  - Principle placeholder 3 -> III. Evidência e Decisão Responsável
  - Principle placeholder 4 -> IV. Histórico Preservado
  - Principle placeholder 5 -> V. Simplicidade Suficiente
- Added sections:
  - Aplicação
  - Critério de Uso
  - Governance rules
- Removed sections: none
- Follow-up TODOs: none
-->
# Constituição do Contei

## Core Principles

### I. Fronteiras do Ecossistema

O Halley DEVE responder pelas operações, pelos cadastros e pelo backend dos demais módulos do ERP.
O Contei DEVE atuar como backend somente das áreas fiscal e contábil integradas ao Halley, incluindo
os cadastros, dados, regras, processos e APIs dessas áreas. A emissão e a captura de documentos
fiscais DEVEM ser realizadas por sistemas externos. O Contei DEVE integrar-se a eles para receber
os documentos e retornos necessários ao seu trabalho.

### II. Regras Explícitas e Validadas

Toda regra fiscal ou contábil DEVE ser expressa em termos verificáveis, coberta por testes que
demonstrem seu comportamento e validada pelo responsável pelo domínio afetado antes do uso.
Regras implícitas ou sem validação NÃO DEVEM orientar resultados do Contei.

### III. Evidência e Decisão Responsável

Toda conferência ou sugestão DEVE apresentar os dados considerados e os motivos do resultado.
O Contei PODE sugerir uma ação, mas a decisão de aceitá-la ou rejeitá-la DEVE permanecer com o
responsável designado.

### IV. Histórico Preservado

O Contei DEVE preservar o histórico das análises e decisões, incluindo dados considerados,
motivos, resultado, responsável e data. Correções DEVEM manter o registro anterior identificável
para que cada decisão possa ser reconstruída.

### V. Simplicidade Suficiente

Cada funcionalidade DEVE usar a menor complexidade que satisfaça a especificação aprovada e os
testes. Abstrações, dependências e automações novas somente DEVEM existir quando atenderem a um
requisito concreto ou resolverem uma limitação demonstrada.

## Aplicação

Estes princípios se aplicam a toda especificação, implementação, integração, análise,
conferência, sugestão e correção do Contei. O responsável por uma validação ou decisão DEVE ser
uma pessoa ou um papel explicitamente identificado no respectivo registro.

## Critério de Uso

Uma funcionalidade somente PODE ser usada após a aprovação dos testes exigidos por sua especificação.
Quando envolver regras fiscais ou contábeis, estas DEVEM ter sido validadas pelos responsáveis. Quando
produzir análises, conferências ou sugestões, os dados considerados, os motivos dos resultados e os
registros históricos exigidos por esta Constituição DEVEM estar disponíveis

## Governance

Esta Constituição prevalece sobre práticas ou orientações conflitantes do projeto.

- Toda emenda DEVE documentar motivo e impacto, receber aprovação dos responsáveis pelo produto
  e pelos domínios afetados e atualizar a versão e a data antes de entrar em vigor.
- O versionamento DEVE seguir SemVer: MAJOR para remoções ou redefinições incompatíveis de
  princípios, MINOR para novos princípios ou ampliações materiais e PATCH para esclarecimentos
  sem mudança de obrigação.
- Toda revisão de especificação e de entrega DEVE verificar conformidade com esta Constituição.
  Uma não conformidade DEVE ser corrigida, ou a Constituição formalmente emendada, antes do uso.

**Version**: 1.0.0 | **Ratified**: 2026-09-21 | **Last Amended**: 2026-09-21
