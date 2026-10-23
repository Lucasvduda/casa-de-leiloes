# Plano: Casa de Leilões (Elite Dev Verzel)

Prazo de entrega: **29/10/2026** (meta interna: pronto e deployado até 27/10, 2 dias de folga).
Enunciado: `ENUNCIADO.md`. Regras do projeto: `TaskVagas/.cursor/rules/task-vagas.mdc`.

## Decisões fechadas

| Tema | Decisão | Motivo |
|---|---|---|
| Back-end | Node.js + TypeScript (strict) + **Express 5**, hexagonal manual | Vaga e CV #138 citam Node Express; domínio sem framework |
| Front-end | React + TypeScript + Vite, React Router, TanStack Query, Tailwind | Hooks e componentização (vaga); dark mode via classe |
| Banco | **PostgreSQL** (`pg` + migrations SQL versionadas com checksum) | Transação e `SELECT ... FOR UPDATE` para lance concorrente; SQL explícito nas consultas críticas |
| Tempo real | **SSE** (`EventSource`): ao (re)conectar o servidor reenvia o estado atual (snapshot), então não precisa de `Last-Event-ID` | Lance é POST REST; só o servidor empurra; atravessa proxy; reconecta sozinho |
| API pública | **Cleveland Museum of Art Open Access** (CC0, sem chave), com catálogo offline embutido de 60 obras como último recurso | Licença livre, dados ricos (artista, data, técnica), sem chave; cache, retry e circuit breaker; nunca derruba o leilão |
| Deploy | **Render free (Docker) + Neon free (Postgres)** | Custo zero; Neon não expira em 30 dias |
| Anti-sniping | Lance nos últimos 2 min: novo fim = **instante do lance + 2 min** | Leilão clássico (soft close); documentar no README |
| Cancelamento | Permitido também com lances, **estornando o líder** automaticamente | Cobre o opcional; sem lance continua simples |

## Arquitetura (hexagonal, monorepo `api/` + `web/`)

Um único serviço no deploy: a API Express serve o build do React. Mesma origem, cookie `httpOnly`, sem CORS, um link só para o avaliador.

```
api/src/
  domain/         # Money, Lot, Bid, Wallet, BidPolicy, HashChain, PublicBidderRef, erros (zero framework)
  application/
    ports/        # LotRepository, WalletRepository, BidRepository, UnitOfWork, ItemCatalog, EventPublisher, Clock, Hasher
    usecases/     # PlaceBid, CreateLot, CancelLot, SettleLot, Deposit, AuditLot, GetReceipt, SearchCatalog...
  adapters/
    inbound/      # http (routes, middlewares, DTOs zod), sse, scheduler
    outbound/     # postgres (pg), catalog/cleveland (timeout, retry, circuit breaker, cache stale-if-error, offline), crypto, in-memory-events
  infrastructure/ # config (zod env), logger (pino + requestId), container (composição), server (boot e desligamento), scheduler
web/src/          # features/{auth,lots,live-room,wallet,wins,audit,seller}, components, hooks, theme
```

## Regras de negócio (todas com teste)

- **Dinheiro:** inteiro em centavos (`BIGINT`), nunca float.
- **Lance aceito se:** lote ao vivo (`start <= agora < end`), primeiro `>= inicial`, seguintes `>= atual + incremento`, bidder não é o líder, bidder não é o leiloeiro, cabe no disponível.
- **Carteira:** `disponível = total - comprometido`. Líder tem o valor comprometido; ao ser superado, o valor volta ao disponível **na mesma transação**. `CHECK (0 <= comprometido <= total)` no banco. Extrato (`wallet_ledger`) só de inserção.
- **Concorrência:** uma transação por lance: trava a linha do lote (`FOR UPDATE`), depois as carteiras (bidder e líder anterior) em ordem de id (sem deadlock). `Idempotency-Key` no lance evita duplo clique e retry de rede.
- **Relógio:** o servidor é a autoridade. O front recebe o `serverNow` e corrige o offset da contagem regressiva.
- **Encerramento (liquidação):** idempotente. Roda pelo scheduler **e** de forma preguiçosa em toda leitura/lance do lote, então o resultado fica correto mesmo se o Render free estiver dormindo. Debita vencedor, credita leiloeiro, emite comprovante. Sem lance: fecha sem vencedor.
- **Status:** `agendado → ao vivo → encerrado` ou `cancelado` (cancelado some da vitrine).
- **Privacidade:** licitante público = `Licitante #` + 8 hex de `HMAC(segredo, userId|lotId)`. Consistente dentro do lote, não correlacionável entre lotes, sem nome nem e-mail.

## Histórico à prova de adulteração (a técnica que vamos explicar)

