# Casa de Leilões

Plataforma de leilões online. O **leiloeiro** monta lotes a partir dos itens de uma API pública de
obras de arte; os **licitantes** dão lances e acompanham a disputa ao vivo, com a regra de quem vence
no relógio decidida pelo servidor. Feito como resposta ao teste técnico Elite Dev da Verzel
(Desenvolvedor(a) Júnior Full Stack).

|                     |                                                                    |
| ------------------- | ------------------------------------------------------------------ |
| **Aplicação**       | `https://casa-de-leiloes-v0bc.onrender.com`                        |
| **Primeiro acesso** | Pode levar até ~50 s (plano gratuito do Render dorme após 15 min). |
| **Repositório**     | `https://github.com/Lucasvduda/casa-de-leiloes`                    |

## Contas de demonstração

Já existem no banco (seed) e aparecem num quadro na tela de login. A senha é pública de propósito:
quem avalia precisa entrar.

| Papel     | E-mail                  | Senha               | Saldo     |
| --------- | ----------------------- | ------------------- | --------- |
| Leiloeiro | `leiloeiro@demo.leilao` | `Demo-Leilao-2026!` | —         |
| Licitante | `ana@demo.leilao`       | `Demo-Leilao-2026!` | R$ 60.000 |
| Licitante | `bruno@demo.leilao`     | `Demo-Leilao-2026!` | R$ 60.000 |

Também é possível criar conta nova (leiloeiro ou licitante) em **Criar conta**.

**Roteiro de 2 minutos para ver o ao vivo:** abra duas janelas (uma anônima), entre como `ana` e como
`bruno`, abra o mesmo lote aberto e dê lances alternados. Cada janela vê o lance da outra sem recarregar,
e quem é superado recebe o aviso na hora. Depois abra **Histórico de lances** do lote.

## O que o sistema faz

Atende ao enunciado e acrescenta o que um leilão de verdade exigiria.

- **Leiloeiro** cria lotes escolhendo um item na busca do catálogo público (com foto), define lance
  inicial, incremento mínimo e duração. Pode cancelar um lote que **ainda não recebeu lances**.
- **Licitante** deposita saldo (dinheiro de mentira), vê os lotes ao vivo, agendados e encerrados,
  dá lances e acompanha **Meus lances** (com os lotes arrematados) e a carteira. Na sala do lote vê se
  está liderando ou foi superado e **em que posição está** ("Sua posição agora: 2º").
- **Ao vivo:** lances, tempo restante e encerramento chegam por _Server-Sent Events_. O relógio exibido
  é corrigido pelo horário do servidor (o relógio do navegador do usuário não decide nada).
- **Liquidação automática:** um agendador encerra lotes vencidos a cada 3 s, debita o vencedor,
  credita o leiloeiro e emite o comprovante.
- **Histórico de lances verificável:** qualquer pessoa, sem login, confere a integridade dos lances de um lote.
- **Seed:** 1 leiloeiro, 2 licitantes e **7 lotes** em todos os estados: 3 ao vivo (um com a Ana
  liderando, um que fecha em poucas horas, um sem lances), 1 agendado, 2 encerrados (um vendido, um sem
  lances) e 1 **cancelado** (só aparece no painel do leiloeiro, nunca na vitrine pública).

## Regras de negócio (e decisões que tomei onde o enunciado não definia)

