# Elite Dev na Verzel: Casa de Leilões online (transcrição do PDF)

Fonte: `Teste tecnico Elite Dev - Verzel.pdf` (7 páginas, só imagem). Esta é a transcrição fiel, para consulta e busca.
Vaga: [ELITE DEV] Desenvolvedor(a) Júnior Full Stack (#138 em `vagas.txt`). Recebido em 22/10/2026, **prazo: 29/10/2026**.

## 01. O desafio

Criar uma Casa de Leilões online, onde um leiloeiro coloca itens em leilão e licitantes disputam cada lote com lances ao vivo.
O que será leiloado é escolha livre (obras de arte, carros, cartas colecionáveis, discos, livros raros...), desde que os itens venham de uma **API pública**.

O leiloeiro monta um lote a partir de um item buscado na API externa escolhida, definindo **lance inicial, incremento mínimo, horário de início e fim** e outros campos relevantes.
O licitante deposita um **saldo simulado** na carteira, acompanha os lotes ao vivo, dá lances e, se vencer, recebe um **comprovante de arremate** que pode compartilhar por link.
Qualquer pessoa, **mesmo sem login**, pode auditar o histórico de lances de um lote e verificar que ele não foi adulterado.

**DEPLOY da aplicação é obrigatório.**

### Papéis

| Papel | Pode |
|---|---|
| Leiloeiro (vendedor) | Cria e gerencia os próprios lotes. **Não pode dar lances.** |
| Licitante (cliente) | Deposita saldo, dá lances e arremata itens. |

Referências (não copiar, usar como ponto de partida): catawiki.com/pt, liveauctioneers.com, superbid.net.

## 02. Front-End

| Tela | Requisito |
|---|---|
| Vitrine de lotes | Exibe itens leiloados separando **ao vivo, agendados e encerrados**. Lotes cancelados **não** aparecem. |
| Painel do leiloeiro | Busca itens na API escolhida e cria lote a partir deles (imagem, título, atributos do item, data início/fim, valor mínimo); **cancela lote que ainda não recebeu lances**; vê resultado de cada lote encerrado (se foi arrematado e por quanto) e o **total recebido**. |
| Sala do lote ao vivo | Lance atual, histórico de lances, posição do usuário nos lances, contagem regressiva e indicador claro **"você está ganhando" / "você foi superado"**. Tudo atualizado **sem recarregar a página**. |
| Carteira do licitante | Saldo total, saldo comprometido, saldo disponível e opção de depósito simulado. |
| Meus arremates | Itens em que deu lance e lotes vencidos, com respectivo comprovante e link de compartilhamento. |
| Página de auditoria | **Pública, sem login**. Histórico completo de lances de um lote e informa se está **íntegro ou foi adulterado**. |
| Mensagens de feedback | Mensagem clara para cada lance recusado, com o motivo: abaixo do mínimo, saldo insuficiente, você já está ganhando, lote ainda não iniciado, lote encerrado. |

## 03. Back-End

**Gestão da API externa:** APIs têm limites e instabilidades. A aplicação não pode ficar inutilizável por causa disso. **Vitrine, salas, auditoria e comprovante devem continuar funcionando mesmo que a API caia.**

### Regras de lance

- Só são aceitos em lotes **ao vivo** (entre início e fim).
- O primeiro lance deve ser **≥ lance inicial**. Os seguintes devem ser **≥ lance atual + incremento mínimo**.
- O licitante **líder não pode cobrir o próprio lance**.

| Tema | Regra |
|---|---|
| Saldo comprometido | Saldo disponível = saldo total − comprometido. Quando o licitante lidera, o valor fica comprometido; se superado, volta ao disponível **imediatamente**. O lance só é aceito se couber no disponível. |
| Prorrogação (anti-sniping) | Lance aceito nos **últimos 2 minutos** estende o fim do lote para **+2 minutos**. |
| Liquidação | Ao encerrar, **debita o vencedor e credita o leiloeiro**, gerando o comprovante. Lotes sem lances fecham sem vencedor. |
| Histórico à prova de adulteração | Qualquer alteração, remoção ou inserção posterior no histórico (**mesmo direto no banco de dados**) deve ser detectada pela auditoria. A técnica é escolha nossa; **explicá-la**. |
| Privacidade | Auditoria e comprovante identificam licitantes **sem expor dados pessoais**. |

## 04. Tecnologias e requisitos

**Obrigatórias**

- Front-End: React, com ou sem framework (Next.js, Vite, Remix...).
- Back-End: NodeJS ou Python (NestJS, Express, FastAPI, Django...).
- Banco: PostgreSQL, MySQL ou NoSQL (MongoDB). **Incluir no README instruções claras de configuração e uso.**

**Não funcionais**

- Prazo: 7 dias corridos.
- **Dados de teste:** deixar semeados **1 leiloeiro, 2 clientes e ao menos 1 lote publicado com lances abertos**, para percorrer o fluxo sem montar do zero.
- **Documentação:** README detalhado com passo a passo de configuração e execução. **Funcionalidades com comportamento inesperado devem ser mencionadas.** Ausência de explicações impacta negativamente a nota.

## 05. Opcionais (não obrigatórios, todos considerados na avaliação)

- [ ] Busca e filtro de lotes.
- [ ] Cancelamento de lote com estorno automático.
- [ ] Docker Compose.
- [ ] Testes automatizados.
- [ ] Dark Mode (tema claro e escuro).

**Não precisa fazer:** nota fiscal, revenda entre usuários, aplicativo nativo, recuperação de senha.

## 06. Como enviar

Formulário: https://elitedev.verzel.com.br/?elite-dev-2026-2

| Campo | Conteúdo |
|---|---|
| Nome completo e e-mail | dados de contato |
| Repositório | link do repositório público no GitHub com a aplicação |
| Mais de um repositório? | se front e back separados, informar os dois |
| Deploy | link público da aplicação (**obrigatório**) |
| Onde e como usou IA | permitido; contar onde e como usou e o que revisou ou ajustou (se não usou, dizer) |