1. Cada lance guarda `seq` contíguo (`UNIQUE(lot_id, seq)`), `prev_hash` e `hash = HMAC-SHA256(segredo, lot_id | seq | bidder | valor | instante | prev_hash)`. O gênesis usa os termos imutáveis do lote.
2. O lote guarda um **selo** (`head_seq`, `head_hash`, contagem) também com HMAC, atualizado na mesma transação.
3. **A chave fica fora do banco** (variável de ambiente). Quem só tem acesso ao banco não consegue recalcular a cadeia depois de editar.
4. A auditoria (pública) refaz a cadeia inteira e compara com o selo: detecta **edição** (hash não bate), **remoção no meio** (buraco de `seq` / `prev_hash`), **inserção** (sem a chave não há hash válido) e **divergência do selo**.
5. Defesa em profundidade: trigger no Postgres bloqueando `UPDATE`/`DELETE` em `bids`; conferência cruzada com o extrato da carteira (bloqueio sem lance correspondente).
6. O comprovante e a página de auditoria exibem o **hash final**; o comprovante fixa o resultado do lote encerrado. Cada hash também vai para o log estruturado (testemunha fora do banco).
7. **Limite honesto (vai no README):** num lote ainda ao vivo, quem tivesse o banco e reescrevesse também selo, extrato e logs, mas sem a chave, continua sem conseguir forjar HMAC; o resíduo é só truncar a cauda reescrevendo tudo de forma consistente com valores antigos, o que a conferência cruzada e o comprovante após o encerramento cobrem.

## API externa fora do ar

- Ao criar o lote, **copiamos o item** (título, artista, data, técnica, dimensões, URL da imagem, id e link de origem). Vitrine, sala, auditoria e comprovante **nunca** chamam a API.
- Só a **busca do leiloeiro** depende dela: timeout curto, 1 retry com jitter, circuit breaker, cache com `stale-if-error`. Falha vira `503 CATALOG_UNAVAILABLE` com mensagem clara (nunca 500) e o resto do app segue.
- Imagem quebrada: `onError` com placeholder no front.

## Segurança

Senha `argon2id`; sessão opaca no banco com cookie `httpOnly; Secure; SameSite=Lax` (revogável); proteção CSRF por cabeçalho customizado + SameSite; `helmet` + CSP; validação `zod` em toda borda; limites de corpo; **rate limit** em login, lance e depósito; autorização por papel e por dono (sem IDOR); erros sem vazar stack; PII fora de logs; segredos só por env.

## Testes

| Camada | O que cobre |
|---|---|
| Unitário (domínio) | política de lance, anti-sniping, carteira, cadeia de hash, ref pública, liquidação, dinheiro |
| Integração (Postgres real) | **N lances simultâneos** (um vencedor por rodada, invariantes da carteira), idempotência, liquidação repetida, adulteração por SQL direto (update/delete/insert/truncar), triggers |
| API (supertest) | contrato de erro, matriz de autorização, validação hostil (tipos, overflow, strings gigantes, unicode, injection), rate limit |
| Resiliência | API externa com timeout, 5xx, lenta, circuito aberto, cache velho; vitrine/auditoria continuam |
| Front (Vitest + RTL) | feedback de cada recusa, líder/superado, contagem regressiva, tema |
| E2E (Playwright, fumaça) | login, lance, superado, encerramento, auditoria |

Postgres real nos testes: `embedded-postgres` localmente (sem Docker, que não existe nesta máquina) e service container no GitHub Actions. O mesmo conjunto roda nos dois.

## Dados de teste (seed idempotente)

1 leiloeiro, 2 licitantes (R$ 60.000 cada) e **6 lotes em todos os estados**: ao vivo com lances (Ana lidera), ao vivo que fecha em poucas horas (Ana superada), ao vivo sem lances, agendado, encerrado vendido (com comprovante) e encerrado sem vencedor. Gravado pelos **mesmos casos de uso** do sistema (relógio deslocado para o passado), então cadeias de hash e comprovante são autênticos. Idempotente e retomável (chaves de idempotência, advisory lock entre instâncias). Seed no boot (`SEED_ON_BOOT`) e `npm run seed -w api`. Contas: `leiloeiro@demo.leilao`, `ana@demo.leilao`, `bruno@demo.leilao`; senha em `DEMO_PASSWORD` (padrão no `.env.example`, publicada no README de propósito).

## Entregáveis

`README.md` (passo a passo, variáveis, comportamentos inesperados, decisões, limites, texto da técnica anti-adulteração, uso de IA), `Dockerfile` multi-stage, `docker-compose.yml`, `render.yaml`, `.env.example`, CI no GitHub Actions, scripts `build`, `test`, `test:e2e`, `lint`, `seed`.

## Fases

1. **Fundação:** repo, TS strict, lint, CI, Dockerfile, compose, migrations, `/health`.
2. **Domínio com testes primeiro** (TDD): dinheiro, lance, carteira, cadeia de hash, ref pública.
3. **Persistência e casos de uso** + teste de concorrência e adulteração em Postgres real.
4. **HTTP:** auth, lotes, lances, SSE, catálogo AIC, scheduler, rate limit.
5. **Front:** vitrine, sala ao vivo, carteira, arremates, auditoria, painel do leiloeiro, dark mode.
6. **Blindagem:** matriz de autorização, fuzz, resiliência, a11y básico, revisão de logs.
7. **Deploy e entrega:** Render + Neon, seed em produção, teste manual ponta a ponta, README final, texto do formulário de IA.

## Comportamentos que vão no README (o enunciado exige citar)

Render free dorme após 15 min (primeiro acesso demora ~50 s; a liquidação preguiçosa cobre o intervalo); anti-sniping usa instante do lance + 2 min; lote cancelado com lances estorna o líder; depósito é simulado com teto por operação; imagens vêm do Cleveland Museum of Art e podem falhar (placeholder); SSE e quarentena de liquidação ficam na memória do processo (uma instância).