| Tema                    | Regra                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dinheiro                | Inteiro em **centavos** do começo ao fim (nunca `float`). Valores em reais só na tela.                                                                                               |
| Lance mínimo            | Primeiro lance ≥ lance inicial; os seguintes ≥ lance atual + incremento mínimo.                                                                                                      |
| Quem pode dar lance     | Só licitante, em lote aberto e dentro do prazo, **nunca** no próprio lote nem sobre o próprio lance vencedor.                                                                        |
| Saldo                   | O valor do lance fica **reservado** (bloqueado) na carteira. Ao ser superado, o lance anterior é devolvido na mesma transação.                                                       |
| Anti-sniping            | Lance nos **últimos 2 minutos** estende o fim para _instante do lance + 2 min_. Evita o lance de última hora sem chance de resposta. **Não há teto de extensões** (veja os limites). |
| Cancelamento            | Conforme o enunciado, o leiloeiro só cancela lote **sem lances**: com lances a API responde `409 LOT_HAS_BIDS` e nada muda. Depois do prazo o lote é liquidado, não cancelado.       |
| Vitrine pública         | Mostra lotes ao vivo, agendados e encerrados. **Lote cancelado nunca aparece** na API pública (`phase=cancelled` responde 400); só o dono o vê, no painel.                           |
| Encerramento            | Lote sem lance encerra sem vencedor. Com lance, o líder vence, paga o valor do lance e o leiloeiro recebe.                                                                           |
| Limites                 | Depósito: até R$ 100.000 por vez. Saldo máximo: R$ 10.000.000. Duração do lote: 1 min a 30 dias.                                                                                     |
| Repetição de requisição | Lances e depósitos aceitam `Idempotency-Key`. O front envia uma chave por tentativa, então duplo clique ou nova tentativa por rede ruim **não duplica** o lance.                     |
| Concorrência            | Cada lote é serializado por `SELECT … FOR UPDATE`. Dois lances simultâneos nunca vencem os dois: um é aceito e o outro recebe "lance baixo demais".                                  |

> **Opção fora do padrão:** com `ALLOW_CANCEL_WITH_BIDS=true` o leiloeiro também cancela lote com
> lances, e o líder é **estornado** (o valor reservado volta ao saldo) na mesma transação. Vem
> **desligada**, porque o enunciado só prevê cancelamento sem lances. A tela segue a regra estrita
> (esconde o botão em lote com lances); a opção vale para a API.

## Arquitetura

Monorepo com dois pacotes (`npm workspaces`): `api` (Node + TypeScript + Express 5) e `web` (React).
Em produção as duas partes saem **da mesma imagem Docker e da mesma origem**: a API serve o front
compilado. Isso elimina CORS e deixa o cookie de sessão `httpOnly` funcionar como deve.

```
api/src
├── domain/            Regras puras, sem I/O: lance, carteira, dinheiro, cadeia de hash, comprovante
├── application/       Casos de uso (place-bid, settle-lot, cancel-lot...) e portas (interfaces)
├── adapters/
│   ├── inbound/http/  Express: rotas, middlewares (sessão, CSRF, rate limit), SSE, mapeamento de erros
│   └── outbound/      PostgreSQL (repositórios, unit of work), catálogo externo, hash de senha
└── infrastructure/    Configuração (zod), container de dependências, servidor, agendador, logger

web/src
├── features/          auth, lots (vitrine, sala ao vivo), wallet, seller, audit, receipts
├── components/        Interface reutilizável (Card, Alert, TextField...)
└── lib/               Cliente HTTP, formatação de dinheiro e data, SSE
```

**Arquitetura hexagonal.** O domínio não importa nada de Express, `pg` ou do catálogo externo. Os casos
de uso falam com _portas_; os adaptadores implementam essas portas. Por isso os testes de domínio e de
caso de uso rodam em memória, e os de integração rodam contra PostgreSQL de verdade.

### Stack

| Camada    | Tecnologia                                                                                |
| --------- | ----------------------------------------------------------------------------------------- |
| Back-end  | Node 22, TypeScript (strict), Express 5, `pg`, `zod`, `pino`, `helmet`, `@node-rs/argon2` |
| Banco     | PostgreSQL 16 (Neon em produção), migrações SQL versionadas e aplicadas no boot           |
| Front-end | React 19, Vite, TypeScript (strict), React Router 7, TanStack Query 5, Tailwind CSS 4     |
| Testes    | Vitest, Testing Library, PostgreSQL embutido (testes de integração), Playwright (e2e)     |
| Entrega   | Docker (multi-stage), GitHub Actions, Render (aplicação) e Neon (banco)                   |

