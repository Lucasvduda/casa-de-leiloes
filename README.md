# Casa de Leilões

Plataforma de leilões online. O **leiloeiro** monta lotes a partir dos itens de uma API pública de
obras de arte; os **licitantes** dão lances e acompanham a disputa ao vivo, com a regra de quem vence
no relógio decidida pelo servidor. Feito como resposta ao teste técnico Elite Dev da Verzel
(Desenvolvedor(a) Júnior Full Stack).

|                     |                                                                    |
| ------------------- | ------------------------------------------------------------------ |
| **Aplicação**       | `https://<preencher-apos-o-deploy>.onrender.com`                   |
| **Primeiro acesso** | Pode levar até ~50 s (plano gratuito do Render dorme após 15 min). |
| **Repositório**     | `https://github.com/<usuario>/<repositorio>`                       |

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
  inicial, incremento mínimo e duração. Pode cancelar o lote (veja as regras abaixo).
- **Licitante** deposita saldo (dinheiro de mentira), vê lotes abertos, encerrados e cancelados, dá
  lances e acompanha **Meus lances** (com os lotes arrematados) e a carteira.
- **Ao vivo:** lances, tempo restante e encerramento chegam por _Server-Sent Events_. O relógio exibido
  é corrigido pelo horário do servidor (o relógio do navegador do usuário não decide nada).
- **Liquidação automática:** um agendador encerra lotes vencidos a cada 3 s, debita o vencedor,
  credita o leiloeiro e emite o comprovante.
- **Histórico de lances verificável:** qualquer pessoa, sem login, confere a integridade dos lances de um lote.
- **Seed:** 1 leiloeiro, 2 licitantes e 6 lotes em todos os estados (aberto com lances, aberto sem
  lances, no fim, encerrado com vencedor, encerrado sem lances, cancelado).

## Regras de negócio (e decisões que tomei onde o enunciado não definia)

| Tema                    | Regra                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro                | Inteiro em **centavos** do começo ao fim (nunca `float`). Valores em reais só na tela.                                                                           |
| Lance mínimo            | Primeiro lance ≥ lance inicial; os seguintes ≥ lance atual + incremento mínimo.                                                                                  |
| Quem pode dar lance     | Só licitante, em lote aberto e dentro do prazo, **nunca** no próprio lote nem sobre o próprio lance vencedor.                                                    |
| Saldo                   | O valor do lance fica **reservado** (bloqueado) na carteira. Ao ser superado, o lance anterior é devolvido na mesma transação.                                   |
| Anti-sniping            | Lance nos **últimos 2 minutos** estende o fim para _instante do lance + 2 min_. Evita o lance de última hora sem chance de resposta.                             |
| Cancelamento            | O leiloeiro só cancela lote **aberto**. Se já houver lances, o líder é **reembolsado** e o histórico é preservado.                                               |
| Encerramento            | Lote sem lance encerra sem vencedor. Com lance, o líder vence, paga o valor do lance e o leiloeiro recebe.                                                       |
| Limites                 | Depósito: até R$ 100.000 por vez. Saldo máximo: R$ 10.000.000. Duração do lote: 1 min a 30 dias.                                                                 |
| Repetição de requisição | Lances e depósitos aceitam `Idempotency-Key`. O front envia uma chave por tentativa, então duplo clique ou nova tentativa por rede ruim **não duplica** o lance. |
| Concorrência            | Cada lote é serializado por `SELECT … FOR UPDATE`. Dois lances simultâneos nunca vencem os dois: um é aceito e o outro recebe "lance baixo demais".              |

> **Atenção, comportamento que difere do enunciado:** o enunciado fala em cancelar apenas lote "sem
> lances". Aqui o cancelamento com lances é permitido e **devolve o saldo ao líder**, decisão confirmada
> por mim porque trancar o leiloeiro e o licitante num lote parado seria pior. Se a regra estrita for
> desejada, basta uma linha em `api/src/application/usecases/cancel-lot.ts`.

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