### Rotas da API

Lista fechada (qualquer outra rota responde 404 no formato padrão de erro).

| Método | Rota                                                                        | Acesso                             |
| ------ | --------------------------------------------------------------------------- | ---------------------------------- |
| GET    | `/health`, `/ready`                                                         | Público (`/ready` confere o banco) |
| POST   | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`                 | Público / sessão                   |
| GET    | `/api/auth/me`                                                              | Sessão (anônimo recebe 401)        |
| GET    | `/api/lots`, `/api/lots/:id`, `/api/lots/:id/audit`, `/api/lots/:id/events` | Público                            |
| GET    | `/api/catalog/search`                                                       | Leiloeiro                          |
| POST   | `/api/lots`, `/api/lots/:id/cancel`                                         | Leiloeiro (dono do lote)           |
| POST   | `/api/lots/:id/bids`                                                        | Licitante                          |
| GET    | `/api/wallet`, `/api/me/bids`, `/api/me/wins`, `/api/me/lots`               | Sessão                             |
| POST   | `/api/wallet/deposits`                                                      | Licitante                          |
| GET    | `/api/receipts/:code`                                                       | Público (o código é o segredo)     |

Erros sempre seguem `{ "error": { "code", "message", "requestId", "details?" } }`.

`GET /api/lots` aceita `phase` (`live`, `scheduled`, `finished`, `all`), `q`, `sort`, `page` e `pageSize`.
`all` significa "tudo menos cancelados". Valor de dinheiro é sempre em **centavos** (`250000` = R$ 2.500,00).

### Testando a API sem o front (curl ou Postman)

As escritas (`POST`) exigem **cookie de sessão**, o cabeçalho **`X-CSRF-Token`** (devolvido no login) e
`Content-Type: application/json`. Sem eles a resposta é `403` (`CSRF_INVALID`) ou `415`, de propósito.

```bash
BASE=https://casa-de-leiloes-v0bc.onrender.com

# 1. Login: guarda o cookie em jar.txt e devolve o csrfToken no corpo
curl -s -c jar.txt -H 'Content-Type: application/json' \
  -d '{"email":"ana@demo.leilao","password":"Demo-Leilao-2026!"}' $BASE/api/auth/login

# 2. Escolha um lote ao vivo (público, sem login)
curl -s "$BASE/api/lots?phase=live"

# 3. Dê um lance de R$ 2.500,00 (centavos). Troque TOKEN e LOT_ID.
curl -s -b jar.txt -H "X-CSRF-Token: TOKEN" -H 'Idempotency-Key: meu-lance-0001' \
  -H 'Content-Type: application/json' -d '{"amount":250000}' $BASE/api/lots/LOT_ID/bids

# 4. Acompanhe ao vivo (SSE) e confira a integridade do histórico
curl -N $BASE/api/lots/LOT_ID/events
curl -s $BASE/api/lots/LOT_ID/audit
```

Repetir o passo 3 com a **mesma** `Idempotency-Key` devolve o mesmo resultado (`"replayed": true`) sem
dar outro lance. Em `http://localhost` (Docker Compose) o cookie não é `Secure`, então o `curl` funciona igual.

## Como rodar

### Opção 1: Docker Compose (mais simples)

Pré-requisito: Docker. Sobe o PostgreSQL e a aplicação exatamente como em produção.

```bash
docker compose up --build
```

Abra <http://localhost:3000> e use as contas de demonstração. O compose já define
`COOKIE_SECURE=false` porque `localhost` não tem HTTPS.

### Opção 2: desenvolvimento local

Pré-requisitos: Node 22 ou superior e um PostgreSQL 16 com banco UTF8 (o app recusa subir em outra codificação).

```bash
npm ci
docker compose up db -d          # ou use qualquer Postgres e ajuste DATABASE_URL
cp .env.example .env             # no PowerShell: Copy-Item .env.example .env
npm run dev -w api               # API em http://localhost:3000 (recarrega ao salvar)
npm run dev -w web               # front em http://localhost:5173 (proxy de /api para a API)
```

Abra <http://localhost:5173>. As migrações e o seed rodam sozinhos no boot (`SEED_ON_BOOT=true`).
Para rodar o seed à mão: `npm run seed -w api`. Ele é idempotente: não duplica nada.

### Variáveis de ambiente

Todas são validadas no boot com `zod`. Configuração inválida impede a subida com mensagem clara.

| Variável                 | Padrão                           | Para quê                                                            |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`           | — (obrigatória em produção)      | String de conexão do PostgreSQL                                     |
| `INTEGRITY_SECRET`       | — (obrigatória, ≥ 32 caracteres) | Chave HMAC que sela o histórico de lances. **Fica fora do banco.**  |
| `NODE_ENV`               | `development`                    | `production` liga cookie `Secure` + prefixo `__Host-`               |
| `PORT`                   | `3000`                           | Porta HTTP (no Render vem de `$PORT`)                               |
| `SEED_ON_BOOT`           | `false`                          | Cria os dados de demonstração se ainda não existirem                |
| `DEMO_PASSWORD`          | `Demo-Leilao-2026!`              | Senha das 3 contas de demonstração                                  |
| `DB_POOL_MAX`            | `10`                             | Conexões do pool (2 a 50)                                           |
| `WEB_DIST_DIR`           | —                                | Pasta do build do front. Se definida, a API o serve na mesma origem |
| `COOKIE_SECURE`          | `true` em produção               | `false` apenas para rodar a imagem em `http://localhost`            |
| `ALLOW_CANCEL_WITH_BIDS` | `false`                          | `true` permite cancelar lote com lances (estorna o líder)           |
| `TRUST_PROXY_HOPS`       | `1`                              | Proxies confiáveis na frente do app (define o IP real dos limites)  |
| `LOG_LEVEL`              | `info`                           | Nível do log (`pino`)                                               |
| `VITE_SHOW_DEMO_HINT`    | `true`                           | **Compilação do front.** `false` esconde o quadro de contas demo    |
| `VITE_DEMO_PASSWORD`     | —                                | **Compilação do front.** Igual a `DEMO_PASSWORD` se você a trocou   |

As duas variáveis `VITE_*` são lidas na **compilação** (no Docker, via `--build-arg`).

## Testes

```bash
npm run lint && npm run typecheck     # ESLint e tsc em modo estrito, API e web
npm test                              # unitários da API + testes do front
npm run test:int -w api               # integração da API (PostgreSQL embutido, sem Docker)
npm run build && npm run e2e          # ponta a ponta com navegador real contra o build de produção
npm run mutation -w web               # teste de mutação do front
```

Resultado atual: **401 testes unitários** e **575 de integração** na API, **275** no front,
**18 verificações e2e** com navegador. Em vez de só medir cobertura, usei:

- **Teste de mutação** (`npm run mutation -w web`): quebro o código de propósito (por exemplo, trocar
  `>=` por `>` na regra de lance mínimo) e confirmo que algum teste falha. No front, 30 de 30 mutações
  foram detectadas.
- **Concorrência real:** dezenas de lances simultâneos no mesmo lote contra PostgreSQL de verdade,
  conferindo que a soma das carteiras nunca muda (dinheiro não nasce nem some).
- **Matriz de autorização:** cada rota × cada papel (anônimo, licitante, leiloeiro, dono e não dono).
- **Fuzz HTTP:** entradas hostis em todas as rotas (Unicode inválido, NUL, números gigantes,
  cabeçalhos quebrados). Achou um bug real (e-mail com `\u0000` virava HTTP 500), já corrigido.
  Reproduzível com `FUZZ_SEED` e `FUZZ_ITERATIONS`.