| Variável              | Padrão                           | Para quê                                                            |
| --------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`        | — (obrigatória em produção)      | String de conexão do PostgreSQL                                     |
| `INTEGRITY_SECRET`    | — (obrigatória, ≥ 32 caracteres) | Chave HMAC que sela o histórico de lances. **Fica fora do banco.**  |
| `NODE_ENV`            | `development`                    | `production` liga cookie `Secure` + prefixo `__Host-`               |
| `PORT`                | `3000`                           | Porta HTTP (no Render vem de `$PORT`)                               |
| `SEED_ON_BOOT`        | `false`                          | Cria os dados de demonstração se ainda não existirem                |
| `DEMO_PASSWORD`       | `Demo-Leilao-2026!`              | Senha das 3 contas de demonstração                                  |
| `DB_POOL_MAX`         | `10`                             | Conexões do pool (2 a 50)                                           |
| `WEB_DIST_DIR`        | —                                | Pasta do build do front. Se definida, a API o serve na mesma origem |
| `COOKIE_SECURE`       | `true` em produção               | `false` apenas para rodar a imagem em `http://localhost`            |
| `LOG_LEVEL`           | `info`                           | Nível do log (`pino`)                                               |
| `VITE_SHOW_DEMO_HINT` | `true`                           | **Compilação do front.** `false` esconde o quadro de contas demo    |
| `VITE_DEMO_PASSWORD`  | —                                | **Compilação do front.** Igual a `DEMO_PASSWORD` se você a trocou   |

As duas variáveis `VITE_*` são lidas na **compilação** (no Docker, via `--build-arg`).

## Testes

```bash
npm run lint && npm run typecheck     # ESLint e tsc em modo estrito, API e web
npm test                              # unitários da API + testes do front
npm run test:int -w api               # integração da API (PostgreSQL embutido, sem Docker)
npm run build && npm run e2e          # ponta a ponta com navegador real contra o build de produção
npm run mutation -w web               # teste de mutação do front
```

Resultado atual: **400 testes unitários** e **563 de integração** na API, **267** no front,
**16 verificações e2e** com navegador. Em vez de só medir cobertura, usei:

- **Teste de mutação** (`npm run mutation -w web`): quebro o código de propósito (por exemplo, trocar
  `>=` por `>` na regra de lance mínimo) e confirmo que algum teste falha. No front, 26 de 26 mutações
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

**Limite honesto:** o hash inicial cobre lote, leiloeiro, lance inicial e incremento. Ele **não cobre**
título, item, início e fim do lote. Quem tem a chave e acesso ao banco consegue reescrever tudo (a chave
é o segredo; ela não é rotacionável sem perder a verificação dos lotes antigos).

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
4. Quando estiver no ar, confira `https://<seu-app>.onrender.com/ready` e entre com uma conta demo.

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
- **Cancelar lote com lances reembolsa o líder** (difere do enunciado, veja acima).
- **Dinheiro é fictício.** Depósito não passa por pagamento real.
- **E2E fora do CI** (depende do Edge local).
- **Imagens do catálogo** vêm do museu. Se o servidor deles falhar, o card mostra um substituto.

## Uso de IA

Usei IA generativa (assistente de código) como ferramenta ao longo do projeto, do jeito que um
engenheiro usa uma calculadora: ela acelera a conta, mas **quem sabe qual conta fazer sou eu**.

**O que eu decidi e conduzi:** a leitura do enunciado, a arquitetura hexagonal, o modelo de dinheiro em
centavos, a regra de concorrência (trava por lote), o anti-sniping, o reembolso no cancelamento, a
cadeia de hash do histórico, o que entra ou não no escopo, os limites de segurança e a estratégia de
deploy. Revisei cada trecho gerado, pedi mudanças, rejeitei o que não servia e corrigi o que errou.

**Onde a IA ajudou:** escrever código repetitivo mais rápido, sugerir casos de teste e montar o
esqueleto de arquivos que eu já tinha desenhado.

**Como garanti que o resultado é confiável:** não confio em "parece certo". Há testes unitários,
de integração com banco real, de concorrência, de mutação, fuzz, resiliência e e2e com navegador. Eles
descobriram bugs reais (que corrigi) e provam que o código se sustenta sem depender da minha palavra,
nem da do assistente.