- **Resiliência:** derruba conexões do banco sob carga, segura travas e esgota o pool. O sistema
  responde `503` com `Retry-After`, não derruba o processo e se recupera sozinho.
- **Segurança de log:** comprovantes e parâmetros de busca nunca aparecem nos logs.

O e2e não roda no CI porque usa o Edge instalado na máquina (`E2E_BROWSER_PATH` troca o navegador).
O CI roda lint, tipos, build, todos os testes e constrói a imagem Docker.

## Histórico dos lances à prova de adulteração

Cada lance guarda o `hash` do anterior (uma cadeia, como num _blockchain_ simplificado) calculado com
**HMAC-SHA-256** e uma chave que **não está no banco**. O lote também guarda um **selo** (seq., hash
da ponta e HMAC dos dois), atualizado na mesma transação de cada lance. A tela
**Histórico de lances** (e `GET /api/lots/:id/audit`) refaz a cadeia inteira e acusa
lance alterado, removido, inserido, reordenado ou selo editado. _Triggers_ no banco proíbem `UPDATE`, `DELETE` e `TRUNCATE` em lances e no extrato da carteira (impedem acidente ou adulteração casual; um superusuário pode desligá-los). Mesmo assim, quem alterar o banco à mão não consegue refazer os hashes sem a chave, e a verificação acusa a mudança.

O comprovante de arrematação também é assinado com a chave, e conferido com o histórico do lote.

**Limites honestos desta proteção** (ela detecta adulteração do histórico, não é um cartório):

- O hash inicial cobre lote, leiloeiro, lance inicial e incremento. O selo **não cobre** título, item,
  `ends_at` nem `status` do lote. Quem editar essas colunas direto no banco (desligando antes o
  _trigger_, o que exige superusuário) não é detectado pela auditoria. A **carteira** tem
  outras travas: o extrato é só de inclusão (_trigger_) e o saldo tem restrições no banco.
- **Reversão ao estado antigo:** quem tiver acesso ao banco pode restaurar uma versão antiga do selo
  do lote e apagar os lances posteriores, e a cadeia restante continua válida. O extrato da carteira
  denuncia o caso quando sobra valor reservado sem lance correspondente, mas não sempre. A mitigação
  é o **selo final** que a tela de auditoria mostra (e permite copiar): quem anotou o valor de antes
  percebe a volta.
- **A verificação pública não é independente.** Os hashes são HMAC, então só o servidor, que tem a
  chave, consegue recalculá-los. Uma cadeia SHA-256 aberta (verificável no navegador) com o selo HMAC
  só na ponta seria o próximo passo.
- **A chave não tem versão.** Trocar `INTEGRITY_SECRET` faz todos os lotes já gravados falharem na
  verificação (lances e liquidação são recusados). Por isso o `render.yaml` gera a chave uma única vez.
  Um `keyId` no selo permitiria rotacionar sem perder o histórico.

## Privacidade

O leiloeiro e os demais licitantes veem os lances como **"Licitante #código"**, um código derivado por
HMAC e diferente em cada lote (ninguém liga o mesmo licitante entre lotes). O nome do licitante nunca sai
da própria conta. O nome do leiloeiro é público (é a "casa" do lote).

## Segurança

- Senhas com **argon2id**. Sessão em cookie `httpOnly`, `SameSite=Lax`, `Secure` e prefixo `__Host-` em produção.
- Defesa contra **CSRF** em camadas: `Sec-Fetch-Site`, `Origin`, `Content-Type: application/json` obrigatório e cabeçalho `X-CSRF-Token`.
- **Rate limit** por rota (por exemplo, 60 lances/min e 8 falhas de login por conta em 15 min), com `Retry-After`.
- Validação de toda entrada com `zod`; SQL só parametrizado; `helmet` com CSP restritiva.
- Mensagens de erro iguais para "e-mail inexistente" e "senha errada"; sem enumeração de contas no login.
- Erros internos nunca vazam detalhe: o usuário recebe um `requestId` e o log guarda a causa.
- Contêiner roda como usuário `node` (não root), com `HEALTHCHECK`.

## Catálogo externo

Os itens vêm da API aberta do **Cleveland Museum of Art**. Se ela cair, demorar ou mudar o formato, a busca
**degrada para um catálogo local de 60 itens** e a tela avisa que está no modo reduzido. Criar lote
continua funcionando.

## Deploy (Render + Neon)

Escolhi o plano gratuito de ambos. O Postgres gratuito do Render expira em 30 dias, por isso o banco é o Neon.

1. **Neon:** crie um projeto (região AWS us-east-2, banco `UTF8`). Copie a string de conexão
   **direta**, sem `-pooler`, terminando em `?sslmode=require`. O app usa transações e travas por linha,
   que não combinam com o pooler em modo _transaction_.
2. **GitHub:** publique o repositório.
3. **Render:** _New → Blueprint_ e aponte para o repositório. O `render.yaml` cria o serviço Docker.
   Cole a `DATABASE_URL` do Neon quando o painel pedir. O `INTEGRITY_SECRET` é gerado pelo Render e
   mantido entre os deploys.
4. Quando estiver no ar, confira `https://casa-de-leiloes-v0bc.onrender.com/ready` e entre com uma conta demo.
5. Nos logs do Render, procure `proxy_probe`: o campo `ip` deve ser o do visitante, não o de um proxy
   (se for sempre o mesmo, aumente `TRUST_PROXY_HOPS`).

O health check do Render usa `/health` (não toca no banco, para não acordar o Neon à toa).

## Comportamentos inesperados e limites conhecidos

Listados para ninguém ser surpreendido:

- **Primeiro acesso lento (~50 s).** O plano gratuito do Render dorme após 15 min sem tráfego, e o
  Neon também pausa. A primeira requisição acorda os dois.
- **Instância única.** O _hub_ de SSE e a fila de "quarentena" de liquidações com falha ficam em memória do
  processo. Escalar para várias instâncias exigiria Redis (ou `LISTEN/NOTIFY`) para o SSE. A
  consistência do dinheiro **não** depende disso (ela está no banco).
- **Reinício derruba as conexões SSE.** O navegador reconecta sozinho e busca o estado atual.
- **Seed roda uma única vez.** Se você apagar uma conta demo, ela não é recriada; reiniciar não duplica.
- **Criar lote não usa `Idempotency-Key`.** Um duplo clique rápido é bloqueado no front, mas uma
  repetição de rede pode criar dois lotes iguais (sem prejuízo financeiro; o leiloeiro cancela um).
- **Banco indisponível:** a API responde `503 TEMPORARILY_UNAVAILABLE` com `Retry-After`, e o front mostra
  um aviso amigável em vez de erro técnico.
- **Anti-sniping sem teto.** Cada lance nos últimos 2 minutos estende o prazo, e não há limite de
  extensões: dois licitantes que se cobrem sem parar mantêm o lote aberto. É o comportamento esperado
  de um leilão "de vela"; um teto (por exemplo, 10 extensões) seria uma mudança de uma linha.
- **Histórico adulterado em lote vencido.** A liquidação se recusa a fechar um lote cuja cadeia não
  confere (para não pagar com base em dados suspeitos). A sala mostra "Encerrando, confirmando o
  resultado…" e, passado 1 minuto, troca o aviso por **"Resultado em verificação"** com o link da
  auditoria e passa a consultar a cada 15 s em vez de 2,5 s. O saldo de ninguém muda enquanto isso.
- **Fim de lote com muita gente na sala.** Todas as salas pedem o resultado ao mesmo tempo quando o
  prazo acaba. Cada navegador espera um tempo aleatório (até 1,5 s) e, no servidor, pedidos do mesmo
  lote viram **uma única liquidação** por processo, para não ocupar o pool de conexões. A segurança
  contra duas liquidações continua sendo o `FOR UPDATE` e o estado do lote no banco.
- **Item fora do catálogo local.** Se a API do museu estiver fora do ar e o item não estiver no cache
  nem nos 60 itens locais, só **criar lote com esse item** falha (503). Vitrine, sala, auditoria e
  comprovante nunca dependem da API externa (o lote guarda uma cópia do item).
- **IP dos limites de requisição.** O app confia em 1 proxy (`TRUST_PROXY_HOPS=1`, o caso do Render). Se
  houver mais de um salto, todos os visitantes pareceriam o mesmo IP e dividiriam os limites. Depois
  do deploy, olhe nos logs a linha `proxy_probe` (campos `ip` e `forwardedFor`) e ajuste o número.
- **Dinheiro é fictício.** Depósito não passa por pagamento real.
- **E2E fora do CI** (depende do Edge local).
- **Imagens do catálogo** vêm do museu. Se o servidor deles falhar, o card mostra um substituto.

## Uso de IA

Usei IA generativa (assistente de código) ao longo do projeto, do jeito que um engenheiro usa uma
calculadora: ela acelera a conta, mas **quem sabe qual conta fazer sou eu**. Não entreguei nada que eu
não consiga explicar linha a linha.

**O que eu decidi e conduzi:** a leitura do enunciado, a arquitetura hexagonal, o dinheiro em centavos,
a cadeia de hash do histórico, o escopo, os limites de segurança e a estratégia de deploy.

**Três decisões minhas, com o porquê (as que mais pesaram):**

1. **Ordem de travas contra _deadlock_.** Um lance mexe no lote e em duas carteiras (a de quem lidera
   e a de quem foi superado). Decidi que a ordem é sempre **lote primeiro, depois carteiras por `id`
   crescente**. Com a ordem fixa, duas transações cruzadas nunca esperam uma pela outra. O teste de
   concorrência dispara dezenas de lances simultâneos e confere que o saldo reservado fecha ao centavo.
2. **Semântica do anti-sniping.** O intervalo do lote é `[início, fim)`. Um lance dentro dos últimos
   2 minutos move o fim para **o instante do lance + 2 minutos** (não "fim + 2 minutos"), e a decisão
   usa o relógio do servidor, nunca o do navegador. Optei por não ter teto de extensões e deixei isso
   dito nos limites conhecidos, porque é uma regra de negócio que o cliente deve poder mudar.
3. **Bug que o fuzz pegou: `\u0000` no e-mail.** Um e-mail com o caractere nulo passava na validação e
   o PostgreSQL recusava com erro 500. Corrigi na borda (validação recusa caracteres de controle,
   resposta 400) e deixei um teste de regressão. Foi o fuzz, e não a minha revisão, que achou. Por
   isso eu o mantenho na suíte.

**Onde a IA ajudou:** escrever código repetitivo mais rápido, sugerir casos de teste e montar o esqueleto
dos arquivos que eu já tinha desenhado. **Onde eu revisei e mudei de rumo:** numa revisão crítica do
projeto, decidi que cancelar lote com lances (e estornar o líder) era arriscado para um leilão
auditável. O padrão passou a ser cancelar **só sem lances** (409 `LOT_HAS_BIDS`), e o estorno ficou
atrás da variável `ALLOW_CANCEL_WITH_BIDS`.

**Como garanti que o resultado é confiável:** não confio em "parece certo". Há testes unitários, de
integração com banco real, de concorrência, de mutação, fuzz, resiliência e e2e com navegador. Eles
descobriram bugs reais (que corrigi) e provam que o código se sustenta sem depender da minha palavra,
nem da do assistente.
